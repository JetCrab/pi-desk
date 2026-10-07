import 'server-only'
import { L4_PROJECT_TEXT_FILE_MAX_BYTES } from '@common/l4_foundation/file/l4-project-file-contract'
import {
  L4GitOidSchema,
  L4GitRevisionSchema,
  type L4GitCommit,
  type L4GitHistoricalDiff,
  type L4GitPreviewDiff
} from '@common/l4_foundation/git/l4-git-history-contract'
import { L4WorkSessionGitError } from './l4-git-error'
import { executeGitText, executeGitBuffer } from './l4-git-command'
import { decodeGitDiffText } from './l4-git-diff-text'

export const COMMIT_FORMAT = '%H%x00%P%x00%an%x00%ct%x00%D%x00%s'

export async function readGitText(repository: string, args: readonly string[]): Promise<string> {
  const result = await executeGitText(repository, args)
  if (result.code !== 0) {
    throw new L4WorkSessionGitError(
      'read-failed',
      `读取 Git 失败：${result.stderr.trim().slice(0, 1200)}`
    )
  }
  return result.stdout
}

export async function resolveCommit(repository: string, revision: string): Promise<string | null> {
  L4GitRevisionSchema.parse(revision)
  if (revision.startsWith('refs/')) {
    const format = await executeGitText(repository, ['check-ref-format', revision])
    if (format.code !== 0) throw new L4WorkSessionGitError('invalid-ref', 'Git 引用名称无效')
  }
  const result = await executeGitText(repository, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${revision}^{commit}`
  ])
  if (result.code === 0) return L4GitOidSchema.parse(result.stdout.trim())
  if (revision === 'HEAD') {
    const symbolic = await executeGitText(repository, ['symbolic-ref', '-q', 'HEAD'])
    if (symbolic.code === 0) {
      const exists = await executeGitText(repository, [
        'show-ref',
        '--verify',
        '--quiet',
        symbolic.stdout.trim()
      ])
      if (exists.code === 1) return null
    }
  }
  throw new L4WorkSessionGitError('invalid-ref', `Git 版本不存在或对象不可读：${revision}`)
}

export function parseCommit(fields: readonly string[]): L4GitCommit {
  if (fields.length !== 6 || !Number.isFinite(Number(fields[3]))) {
    throw new L4WorkSessionGitError('read-failed', 'Git 提交记录格式无效')
  }
  return {
    oid: L4GitOidSchema.parse(fields[0]),
    parents: fields[1] ? fields[1].split(' ').map((oid) => L4GitOidSchema.parse(oid)) : [],
    author: fields[2]!,
    timestampMs: Number(fields[3]) * 1000,
    refs: fields[4] ? fields[4].split(', ') : [],
    subject: fields[5]!
  }
}

export async function readCommit(
  repository: string,
  oid: string
): Promise<L4GitCommit & { message: string }> {
  const output = await readGitText(repository, [
    'show',
    '-s',
    '--no-show-signature',
    '--decorate=short',
    `--format=${COMMIT_FORMAT}%x00%B`,
    oid,
    '--'
  ])
  const fields = output.split('\0')
  if (fields.length !== 7) throw new L4WorkSessionGitError('read-failed', 'Git 提交详情格式无效')
  return { ...parseCommit(fields.slice(0, 6)), message: fields[6]!.trimEnd() }
}

interface TreeFile {
  mode: string
  type: string
  oid: string
}
async function treeFile(
  repository: string,
  commit: string | null,
  path: string
): Promise<TreeFile | null> {
  if (!commit) return null
  const output = await readGitText(repository, [
    '--literal-pathspecs',
    'ls-tree',
    '-z',
    commit,
    '--',
    path
  ])
  if (!output) return null
  const record = output.split('\0').find((item) => item.slice(item.indexOf('\t') + 1) === path)
  if (!record) return null
  const [mode, type, oid] = record.slice(0, record.indexOf('\t')).split(' ')
  if (!mode || !type || !oid) throw new L4WorkSessionGitError('read-failed', 'Git 树对象格式无效')
  return { mode, type, oid: L4GitOidSchema.parse(oid) }
}

type BlobContent = { kind: 'text'; content: string } | { kind: 'too_large' | 'binary' }
async function blob(repository: string, file: TreeFile | null): Promise<BlobContent> {
  if (!file) return { kind: 'text', content: '' }
  const size = Number((await readGitText(repository, ['cat-file', '-s', file.oid])).trim())
  if (!Number.isSafeInteger(size) || size < 0)
    throw new L4WorkSessionGitError('read-failed', 'Git 文件大小无效')
  if (size > L4_PROJECT_TEXT_FILE_MAX_BYTES) return { kind: 'too_large' }
  const result = await executeGitBuffer(repository, ['cat-file', 'blob', file.oid])
  if (result.code !== 0) throw new L4WorkSessionGitError('read-failed', 'Git 文件对象不可读')
  if (result.stdout.length > L4_PROJECT_TEXT_FILE_MAX_BYTES) return { kind: 'too_large' }
  const content = decodeGitDiffText(result.stdout)
  return content === null ? { kind: 'binary' } : { kind: 'text', content }
}

export async function readHistoricalDiff(
  repository: string,
  path: string,
  comparison: L4GitHistoricalDiff
): Promise<L4GitPreviewDiff> {
  // 先确认提交存在，再区分树中缺文件；缺对象不能伪装成新增/删除。
  await resolveCommit(repository, comparison.targetCommit)
  if (comparison.baseCommit) await resolveCommit(repository, comparison.baseCommit)
  const originalPath = comparison.oldPath ?? path
  const [original, modified] = await Promise.all([
    treeFile(repository, comparison.baseCommit, originalPath),
    treeFile(repository, comparison.targetCommit, path)
  ])
  if (!original && !modified)
    throw new L4WorkSessionGitError('invalid-ref', '文件不在指定的任一版本中')
  if (
    (original && original.type !== 'blob') ||
    (modified && modified.type !== 'blob') ||
    (original && modified && original.mode.slice(0, 3) !== modified.mode.slice(0, 3))
  ) {
    const describe = (file: TreeFile | null): string =>
      file ? `${file.type} · ${file.mode}\n${file.oid}` : '不存在'
    return { kind: 'metadata', original: describe(original), modified: describe(modified) }
  }
  const [left, right] = await Promise.all([blob(repository, original), blob(repository, modified)])
  if (left.kind === 'too_large' || right.kind === 'too_large') return { kind: 'too_large' }
  if (left.kind !== 'text' || right.kind !== 'text') return { kind: 'binary' }
  return {
    kind: 'text',
    original: { path: originalPath, content: left.content },
    modified: { path, content: right.content }
  }
}
