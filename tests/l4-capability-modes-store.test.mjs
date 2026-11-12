import assert from 'node:assert/strict'
import Module from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {}
  if (request === '@earendil-works/pi-coding-agent') {
    return { getAgentDir: () => process.env.PI_CODING_AGENT_DIR }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { L4CapabilityModesStore } = await import(
  pathToFileURL(resolve('src/server/l4_foundation/capability-modes/l4-capability-modes-store.ts'))
    .href
)
Module._load = originalLoad

test('能力模式只读config，旧根文件保持原样且缺新文件用空集合', async (context) => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const agentDir = resolve(
    'temp/pi/l4-capability-modes-store',
    `modes-migration-${randomUUID()}`,
    'agent'
  )
  await mkdir(agentDir, { recursive: true })
  context.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    await rm(agentDir, { recursive: true, force: true })
  })
  process.env.PI_CODING_AGENT_DIR = agentDir

  const previousPath = join(agentDir, 'pi-super-capability-modes.json')
  const currentPath = join(agentDir, 'config', 'pi-desk-capability-modes.json')
  const rootLegacyPath = join(agentDir, 'pi-desk-capability-modes.json')
  const previousContent = '{"modes":{"old":{"name":"旧模式"}}}'
  await writeFile(previousPath, previousContent, 'utf8')
  await writeFile(rootLegacyPath, '{broken', 'utf8')

  const store = new L4CapabilityModesStore()

  assert.deepEqual(store.read(), {})
  await assert.rejects(readFile(currentPath), { code: 'ENOENT' })
  const modes = { current: { name: '当前模式', tools: { allow: ['read'] } } }
  await store.replace(modes)
  assert.deepEqual(new L4CapabilityModesStore().read(), modes)
  assert.deepEqual(JSON.parse(await readFile(currentPath, 'utf8')), { modes })
  assert.equal(await readFile(previousPath, 'utf8'), previousContent)
  assert.equal(await readFile(rootLegacyPath, 'utf8'), '{broken')
})
