import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createJiti } from 'jiti'
import type { L4GitHistoricalDiff } from '../src/common/l4_foundation/git/l4-git-history-contract'

type HistoryModule = typeof import('../src/server/l4_foundation/git/l4-project-git-history')
type GitModule = typeof import('../src/server/l4_foundation/git/l4-work-session-git')

const require = createRequire(import.meta.url)
const serverOnlyEntry = require.resolve('server-only')
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})
const modulesPromise: Promise<[HistoryModule, GitModule]> = Promise.all([
  jiti.import<HistoryModule>('../src/server/l4_foundation/git/l4-project-git-history.ts'),
  jiti.import<GitModule>('../src/server/l4_foundation/git/l4-work-session-git.ts')
])
const execFileAsync = promisify(execFile)

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  return result.stdout.trim()
}

async function fixture(): Promise<{
  root: string
  cleanup: () => Promise<void>
  commits: {
    root: string
    merge: string
    mergeParent1: string
    mergeParent2: string
    main: string
    big: string
    gitlink: string
  }
}> {
  const root = await mkdtemp(join(process.cwd(), 'temp/tests/l4-project-git-history-'))
  const cleanup = () => rm(root, { recursive: true, force: true })
  const commit = async (message: string): Promise<string> => {
    await git(root, ['add', '-A'])
    await git(root, ['commit', '-m', message])
    return git(root, ['rev-parse', 'HEAD'])
  }
  await git(root, ['init', '-b', 'main'])
  await git(root, ['config', 'user.name', 'Project Git History Test'])
  await git(root, ['config', 'user.email', 'project-git-history@example.test'])
  await writeFile(join(root, 'base.txt'), 'root\n')
  await writeFile(join(root, 'old.txt'), 'rename me\n')
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  const rootCommit = await commit('root commit')

  await git(root, ['branch', 'compare-base'])
  await git(root, ['branch', 'compare-target'])
  await git(root, ['branch', 'feature'])

  await git(root, ['switch', 'compare-base'])
  await writeFile(join(root, 'base-only.txt'), 'base\n')
  await commit('compare base')
  await git(root, ['switch', 'compare-target'])
  await writeFile(join(root, 'target-only.txt'), 'target\n')
  await commit('compare target')

  await git(root, ['switch', 'feature'])
  await writeFile(join(root, 'feature.txt'), 'feature\n')
  const featureCommit = await commit('feature parent')
  await git(root, ['switch', 'main'])
  await writeFile(join(root, 'main.txt'), 'main\n')
  await git(root, ['mv', 'old.txt', 'renamed.txt'])
  await writeFile(join(root, 'deleted.txt'), 'delete me\n')
  const mainParentBeforeDelete = await commit('main parent')
  await git(root, ['rm', 'deleted.txt'])
  const mergeParent = await commit('delete file')
  await git(root, ['merge', '--no-ff', 'feature', '-m', 'merge feature'])
  const mergeCommit = await git(root, ['rev-parse', 'HEAD'])

  await writeFile(join(root, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 97))
  const bigCommit = await commit('large historical file')
  const submodule = join(root, 'gitlink-source')
  await mkdir(submodule, { recursive: true })
  await execFileAsync('git', ['init', '-b', 'main'], {
    cwd: submodule,
    encoding: 'utf8',
    windowsHide: true
  })
  await execFileAsync('git', ['config', 'user.name', 'Gitlink Test'], {
    cwd: submodule,
    encoding: 'utf8',
    windowsHide: true
  })
  await execFileAsync('git', ['config', 'user.email', 'gitlink@example.test'], {
    cwd: submodule,
    encoding: 'utf8',
    windowsHide: true
  })
  await writeFile(join(submodule, 'module.txt'), 'module\n', 'utf8')
  await execFileAsync('git', ['add', 'module.txt'], {
    cwd: submodule,
    encoding: 'utf8',
    windowsHide: true
  })
  await execFileAsync('git', ['commit', '-m', 'gitlink root'], {
    cwd: submodule,
    encoding: 'utf8',
    windowsHide: true
  })
  const submoduleOid = (
    await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: submodule,
      encoding: 'utf8',
      windowsHide: true
    })
  ).stdout.trim()
  await git(root, ['update-index', '--add', '--cacheinfo', `160000,${submoduleOid},vendor/module`])
  await git(root, ['commit', '-m', 'gitlink metadata'])
  const gitlinkCommit = await git(root, ['rev-parse', 'HEAD'])
  const featureOid = await git(root, ['rev-parse', 'feature'])
  await git(root, ['branch', '-D', 'feature'])
  await git(root, ['branch', 'feature/review#1@local', featureOid])
  return {
    root,
    cleanup,
    commits: {
      root: rootCommit,
      merge: mergeCommit,
      mergeParent1: mergeParent,
      mergeParent2: featureCommit,
      main: mainParentBeforeDelete,
      big: bigCommit,
      gitlink: gitlinkCommit
    }
  }
}

function expectGitError(error: unknown, kind: string): void {
  assert.equal(error instanceof Error, true)
  assert.equal((error as { kind?: string }).kind, kind)
}

test('作者姓名部分匹配不区分大小写，与提交搜索组合后再分页', async (context) => {
  const [{ listL4ProjectGitLog }] = await modulesPromise
  const repo = await fixture()
  context.after(repo.cleanup)

  await git(repo.root, ['config', 'user.name', 'Alice Developer'])
  await git(repo.root, ['config', 'user.email', 'alice@example.test'])
  for (const message of ['needle one', 'needle two', 'other message']) {
    await writeFile(join(repo.root, 'author-filter.txt'), `${message}\\n`)
    await git(repo.root, ['add', 'author-filter.txt'])
    await git(repo.root, ['commit', '-m', message])
  }
  await git(repo.root, ['config', 'user.name', 'Bob Developer'])
  await git(repo.root, ['config', 'user.email', 'bob@example.test'])
  await writeFile(join(repo.root, 'author-filter.txt'), 'needle from bob\\n')
  await git(repo.root, ['add', 'author-filter.txt'])
  await git(repo.root, ['commit', '-m', 'needle from bob'])

  const firstPage = await listL4ProjectGitLog(repo.root, '', {
    tip: 'HEAD',
    query: 'NEEDLE',
    author: 'ALICE',
    page: { index: 1, size: 1 }
  })
  const secondPage = await listL4ProjectGitLog(repo.root, '', {
    tip: 'HEAD',
    query: 'NEEDLE',
    author: 'ALICE',
    page: { index: 2, size: 1 }
  })
  assert.equal(firstPage.items.length, 1)
  assert.equal(firstPage.items[0]?.subject, 'needle two')
  assert.equal(firstPage.items[0]?.author, 'Alice Developer')
  assert.equal(firstPage.hasMore, true)
  assert.equal(secondPage.items.length, 1)
  assert.equal(secondPage.items[0]?.subject, 'needle one')
  assert.equal(secondPage.hasMore, false)
})

test('Git历史支持根提交、分页、merge父提交与非父提交拒绝', async (context) => {
  const [{ listL4ProjectGitLog, listL4ProjectGitChanges, getL4ProjectGitDiff }] =
    await modulesPromise
  const repo = await fixture()
  context.after(repo.cleanup)

  const log = await listL4ProjectGitLog(repo.root, '', {
    tip: 'HEAD',
    query: '',
    page: { index: 1, size: 2 }
  })
  assert.equal(log.items.length, 2)
  assert.equal(log.items[0]?.subject, 'gitlink metadata')
  assert.equal(log.hasMore, true)

  const rootChanges = await listL4ProjectGitChanges(repo.root, '', {
    selection: { commit: repo.commits.root },
    page: { index: 1, size: 50 }
  })
  assert.ok(rootChanges.items.some((item) => item.path === 'base.txt' && item.status === 'added'))

  const mergeChanges = await listL4ProjectGitChanges(repo.root, '', {
    selection: { commit: repo.commits.merge, parent: repo.commits.mergeParent1 },
    page: { index: 1, size: 50 }
  })
  assert.ok(mergeChanges.commit?.parents.includes(repo.commits.mergeParent1))
  const mergeSecondParent = await listL4ProjectGitChanges(repo.root, '', {
    selection: { commit: repo.commits.merge, parent: repo.commits.mergeParent2 },
    page: { index: 1, size: 50 }
  })
  assert.ok(mergeSecondParent.commit?.parents.includes(repo.commits.mergeParent2))
  assert.ok(mergeSecondParent.items.some((item) => item.path === 'main.txt'))
  assert.ok(mergeChanges.items.some((item) => item.path === 'feature.txt'))
  const mainChanges = await listL4ProjectGitChanges(repo.root, '', {
    selection: { commit: repo.commits.main },
    page: { index: 1, size: 50 }
  })
  assert.ok(
    mainChanges.items.some((item) => item.path === 'renamed.txt' && item.status === 'renamed')
  )
  assert.ok(
    mainChanges.items.some((item) => item.path === 'deleted.txt' && item.status === 'added')
  )
  const gitlink = await getL4ProjectGitDiff(repo.root, '', 'vendor/module', {
    baseCommit: repo.commits.big,
    targetCommit: repo.commits.gitlink
  })
  assert.equal(gitlink.kind, 'metadata')

  await assert.rejects(
    listL4ProjectGitChanges(repo.root, '', {
      selection: { commit: repo.commits.merge, parent: repo.commits.root },
      page: { index: 1, size: 50 }
    }),
    (error: unknown) => {
      expectGitError(error, 'invalid-ref')
      return true
    }
  )
})

test('merge-base与direct范围不同，且历史Diff固定SHA不受分支移动影响', async (context) => {
  const [{ listL4ProjectGitChanges, getL4ProjectGitDiff }] = await modulesPromise
  const repo = await fixture()
  context.after(repo.cleanup)

  const mergeBase = await listL4ProjectGitChanges(repo.root, '', {
    selection: {
      base: 'refs/heads/compare-base',
      target: 'refs/heads/compare-target',
      strategy: 'merge-base'
    },
    page: { index: 1, size: 50 }
  })
  const direct = await listL4ProjectGitChanges(repo.root, '', {
    selection: {
      base: 'refs/heads/compare-base',
      target: 'refs/heads/compare-target',
      strategy: 'direct'
    },
    page: { index: 1, size: 50 }
  })
  assert.notDeepEqual(
    mergeBase.items.map((item) => `${item.status}:${item.path}`),
    direct.items.map((item) => `${item.status}:${item.path}`)
  )

  const comparison: L4GitHistoricalDiff = {
    baseCommit: repo.commits.mergeParent1,
    targetCommit: repo.commits.merge
  }
  const beforeMove = await getL4ProjectGitDiff(repo.root, '', 'feature.txt', comparison)
  await git(repo.root, ['branch', '-f', 'compare-target', repo.commits.merge])
  const afterMove = await getL4ProjectGitDiff(repo.root, '', 'feature.txt', comparison)
  assert.deepEqual(afterMove, beforeMove)
})

test('历史binary、too_large、缺对象与无共同祖先不会伪装为空侧', async (context) => {
  const [{ getL4ProjectGitDiff, listL4ProjectGitChanges }] = await modulesPromise
  const repo = await fixture()
  context.after(repo.cleanup)

  const binary = await getL4ProjectGitDiff(repo.root, '', 'binary.bin', {
    baseCommit: null,
    targetCommit: repo.commits.root
  })
  assert.equal(binary.kind, 'binary')
  const large = await getL4ProjectGitDiff(repo.root, '', 'large.txt', {
    baseCommit: repo.commits.merge,
    targetCommit: repo.commits.big
  })
  assert.equal(large.kind, 'too_large')

  await assert.rejects(
    getL4ProjectGitDiff(repo.root, '', 'base.txt', {
      baseCommit: '0000000000000000000000000000000000000000',
      targetCommit: repo.commits.root
    }),
    (error: unknown) => {
      expectGitError(error, 'invalid-ref')
      return true
    }
  )

  await git(repo.root, ['switch', '--orphan', 'orphan'])
  await git(repo.root, ['clean', '-fdx'])
  await writeFile(join(repo.root, 'orphan.txt'), 'orphan\n')
  await git(repo.root, ['add', 'orphan.txt'])
  await git(repo.root, ['commit', '-m', 'orphan root'])
  await assert.rejects(
    listL4ProjectGitChanges(repo.root, '', {
      selection: { base: 'refs/heads/main', target: 'refs/heads/orphan', strategy: 'merge-base' },
      page: { index: 1, size: 50 }
    }),
    (error: unknown) => {
      expectGitError(error, 'invalid-ref')
      return true
    }
  )
})

test('非Git与坏仓库返回明确边界错误', async (context) => {
  const [{ listL4ProjectGitLog }, { resolveL4GitRepository }] = await modulesPromise
  const root = await mkdtemp(join(process.cwd(), 'temp/tests/l4-project-git-history-boundary-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(resolveL4GitRepository(root, ''), /Git|仓库|repository/i)
  await mkdir(join(root, '.git'))
  await assert.rejects(
    listL4ProjectGitLog(root, '', { tip: 'HEAD', query: '', page: { index: 1, size: 20 } }),
    /Git|仓库|读取/i
  )
})
