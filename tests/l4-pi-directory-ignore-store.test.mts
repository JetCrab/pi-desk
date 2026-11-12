import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: resolve('tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})
const { listL4IgnoredPiDirectoryCwds, replaceL4PiDirectoryIgnore } = await jiti.import<
  typeof import('../src/server/l4_foundation/pi/l4-pi-directory-ignore-store')
>('../src/server/l4_foundation/pi/l4-pi-directory-ignore-store.ts')

test('忽略目录只读config，旧数据文件保持原样且新配置正常更新', async (context) => {
  const root = resolve(
    'temp/pi/l4-pi-directory-ignore-store',
    `directories-migration-${randomUUID()}`
  )
  const agentDir = join(root, 'agent')
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  context.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  })
  const legacy = join(agentDir, 'pi-desk', 'ignored-pi-directories.json')
  const target = join(agentDir, 'config', 'pi-desk-ignored-directories.json')
  const first = join(root, 'first-project')
  const second = join(root, 'second-project')
  const content = JSON.stringify([first])
  await writeFile(legacy, content)
  assert.deepEqual(listL4IgnoredPiDirectoryCwds(), [])
  await assert.rejects(readFile(target), { code: 'ENOENT' })
  replaceL4PiDirectoryIgnore(first, true)
  replaceL4PiDirectoryIgnore(second, true)
  replaceL4PiDirectoryIgnore(first, false)
  assert.deepEqual(listL4IgnoredPiDirectoryCwds(), [second])
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), [second])
  assert.equal(await readFile(legacy, 'utf8'), content)
  await writeFile(legacy, '{broken')
  assert.deepEqual(listL4IgnoredPiDirectoryCwds(), [second])
  replaceL4PiDirectoryIgnore(second, false)
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), [])
  assert.equal(await readFile(legacy, 'utf8'), '{broken')
})
