import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { createJiti } from 'jiti'

type HistoryModule = typeof import('../src/server/l4_foundation/git/l4-project-git-history')
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const serverOnlyEntry = require.resolve('server-only')
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})
const historyPromise = jiti.import<HistoryModule>(
  '../src/server/l4_foundation/git/l4-project-git-history.ts'
)

async function run(cwd: string, args: readonly string[]): Promise<string> {
  return (
    await execFileAsync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  ).stdout.trim()
}

test('浅克隆缺少共同历史时merge-base明确报错，合法#/@ ref可解析', async (context) => {
  const root = await mkdtemp(join(process.cwd(), 'temp/tests/l4-project-git-history-shallow-'))
  const shallow = join(root, 'shallow')
  context.after(() => rm(root, { recursive: true, force: true }))
  await run(root, ['init', '-b', 'main'])
  await run(root, ['config', 'user.name', 'Shallow Test'])
  await run(root, ['config', 'user.email', 'shallow@example.test'])
  await execFileAsync('node', ['-e', "require('fs').writeFileSync('root.txt','root\\n')"], {
    cwd: root,
    windowsHide: true
  })
  await run(root, ['add', 'root.txt'])
  await run(root, ['commit', '-m', 'root'])
  await run(root, ['switch', '-c', 'feature'])
  await execFileAsync('node', ['-e', "require('fs').writeFileSync('feature.txt','feature\\n')"], {
    cwd: root,
    windowsHide: true
  })
  await run(root, ['add', 'feature.txt'])
  await run(root, ['commit', '-m', 'feature'])
  await run(root, ['switch', 'main'])
  await execFileAsync('node', ['-e', "require('fs').writeFileSync('main.txt','main\\n')"], {
    cwd: root,
    windowsHide: true
  })
  await run(root, ['add', 'main.txt'])
  await run(root, ['commit', '-m', 'main'])
  const featureOid = await run(root, ['rev-parse', 'feature'])
  await run(root, [
    'clone',
    '--depth',
    '1',
    '--branch',
    'feature',
    `file:///${root.replaceAll('\\', '/')}`,
    shallow
  ])
  await run(root, ['branch', '-D', 'feature'])
  await run(root, ['branch', 'feature/review#1@local', featureOid])
  await run(shallow, ['fetch', '--depth=1', 'origin', 'main:refs/remotes/origin/main'])
  const [{ listL4ProjectGitChanges, listL4ProjectGitLog }] = await Promise.all([historyPromise])
  await assert.rejects(
    listL4ProjectGitChanges(shallow, '', {
      selection: { base: 'refs/remotes/origin/main', target: 'HEAD', strategy: 'merge-base' },
      page: { index: 1, size: 50 }
    }),
    /浅克隆历史不足|共同祖先/
  )
  const specialRef = await listL4ProjectGitLog(root, '', {
    tip: 'refs/heads/feature/review#1@local',
    query: '',
    page: { index: 1, size: 20 }
  })
  assert.equal(specialRef.items[0]?.subject, 'feature')
  await assert.rejects(
    listL4ProjectGitLog(root, '', {
      tip: 'refs/heads/invalid..ref',
      query: '',
      page: { index: 1, size: 20 }
    }),
    /Git 版本无效|引用名称无效/
  )
})
