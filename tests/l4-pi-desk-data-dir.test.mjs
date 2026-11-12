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
const { getL4PiDeskDataDir } = await import(
  pathToFileURL(resolve('src/server/l4_foundation/pi/l4-pi-desk-data-dir.ts')).href
)
Module._load = originalLoad

test('数据目录只返回pi-desk，不读取或复制旧pi-super目录', async (context) => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const root = resolve('temp/pi/l4-pi-desk-data-dir', `latest-path-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const legacyDir = join(agentDir, 'pi-super')
  const legacyFile = join(legacyDir, 'plugins', 'settings.json')
  await mkdir(join(legacyDir, 'plugins'), { recursive: true })
  await writeFile(legacyFile, '{"enabled":true}', 'utf8')
  process.env.PI_CODING_AGENT_DIR = agentDir

  context.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    await rm(root, { recursive: true, force: true })
  })

  const dataDir = getL4PiDeskDataDir()
  assert.equal(dataDir, join(agentDir, 'pi-desk'))
  await assert.rejects(readFile(join(dataDir, 'plugins', 'settings.json')), { code: 'ENOENT' })
  await assert.rejects(readFile(dataDir), { code: 'ENOENT' })
  assert.equal(await readFile(legacyFile, 'utf8'), '{"enabled":true}')

  await mkdir(dataDir)
  await writeFile(join(dataDir, 'host-state.json'), '{"initialized":true}', 'utf8')
  assert.equal(getL4PiDeskDataDir(), dataDir)
  assert.equal(await readFile(join(dataDir, 'host-state.json'), 'utf8'), '{"initialized":true}')
})
