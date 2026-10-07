import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {}
  return originalLoad.call(this, request, parent, isMain)
}
const { L4PiPluginOwnerRuntime } =
  await import('../src/server/l4_foundation/pi/l4-pi-plugin-owner-runtime.ts')
Module._load = originalLoad

async function createRuntime(entrySource) {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-capability-owner-'))
  const packageRoot = join(root, 'package')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'capability-owner-fixture',
      type: 'module',
      piDesk: { entry: './entry.mjs' }
    }),
    'utf8'
  )
  await writeFile(join(packageRoot, 'entry.mjs'), entrySource, 'utf8')
  const runtime = new L4PiPluginOwnerRuntime(async () => [
    { source: packageRoot, installedPath: packageRoot }
  ])
  return { runtime, root }
}

function capabilityEntry() {
  return `export default {
  name: 'capability-owner-fixture',
  setup(plugin) {
    plugin.declareCapabilities(async ({ signal }) => {
      globalThis.__capabilityLoaderCalls = (globalThis.__capabilityLoaderCalls ?? 0) + 1
      if (globalThis.__capabilityLoaderPending) {
        return await new Promise((resolve) => {
          globalThis.__capabilityLoaderRelease = () => resolve({
            agents: { label: '子代理', options: [{ value: globalThis.__capabilityLoaderVersion }] }
          })
          signal.addEventListener('abort', () => {
            globalThis.__capabilityLoaderAborted = (globalThis.__capabilityLoaderAborted ?? 0) + 1
          }, { once: true })
        })
      }
      return { agents: { label: '子代理', options: [{ value: globalThis.__capabilityLoaderVersion }] } }
    })
  }
}
`
}

test('declareCapabilities 仅在读取目录时调用并取得最新声明', async (context) => {
  globalThis.__capabilityLoaderCalls = 0
  globalThis.__capabilityLoaderVersion = 'v1'
  const fixture = await createRuntime(capabilityEntry())
  context.after(async () => {
    await fixture.runtime.dispose()
    await rm(fixture.root, { recursive: true, force: true })
    delete globalThis.__capabilityLoaderCalls
    delete globalThis.__capabilityLoaderVersion
  })

  await fixture.runtime.initialize()
  assert.equal(globalThis.__capabilityLoaderCalls, 0)
  globalThis.__capabilityLoaderVersion = 'v1'
  assert.deepEqual(
    (await fixture.runtime.listCapabilityDeclarations())['capability-owner-fixture'].agents.options,
    [{ value: 'v1' }]
  )
  globalThis.__capabilityLoaderVersion = 'v2'
  assert.deepEqual(
    (await fixture.runtime.listCapabilityDeclarations())['capability-owner-fixture'].agents.options,
    [{ value: 'v2' }]
  )
  assert.equal(globalThis.__capabilityLoaderCalls, 2)
})

test('Owner 释放会 abort 能力 loader，迟到结果不能重新进入目录', async (context) => {
  globalThis.__capabilityLoaderCalls = 0
  globalThis.__capabilityLoaderPending = true
  globalThis.__capabilityLoaderAborted = 0
  globalThis.__capabilityLoaderVersion = 'late'
  const fixture = await createRuntime(capabilityEntry())
  context.after(async () => {
    await fixture.runtime.dispose()
    await rm(fixture.root, { recursive: true, force: true })
    delete globalThis.__capabilityLoaderCalls
    delete globalThis.__capabilityLoaderPending
    delete globalThis.__capabilityLoaderAborted
    delete globalThis.__capabilityLoaderVersion
    delete globalThis.__capabilityLoaderRelease
  })

  const loading = fixture.runtime.listCapabilityDeclarations()
  while (!globalThis.__capabilityLoaderRelease)
    await new Promise((resolve) => setImmediate(resolve))
  await fixture.runtime.dispose()
  assert.equal(globalThis.__capabilityLoaderAborted, 1)
  globalThis.__capabilityLoaderRelease()
  await assert.rejects(loading, /owner is no longer active|读取 fixture 能力选项失败/)
})

test('同一 Owner 重复 declareCapabilities 会在初始化时失败并清理', async (context) => {
  const fixture = await createRuntime(`export default {
  name: 'duplicate-capability-owner',
  setup(plugin) {
    plugin.declareCapabilities(async () => ({ agents: { label: '子代理', options: [] } }))
    plugin.declareCapabilities(async () => ({ agents: { label: '子代理', options: [] } }))
  }
}
`)
  context.after(async () => {
    await fixture.runtime.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  })

  await fixture.runtime.initialize()
  const diagnostic = fixture.runtime
    .readDiagnostics()
    .packages.find((item) => item.source.endsWith('/package') || item.source.endsWith('\\package'))
  assert.equal(diagnostic?.status, 'failed')
  assert.match(diagnostic?.error?.message ?? '', /能力声明已注册/)
  assert.deepEqual(await fixture.runtime.listCapabilityDeclarations(), {})
})
