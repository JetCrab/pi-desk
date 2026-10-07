import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: resolve('tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})

test('MCP 保存仅影响提交项，项目简写保持继承且配置不被执行', async () => {
  const root = resolve('temp/pi/l4-pi-settings-store', `config-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  let passed = false
  try {
    await mkdir(agentDir, { recursive: true })
    await mkdir(join(cwd, '.pi'), { recursive: true })
    const globalPath = join(agentDir, 'mcp.json')
    const retained = {
      url: 'https://example.invalid/mcp',
      headers: { Authorization: 'Bearer fixture' },
      vendorExtension: { preserve: true }
    }
    await writeFile(
      globalPath,
      JSON.stringify({ autoEnableCodemode: false, futureRoot: 7, mcpServers: { docs: retained } })
    )
    await writeFile(
      join(cwd, '.pi', 'mcp.json'),
      JSON.stringify({ mcpServers: { docs: { enabled: false } } })
    )
    const { L4PiSettingsStore } = await jiti.import<
      typeof import('../src/server/l4_foundation/pi-settings/l4-pi-settings-store')
    >('../src/server/l4_foundation/pi-settings/l4-pi-settings-store.ts')
    const store = new L4PiSettingsStore(agentDir)
    const initial = await store.readMcp(cwd)
    assert.deepEqual(initial.local.docs, { enabled: false })
    assert.deepEqual(initial.inherited.docs, retained)
    await Promise.all([
      store.replaceMcp({
        cwd: null,
        servers: { alpha: { command: 'never-execute-fixture', args: ['--one'] } }
      }),
      store.replaceMcp({ cwd: null, servers: { beta: { url: 'https://example.invalid/beta' } } })
    ])
    const saved = JSON.parse(await readFile(globalPath, 'utf8'))
    assert.deepEqual(saved.mcpServers.docs, retained)
    assert.ok(saved.mcpServers.alpha)
    assert.ok(saved.mcpServers.beta)
    assert.equal(saved.autoEnableCodemode, false)
    assert.equal(saved.futureRoot, 7)
    await store.deleteMcp({ cwd, name: 'docs' })
    const inherited = await store.readMcp(cwd)
    assert.equal(inherited.local.docs, undefined)
    assert.deepEqual(inherited.inherited.docs, retained)
    await assert.rejects(store.deleteMcp({ cwd, name: 'docs' }))
    const beforeInvalid = await readFile(globalPath, 'utf8')
    await assert.rejects(
      store.replaceMcp({ cwd: null, servers: { bad: { command: 'fixture', args: [42] } } })
    )
    assert.equal(await readFile(globalPath, 'utf8'), beforeInvalid)
    passed = true
  } finally {
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error(`Pi 设置验证现场：${root}`)
  }
})

test('MCP 保存不修改官方保温设置，损坏 JSON 不当空配置覆盖', async () => {
  const root = resolve('temp/pi/l4-pi-settings-store', `mcp-preservation-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  let passed = false
  try {
    await mkdir(agentDir, { recursive: true })
    const settingsPath = join(agentDir, 'settings.json')
    const settingsText = JSON.stringify({ cacheWarming: 'idle', futureSetting: { x: 1 } })
    await writeFile(settingsPath, settingsText)
    const path = join(agentDir, 'mcp.json')
    const { L4PiSettingsStore } = await jiti.import<
      typeof import('../src/server/l4_foundation/pi-settings/l4-pi-settings-store')
    >('../src/server/l4_foundation/pi-settings/l4-pi-settings-store.ts')
    const store = new L4PiSettingsStore(agentDir)
    await store.replaceMcp({ cwd: null, servers: { docs: { url: 'https://example.invalid/mcp' } } })
    assert.equal(await readFile(settingsPath, 'utf8'), settingsText)
    await writeFile(path, '{broken')
    await assert.rejects(store.replaceMcp({ cwd: null, servers: { docs: { enabled: false } } }))
    assert.equal(await readFile(path, 'utf8'), '{broken')
    assert.equal(await readFile(settingsPath, 'utf8'), settingsText)
    passed = true
  } finally {
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error(`MCP 设置保真现场：${root}`)
  }
})
