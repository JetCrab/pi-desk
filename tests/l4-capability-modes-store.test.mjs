import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

test('首次加载复制旧 Pi Super capability modes 文件并保留旧文件', async (context) => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-desk-capability-modes-migration-'))
  context.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    await rm(agentDir, { recursive: true, force: true })
  })
  process.env.PI_CODING_AGENT_DIR = agentDir

  const previousPath = join(agentDir, 'pi-super-capability-modes.json')
  const currentPath = join(agentDir, 'pi-desk-capability-modes.json')
  const previousContent = '{"modes":{}}'
  await writeFile(previousPath, previousContent, 'utf8')

  const store = new L4CapabilityModesStore()

  assert.deepEqual(store.read(), {})
  assert.equal(await readFile(currentPath, 'utf8'), previousContent)
  assert.equal(await readFile(previousPath, 'utf8'), previousContent)
})
