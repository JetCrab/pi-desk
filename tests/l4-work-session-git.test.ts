import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  L2WorkSessionGitDiffGetRequestSchema,
  L2WorkSessionGitGetRequestSchema
} from '../src/common/l2_biz/work-session/l2-work-session-git-contract'
import { selectL4LocalizedText } from '../src/common/l4_foundation/locale/l4-localized-text'
import { searchL4WorkSessionProjectFiles } from '../src/server/l4_foundation/file/l4-work-session-project-file'
import {
  addL4WorkSessionGitBranch,
  getL4WorkSessionGitDiff,
  getL4WorkSessionGitSnapshot,
  listL4WorkSessionGitBranches,
  replaceL4WorkSessionGitBranch
} from '../src/server/l4_foundation/git/l4-work-session-git'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' }
  })
  return result.stdout
}

async function initRepository(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await git(root, ['init', '-b', 'main'])
  await git(root, ['config', 'user.name', 'Pi Desk Test'])
  await git(root, ['config', 'user.email', 'pi-desk@example.test'])
  await git(root, ['config', 'core.autocrlf', 'false'])
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-m', message])
}

async function nestedFixture(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-git-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await initRepository(root)
  await writeFile(join(root, '.gitignore'), 'B/\nC/\n')
  await writeFile(join(root, 'README.md'), 'root v1\n')
  await writeFile(
    join(root, 'rename-source.txt'),
    'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n'
  )
  await writeFile(join(root, 'deleted.txt'), 'delete me\n')
  await commitAll(root, 'root initial')

  for (const child of ['B', 'C']) {
    const childRoot = join(root, child)
    await initRepository(childRoot)
    await mkdir(join(childRoot, 'src'), { recursive: true })
    await writeFile(join(childRoot, 'src', 'index.ts'), `export const ${child} = true\n`)
    await commitAll(childRoot, `${child} initial`)
  }

  return root
}

function readyRepository(
  snapshot: Awaited<ReturnType<typeof getL4WorkSessionGitSnapshot>>,
  root: string
) {
  const repository = snapshot.repositories.find((candidate) => candidate.root === root)
  assert.ok(repository, `missing repository ${root}`)
  assert.equal(repository.state, 'ready')
  return repository
}

test('Git 请求路径必须保持在 WorkSession 项目内', () => {
  assert.equal(
    L2WorkSessionGitGetRequestSchema.safeParse({ workId: 'work-1', cwd: 'C:/project' }).success,
    true
  )
  assert.equal(
    L2WorkSessionGitDiffGetRequestSchema.safeParse({
      workId: 'work-1',
      cwd: 'C:/project',
      repositoryRoot: '../outside',
      path: 'README.md'
    }).success,
    false
  )
})

test('Git仓库不可读取时返回可选择的中文和英文诊断', async (context) => {
  const project = await mkdtemp(join(tmpdir(), 'pi-desk-git-unavailable-'))
  context.after(() => rm(project, { recursive: true, force: true }))
  await mkdir(join(project, '.git'), { recursive: true })

  const snapshot = await getL4WorkSessionGitSnapshot(project)
  const repository = snapshot.repositories.find((item) => item.root === '')
  assert.ok(repository)
  assert.equal(repository.state, 'unavailable')
  if (repository.state !== 'unavailable') return
  assert.match(selectL4LocalizedText(repository.message, 'zh-CN'), /^读取 Git 状态失败：/)
  assert.match(selectL4LocalizedText(repository.message, 'en'), /^Could not read Git status: /)
})

test('发现被父仓库忽略的嵌套仓库并隔离各自变更', async (context) => {
  const root = await nestedFixture(context)
  await writeFile(join(root, 'README.md'), 'root v2\n')
  await writeFile(join(root, 'staged.ts'), 'export const staged = true\n')
  await git(root, ['add', 'staged.ts'])
  await writeFile(join(root, 'untracked.txt'), 'untracked\n')

  const child = join(root, 'B')
  await rename(join(child, 'src', 'index.ts'), join(child, 'src', 'renamed.ts'))
  await git(child, ['add', '-A'])

  const snapshot = await getL4WorkSessionGitSnapshot(root)
  assert.deepEqual(
    snapshot.repositories.map((repository) => repository.root),
    ['', 'B', 'C']
  )

  const parent = readyRepository(snapshot, '')
  assert.deepEqual(
    parent.changes.map((change) => change.path),
    ['README.md', 'staged.ts', 'untracked.txt']
  )
  assert.deepEqual(
    parent.changes.find((change) => change.path === 'README.md'),
    {
      path: 'README.md',
      oldPath: null,
      indexStatus: null,
      worktreeStatus: 'modified'
    }
  )
  assert.equal(parent.changes.find((change) => change.path === 'staged.ts')?.indexStatus, 'added')
  assert.equal(
    parent.changes.find((change) => change.path === 'untracked.txt')?.worktreeStatus,
    'untracked'
  )

  const nested = readyRepository(snapshot, 'B')
  assert.deepEqual(nested.changes, [
    {
      path: 'src/renamed.ts',
      oldPath: 'src/index.ts',
      indexStatus: 'renamed',
      worktreeStatus: null
    }
  ])
  assert.equal(readyRepository(snapshot, 'C').changes.length, 0)

  const search = await searchL4WorkSessionProjectFiles(root, 'renamed')
  assert.deepEqual(search.matches, ['B/src/renamed.ts'])
})

test('发现 `.git` 文件形式的嵌套 worktree', async (context) => {
  const project = await mkdtemp(join(tmpdir(), 'pi-desk-git-worktree-project-'))
  const source = await mkdtemp(join(tmpdir(), 'pi-desk-git-worktree-source-'))
  context.after(() =>
    Promise.all([
      rm(project, { recursive: true, force: true }),
      rm(source, { recursive: true, force: true })
    ])
  )
  await initRepository(source)
  await writeFile(join(source, 'README.md'), 'source\n')
  await commitAll(source, 'initial')
  const linked = join(project, 'linked')
  await git(source, ['worktree', 'add', '-b', 'linked-branch', linked])

  const snapshot = await getL4WorkSessionGitSnapshot(project)
  assert.deepEqual(
    snapshot.repositories.map((repository) => repository.root),
    ['linked']
  )
  assert.deepEqual(readyRepository(snapshot, 'linked').head, {
    type: 'branch',
    name: 'linked-branch'
  })
})

test('仓库发现只扫描根目录和直接子目录', async (context) => {
  const project = await mkdtemp(join(tmpdir(), 'pi-desk-git-depth-'))
  context.after(() => rm(project, { recursive: true, force: true }))
  await initRepository(join(project, 'direct'))
  await initRepository(join(project, 'container', 'deep'))

  const snapshot = await getL4WorkSessionGitSnapshot(project)
  assert.deepEqual(
    snapshot.repositories.map((repository) => repository.root),
    ['direct']
  )
  await assert.rejects(
    () => listL4WorkSessionGitBranches(project, 'container/deep'),
    /只支持项目根目录及其直接子目录中的 Git 仓库/
  )
})

test('按需读取分支并支持新建、本地切换和远程检出', async (context) => {
  const root = await nestedFixture(context)
  const remote = await mkdtemp(join(tmpdir(), 'pi-desk-git-remote-'))
  context.after(() => rm(remote, { recursive: true, force: true }))
  await git(remote, ['init', '--bare'])
  await git(root, ['remote', 'add', 'origin', remote])
  await git(root, ['push', '-u', 'origin', 'main'])
  await git(root, ['switch', '-c', 'remote-only'])
  await writeFile(join(root, 'remote.txt'), 'remote branch\n')
  await commitAll(root, 'remote branch')
  await git(root, ['push', '-u', 'origin', 'remote-only'])
  await git(root, ['switch', 'main'])
  await git(root, ['branch', '-D', 'remote-only'])

  const initial = await listL4WorkSessionGitBranches(root, '')
  assert.equal(initial.head.type, 'branch')
  assert.deepEqual(initial.local, ['main'])
  assert.ok(initial.remote.includes('origin/main'))
  assert.ok(initial.remote.includes('origin/remote-only'))

  const created = await addL4WorkSessionGitBranch(root, '', 'feature/git-ui', null)
  assert.deepEqual(created.head, { type: 'branch', name: 'feature/git-ui' })

  const switched = await replaceL4WorkSessionGitBranch(root, '', {
    type: 'local',
    name: 'main'
  })
  assert.deepEqual(switched.head, { type: 'branch', name: 'main' })

  const remoteCheckedOut = await replaceL4WorkSessionGitBranch(root, '', {
    type: 'remote',
    name: 'origin/remote-only'
  })
  assert.deepEqual(remoteCheckedOut.head, { type: 'branch', name: 'remote-only' })

  const refreshed = await listL4WorkSessionGitBranches(root, '')
  assert.ok(refreshed.local.includes('feature/git-ui'))
  assert.ok(refreshed.local.includes('remote-only'))
  assert.ok(refreshed.recent.includes('main'))
})

test('Diff 返回 HEAD 与工作区文本并处理新增、删除、重命名和二进制', async (context) => {
  const root = await nestedFixture(context)
  await writeFile(join(root, 'README.md'), 'root v2\n')
  await writeFile(join(root, 'new.txt'), 'new file\n')
  await rm(join(root, 'deleted.txt'))
  await rename(join(root, 'rename-source.txt'), join(root, 'RENAMED.md'))
  await writeFile(
    join(root, 'RENAMED.md'),
    'line 1\nline 2\nline 3 updated\nline 4\nline 5\nline 6\nline 7\nline 8\n'
  )
  await git(root, ['add', '-A'])
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))

  const renamed = await getL4WorkSessionGitDiff(root, '', 'RENAMED.md')
  assert.deepEqual(renamed, {
    kind: 'text',
    original: {
      path: 'rename-source.txt',
      content: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n'
    },
    modified: {
      path: 'RENAMED.md',
      content: 'line 1\nline 2\nline 3 updated\nline 4\nline 5\nline 6\nline 7\nline 8\n'
    }
  })

  const added = await getL4WorkSessionGitDiff(root, '', 'new.txt')
  assert.deepEqual(added, {
    kind: 'text',
    original: { path: 'new.txt', content: '' },
    modified: { path: 'new.txt', content: 'new file\n' }
  })

  const deleted = await getL4WorkSessionGitDiff(root, '', 'deleted.txt')
  assert.deepEqual(deleted, {
    kind: 'text',
    original: { path: 'deleted.txt', content: 'delete me\n' },
    modified: { path: 'deleted.txt', content: '' }
  })

  assert.deepEqual(await getL4WorkSessionGitDiff(root, '', 'binary.bin'), { kind: 'binary' })

  await writeFile(join(root, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61))
  assert.deepEqual(await getL4WorkSessionGitDiff(root, '', 'large.txt'), {
    kind: 'too_large'
  })
})

test('冲突文件投影为 unmerged', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-git-conflict-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await initRepository(root)
  await writeFile(join(root, 'conflict.txt'), 'base\n')
  await commitAll(root, 'initial')
  await git(root, ['switch', '-c', 'other'])
  await writeFile(join(root, 'conflict.txt'), 'other\n')
  await commitAll(root, 'other')
  await git(root, ['switch', 'main'])
  await writeFile(join(root, 'conflict.txt'), 'main\n')
  await commitAll(root, 'main')
  await assert.rejects(() => git(root, ['merge', 'other']))

  const repository = readyRepository(await getL4WorkSessionGitSnapshot(root), '')
  assert.deepEqual(repository.changes, [
    {
      path: 'conflict.txt',
      oldPath: null,
      indexStatus: 'unmerged',
      worktreeStatus: 'unmerged'
    }
  ])
})
