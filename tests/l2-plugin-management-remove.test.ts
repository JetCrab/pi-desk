import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  nativeModules: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai'
  ],
  tsconfigPaths: resolve('tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})

test.before(async () => {
  const root = resolve('temp/pi/plugin-remove', `prepare-${randomUUID()}`, 'agent')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'sessions')
  await mkdir(root, { recursive: true })
  try {
    const entry = join(root, 'entry.mjs')
    await writeFile(entry, 'export default { name: "remove-prepare", setup() {} }\n')
    const { loadL4PiDeskPluginEntry } = await jiti.import<
      typeof import('../src/server/l4_foundation/pi/l4-pi-plugin-module-loader')
    >('../src/server/l4_foundation/pi/l4-pi-plugin-module-loader.ts')
    await loadL4PiDeskPluginEntry(entry, root)
    await jiti.import('../src/server/l4_foundation/pi/l4-pi-global-plugin-runtime.ts')
    await jiti.import('../src/server/l2_biz/plugin-management/l2-plugin-management.ts')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir
    await rm(dirname(root), { recursive: true, force: true })
  }
})

type Runtime =
  import('../src/server/l4_foundation/pi/l4-pi-global-plugin-runtime').L4PiGlobalPluginRuntime
type Management =
  import('../src/server/l2_biz/plugin-management/l2-plugin-management').L2PluginManagement
interface Fixture {
  root: string
  agentDir: string
  source: string
  runtime: Runtime
  management: Management
  cleanup: { count: number; started?: () => void; waiting?: Promise<void> }
  candidate: (directory: string, name: string, version: number) => Promise<void>
}

async function fixture(
  run: (input: Fixture) => Promise<void>,
  kind: 'extension' | 'package' = 'extension'
): Promise<void> {
  const root = resolve('temp/pi/plugin-remove', `remove-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const source =
    kind === 'extension' ? join(agentDir, 'extensions/old-entry') : join(root, 'local-package')
  const key = `__removeFixture${randomUUID().replaceAll('-', '')}`
  const cleanup: Fixture['cleanup'] = { count: 0 }
  const globals = ['__piDeskGlobalPluginRuntime', '__piDeskHostSettingsStore', key]
  const previousGlobals = new Map(globals.map((name) => [name, Reflect.get(globalThis, name)]))
  const env = ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_DESK_SAFE_MODE']
  const previousEnv = new Map(env.map((name) => [name, process.env[name]]))
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  delete process.env.PI_DESK_SAFE_MODE
  Reflect.set(globalThis, key, cleanup)
  Reflect.deleteProperty(globalThis, '__piDeskHostSettingsStore')
  const candidate: Fixture['candidate'] = async (directory, name, version) => {
    await mkdir(join(directory, 'browser'), { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        type: 'module',
        pi: { extensions: [] },
        piDesk: { entry: './entry.mjs' }
      })
    )
    await writeFile(join(directory, 'browser/entry.js'), 'export default () => undefined\n')
    await writeFile(
      join(directory, 'entry.mjs'),
      `export default {
      name: ${JSON.stringify(name)},
      setup(plugin) {
        plugin.registerMethod('get', async () => ({ version: ${version} }))
        plugin.registerBrowserEntry('./browser/entry.js')
        return async () => {
          const state = globalThis[${JSON.stringify(key)}]
          state.started?.()
          await state.waiting
          state.count += 1
        }
      }
    }\n`
    )
  }
  let runtime: Runtime | undefined
  let management: Management | undefined
  let succeeded = false
  try {
    await candidate(source, 'remove-workflow', 1)
    await candidate(join(agentDir, 'extensions/unrelated'), 'remove-unrelated', 9)
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ packages: kind === 'package' ? [source] : [] })
    )
    await writeFile(join(agentDir, 'workflow-config.json'), '{"keep":"business"}')
    const runtimeModule = await jiti.import<
      typeof import('../src/server/l4_foundation/pi/l4-pi-global-plugin-runtime')
    >('../src/server/l4_foundation/pi/l4-pi-global-plugin-runtime.ts')
    const managementModule = await jiti.import<
      typeof import('../src/server/l2_biz/plugin-management/l2-plugin-management')
    >('../src/server/l2_biz/plugin-management/l2-plugin-management.ts')
    runtime = new runtimeModule.L4PiGlobalPluginRuntime(root, agentDir)
    Reflect.set(globalThis, '__piDeskGlobalPluginRuntime', runtime)
    await runtime.initialize()
    management = new managementModule.L2PluginManagement(
      { runPluginRestart: (operation) => operation() },
      root,
      agentDir
    )
    await run({ root, agentDir, source, runtime, management, cleanup, candidate })
    succeeded = true
  } finally {
    management?.dispose()
    if (management) await Reflect.get(management, 'operationTail')
    await runtime?.dispose()
    for (const [name, value] of previousGlobals) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name)
      else Reflect.set(globalThis, name, value)
    }
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (succeeded) await rm(root, { recursive: true, force: true })
    else console.error('插件卸载测试现场：' + root)
  }
}

test('本地扩展卸载等待清理再删文件，其他实例和业务配置保持', { timeout: 30_000 }, async () => {
  await fixture(async ({ agentDir, source, runtime, management, cleanup }) => {
    let started!: () => void
    let release!: () => void
    const cleaning = new Promise<void>((done) => {
      started = done
    })
    cleanup.started = started
    cleanup.waiting = new Promise<void>((done) => {
      release = done
    })
    try {
      await management.del(source)
      await cleaning
      await access(source)
      await assert.rejects(runtime.invoke('remove-workflow', 'get', {}), /not found/i)
      assert.deepEqual(await runtime.invoke('remove-unrelated', 'get', {}), { version: 9 })
    } finally {
      release()
    }
    await management.waitForOperations([source], new AbortController().signal)
    await assert.rejects(access(source), { code: 'ENOENT' })
    assert.equal(cleanup.count, 1)
    assert.ok((await management.list()).plugins.every((item) => item.source !== source))
    assert.equal(
      await readFile(join(agentDir, 'workflow-config.json'), 'utf8'),
      '{"keep":"business"}'
    )
  })
})

test('目录已删的旧来源仍可按名称卸载，并接续加载同名包', { timeout: 60_000 }, async () => {
  await fixture(async ({ root, agentDir, source, runtime, management, candidate }) => {
    await rm(source, { recursive: true })
    const old = (await management.list()).plugins.find((item) => item.source === source)
    assert.equal(old?.kind, 'extension')
    assert.equal(old?.pluginName, 'remove-workflow')
    assert.match(String(old?.error?.message), /来源已移除/)
    const { executeL2PluginCommand } = await jiti.import<
      typeof import('../src/server/l2_biz/plugin-management/l2-plugin-commands')
    >('../src/server/l2_biz/plugin-management/l2-plugin-commands.ts')
    let notify!: (message: string) => void
    const notification = new Promise<string>((done) => {
      notify = done
    })
    const accepted = await executeL2PluginCommand(
      { kind: 'plugins', action: 'remove', name: 'remove-workflow' },
      {
        cwd: root,
        signal: new AbortController().signal,
        notify: async (message) => {
          notify(message)
        }
      },
      management,
      agentDir
    )
    assert.equal(accepted.mode, 'async')
    assert.match(await notification, /成功：已卸载/)
    await assert.rejects(runtime.invoke('remove-workflow', 'get', {}), /not found/i)
    assert.ok((await management.list()).plugins.every((item) => item.source !== source))
    const next = join(root, 'next-package')
    await candidate(next, 'remove-workflow', 2)
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [next] }))
    await management.apply([next])
    await management.waitForOperations([next], new AbortController().signal)
    assert.deepEqual(await runtime.invoke('remove-workflow', 'get', {}), { version: 2 })
    assert.deepEqual(await runtime.invoke('remove-unrelated', 'get', {}), { version: 9 })
    assert.equal(
      (await management.list()).plugins.find((item) => item.source === next)?.kind,
      'package'
    )
  })
})

test('包声明已移除时 remove 只清理残留实例，不删除本地包源码', { timeout: 30_000 }, async () => {
  await fixture(async ({ agentDir, source, runtime, management }) => {
    await writeFile(join(agentDir, 'settings.json'), '{"packages":[]}')
    assert.equal(
      (await management.list()).plugins.find((item) => item.source === source)?.kind,
      'package'
    )
    await management.del(source)
    await management.waitForOperations([source], new AbortController().signal)
    await access(source)
    await assert.rejects(runtime.invoke('remove-workflow', 'get', {}), /not found/i)
    assert.ok((await management.list()).plugins.every((item) => item.source !== source))
  }, 'package')
})
