import 'server-only'
import { L4ProjectFilePathSchema } from '@common/l4_foundation/file/l4-project-file-contract'
import {
  type L4GitLogQuery,
  type L4GitLog,
  type L4GitChangesQuery,
  type L4GitChanges,
  type L4GitReadBranches,
  type L4GitHistoricalDiff,
  type L4GitPreviewDiff,
  type L4GitCommit
} from '@common/l4_foundation/git/l4-git-history-contract'
import {
  resolveL4GitRepository,
  listL4WorkSessionGitBranches,
  getL4WorkSessionGitDiff
} from './l4-work-session-git'
import { executeGitText } from './internal/l4-git-command'
import { L4WorkSessionGitError } from './internal/l4-git-error'
import {
  COMMIT_FORMAT,
  readGitText,
  parseCommit,
  resolveCommit,
  readCommit,
  readHistoricalDiff
} from './internal/l4-git-revision'

const LOG_SCAN_LIMIT = 20_000
const CHANGE_LIMIT = 50_000

export async function listL4ProjectGitLog(
  cwd: string,
  root: string,
  input: L4GitLogQuery
): Promise<L4GitLog> {
  const repository = await resolveL4GitRepository(cwd, root)
  const tip = await resolveCommit(repository, input.tip)
  const exclude = input.exclude ? await resolveCommit(repository, input.exclude) : null
  if (!tip) return { tip, exclude, items: [], hasMore: false, truncated: false }
  const output = await readGitText(repository, [
    'log',
    '-z',
    '--topo-order',
    '--no-show-signature',
    '--decorate=short',
    `--max-count=${LOG_SCAN_LIMIT + 1}`,
    `--format=${COMMIT_FORMAT}`,
    tip,
    ...(exclude ? [`^${exclude}`] : []),
    '--'
  ])
  const fields = output.split('\0')
  if (fields.at(-1) === '') fields.pop()
  if (fields.length % 6 !== 0)
    throw new L4WorkSessionGitError('read-failed', 'Git 提交列表格式无效')
  const scanned: L4GitCommit[] = []
  for (let index = 0; index < Math.min(fields.length, LOG_SCAN_LIMIT * 6); index += 6) {
    scanned.push(parseCommit(fields.slice(index, index + 6)))
  }
  const query = input.query.toLocaleLowerCase()
  const author = input.author?.toLocaleLowerCase()
  const matches = scanned.filter(
    (commit) =>
      (!author || commit.author.toLocaleLowerCase().includes(author)) &&
      (!query || commit.subject.toLocaleLowerCase().includes(query) || commit.oid.includes(query))
  )
  const offset = (input.page.index - 1) * input.page.size
  return {
    tip,
    exclude,
    items: matches.slice(offset, offset + input.page.size),
    hasMore: offset + input.page.size < matches.length,
    truncated: fields.length > LOG_SCAN_LIMIT * 6
  }
}

export async function listL4ProjectGitChanges(
  cwd: string,
  root: string,
  input: L4GitChangesQuery
): Promise<L4GitChanges> {
  const repository = await resolveL4GitRepository(cwd, root)
  let base: string | null
  let original: string | null
  let target: string
  let commit: L4GitChanges['commit'] = null
  if ('commit' in input.selection) {
    const oid = await resolveCommit(repository, input.selection.commit)
    if (!oid) throw new L4WorkSessionGitError('invalid-ref', '当前仓库还没有提交')
    const detail = await readCommit(repository, oid)
    const parent = input.selection.parent ?? detail.parents[0] ?? null
    if (parent && !detail.parents.includes(parent))
      throw new L4WorkSessionGitError('invalid-ref', '选择的版本不是该提交的父提交')
    target = oid
    base = original = parent
    commit = { ...detail, selectedParent: parent }
  } else {
    const baseOid = await resolveCommit(repository, input.selection.base)
    const targetOid = await resolveCommit(repository, input.selection.target)
    if (!baseOid || !targetOid) throw new L4WorkSessionGitError('invalid-ref', '比较分支还没有提交')
    base = baseOid
    target = targetOid
    original = base
    if (input.selection.strategy === 'merge-base') {
      const result = await executeGitText(repository, ['merge-base', '--all', base, target])
      if (result.code !== 0 && result.code !== 1)
        throw new L4WorkSessionGitError('read-failed', '计算共同祖先失败')
      const ancestors = result.stdout.trim().split(/\s+/).filter(Boolean)
      if (ancestors.length !== 1) {
        const shallow =
          (await readGitText(repository, ['rev-parse', '--is-shallow-repository'])).trim() ===
          'true'
        throw new L4WorkSessionGitError(
          'invalid-ref',
          ancestors.length > 1
            ? '存在多个最佳共同祖先，请改用两个版本直接比较'
            : shallow
              ? '浅克隆历史不足，无法确定共同祖先；可改用直接比较'
              : '两个版本没有共同祖先，可改用直接比较'
        )
      }
      original = ancestors[0]!
    }
  }
  const args = original
    ? [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--find-renames',
        '--name-status',
        '-z',
        original,
        target,
        '--'
      ]
    : [
        'diff-tree',
        '--root',
        '--no-commit-id',
        '-r',
        '--no-ext-diff',
        '--no-textconv',
        '--find-renames',
        '--name-status',
        '-z',
        target,
        '--'
      ]
  const output = await readGitText(repository, args)
  const fields = output.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const changes: L4GitChanges['items'] = []
  for (let index = 0; index < fields.length;) {
    const code = fields[index++]!
    const first = fields[index++]
    const renamed = code.startsWith('R') || code.startsWith('C')
    const path = renamed ? fields[index++] : first
    if (
      !path ||
      !L4ProjectFilePathSchema.safeParse(path).success ||
      (renamed && !L4ProjectFilePathSchema.safeParse(first).success)
    ) {
      throw new L4WorkSessionGitError('read-failed', '变更包含无法展示的文件路径')
    }
    const status =
      code[0] === 'R'
        ? 'renamed'
        : code[0] === 'A' || code[0] === 'C'
          ? 'added'
          : code[0] === 'D'
            ? 'deleted'
            : code[0] === 'T'
              ? 'type-changed'
              : 'modified'
    changes.push({ path, oldPath: code[0] === 'R' ? first! : null, status })
    if (changes.length > CHANGE_LIMIT) break
  }
  const offset = (input.page.index - 1) * input.page.size
  const bounded = changes.slice(0, CHANGE_LIMIT)
  return {
    comparison: { base, target, original },
    commit,
    items: bounded.slice(offset, offset + input.page.size),
    hasMore: offset + input.page.size < bounded.length,
    truncated: changes.length > CHANGE_LIMIT
  }
}

export async function listL4ProjectGitBranches(
  cwd: string,
  root: string
): Promise<L4GitReadBranches> {
  const branches = await listL4WorkSessionGitBranches(cwd, root)
  if (branches.head.type !== 'branch') return { ...branches, upstream: null }
  const repository = await resolveL4GitRepository(cwd, root)
  const output = await readGitText(repository, [
    'for-each-ref',
    '--format=%(upstream)',
    `refs/heads/${branches.head.name}`
  ])
  const ref = output.trim()
  if (!ref) return { ...branches, upstream: null }
  const counts = await executeGitText(repository, [
    'rev-list',
    '--left-right',
    '--count',
    `HEAD...${ref}`,
    '--'
  ])
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number)
  return {
    ...branches,
    upstream: {
      ref,
      ahead: counts.code === 0 && Number.isSafeInteger(ahead) ? ahead! : null,
      behind: counts.code === 0 && Number.isSafeInteger(behind) ? behind! : null
    }
  }
}

export async function getL4ProjectGitDiff(
  cwd: string,
  root: string,
  path: string,
  comparison?: L4GitHistoricalDiff
): Promise<L4GitPreviewDiff> {
  if (!comparison) return getL4WorkSessionGitDiff(cwd, root, path)
  return readHistoricalDiff(await resolveL4GitRepository(cwd, root), path, comparison)
}
