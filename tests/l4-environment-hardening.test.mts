import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { terminateManagedTree } from '../src/server/l4_foundation/process/l4-process-tree.js'
import test from 'node:test'
import { createJiti } from 'jiti'
import type { SecretStore } from '@jetcrab/pi-desk-sdk/secrets'
import type {
  L4EnvironmentFile,
  L4EnvironmentManifest
} from '../src/server/l4_foundation/environment/l4-environment-manifest.ts'

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
const { L4EnvironmentManifestSchema } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-manifest.ts')
>('../src/server/l4_foundation/environment/l4-environment-manifest.ts')
const { L4EnvironmentPackageDeclarationSchema } = await jiti.import<
  typeof import('../src/common/l4_foundation/environment/l4-environment-file-contract.ts')
>('../src/common/l4_foundation/environment/l4-environment-file-contract.ts')
const { withConfigTransaction } = await jiti.import<
  typeof import('../plugins/pi-desk-sdk/src/config.ts')
>('../plugins/pi-desk-sdk/src/config.ts')
const { collectL4Environment } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-collect.ts')
>('../src/server/l4_foundation/environment/l4-environment-collect.ts')
const { writeEnvironmentArchive, readEnvironmentArchive } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-archive.ts')
>('../src/server/l4_foundation/environment/l4-environment-archive.ts')
const { inspectL4EnvironmentArchive, applyL4EnvironmentImport, planL4EnvironmentImport } =
  await jiti.import<
    typeof import('../src/server/l4_foundation/environment/l4-environment-import.ts')
  >('../src/server/l4_foundation/environment/l4-environment-import.ts')
const {
  applyL4EnvironmentTransaction,
  recoverL4EnvironmentBeforeRuntime,
  getL4EnvironmentOperationRoot
} = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-maintenance.ts')
>('../src/server/l4_foundation/environment/l4-environment-maintenance.ts')
const { pinL4EnvironmentGitSource } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-packages.ts')
>('../src/server/l4_foundation/environment/l4-environment-packages.ts')
const { initializeL2Environment, L2EnvironmentOperations } = await jiti.import<
  typeof import('../src/server/l2_biz/environment/l2-environment.ts')
>('../src/server/l2_biz/environment/l2-environment.ts')
const password = 'test-only-hardening-password'

function memoryStore(): SecretStore {
  const values = new Map<string, string>()
  return {
    async get(ref) {
      return values.get(ref) ?? null
    },
    async put(value, ref = `secret://${randomUUID()}`) {
      values.set(ref, value)
      return ref
    },
    async delete(ref) {
      values.delete(ref)
    },
    async export(refs) {
      return Object.fromEntries(
        refs.map((ref) => {
          const value = values.get(ref)
          if (value === undefined) throw new Error('test reference absent')
          return [ref, value]
        })
      )
    },
    async import(input) {
      const mapping: Record<string, string> = {}
      for (const [ref, value] of Object.entries(input)) {
        const next = `secret://${randomUUID()}`
        values.set(next, value)
        mapping[ref] = next
      }
      return mapping
    }
  }
}
async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const base = resolve('temp/run/environment-backup')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'hardening-'))
  try {
    await run(root)
  } catch (error) {
    console.error('[环境测试] 失败现场', { path: root })
    throw error
  }
  await rm(root, { recursive: true, force: true })
}
async function archivedFiles(path: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>()
  await readEnvironmentArchive({
    archivePath: path,
    password,
    async consumeEntry(header, content) {
      const chunks: Buffer[] = []
      for await (const chunk of content) chunks.push(chunk)
      entries.set(header.path, Buffer.concat(chunks))
    }
  })
  return entries
}

function operation(id: string): object {
  return {
    id,
    kind: 'import',
    status: 'running',
    phase: 'applying-offline',
    error: null,
    warnings: [],
    expiresAt: Date.now() + 3600000
  }
}

test('最新环境包要求完整字段且静态声明严格限定当前合同', () => {
  const manifest = {
    version: 1,
    sourcePlatform: 'linux',
    sourceAgentDir: '/fixture/agent',
    files: [],
    workSessions: [],
    packages: [],
    warnings: []
  }
  assert.equal(L4EnvironmentManifestSchema.safeParse(manifest).success, false)
  assert.equal(L4EnvironmentManifestSchema.safeParse({ ...manifest, pinnedCount: 0 }).success, true)
  const file = { base: 'config', path: 'current.json', format: 'json', secretPaths: [] }
  assert.equal(L4EnvironmentPackageDeclarationSchema.safeParse({ files: [file] }).success, true)
  assert.equal(
    L4EnvironmentPackageDeclarationSchema.safeParse({ files: [{ ...file, legacy: [] }] }).success,
    false
  )
})

test('原生分类排除机器状态和未登记根配置，项目声明优先于资源泛扫', async () => {
  await fixture(async (root) => {
    const agent = join(root, 'agent')
    const project = join(root, 'project')
    const pkg = join(root, 'package')
    const store = memoryStore()
    const tokenRef = await store.put('test-only-plugin-token')
    await put(join(pkg, 'package.json'), {
      name: 'test-classification',
      version: '1.0.0',
      piDesk: {
        environment: {
          files: [
            { base: 'project', path: 'config/tool.json', format: 'json', secretPaths: ['/token'] }
          ]
        }
      }
    })
    await put(join(pkg, 'src/index.ts'), 'export const fixture = true')
    await put(join(pkg, 'node_modules/ignored/index.js'), 'runtime dependency')
    await put(join(agent, 'settings.json'), { packages: [pkg] })
    await put(join(agent, 'models-store.json'), { derived: true })
    await put(join(agent, 'trust.json'), { [project]: true })
    await put(join(agent, 'tapd.json'), { customLocal: '/unchanged', flag: true })
    await put(join(agent, 'keybindings.json'), { 'test.command': ['ctrl+x'] })
    await put(join(agent, 'mcp-auth.json'), { fixture: { accessToken: 'test-only-native-token' } })
    await put(join(agent, 'AGENTS.override.md'), 'global instruction')
    await put(join(project, 'CLAUDE.md'), 'project instruction')
    await put(join(project, '.pi/config/tool.json'), { token: tokenRef })
    await put(join(project, '.pi/mcp.json'), { mcpServers: {} })
    await put(join(project, 'mcp.json'), { mcpServers: {} })
    await put(join(project, '.pi/prompts/task.md'), 'prompt content')
    await put(join(project, '.pi/runtime/process.json'), { pid: 10 })
    const external = join(root, 'external-skills/demo')
    await put(join(external, 'SKILL.md'), '# fixture')
    await put(join(external, 'assets/example.txt'), 'supporting asset')
    await put(join(project, '.pi/settings.json'), {
      skills: [join(root, 'external-skills/*/SKILL.md').replaceAll('\\', '/')]
    })
    const collection = await collectL4Environment({
      agentDir: agent,
      cwd: project,
      includeSessions: false,
      includePluginData: false,
      store
    })
    const paths = collection.manifest.files.map((file) => file.path)
    assert.equal(paths.includes('models-store.json'), false)
    assert.equal(paths.includes('trust.json'), false)
    for (const name of ['keybindings.json', 'mcp-auth.json', 'AGENTS.override.md'])
      assert.ok(paths.includes(name), name)
    assert.equal(paths.includes('tapd.json'), false)
    assert.ok(collection.manifest.warnings.some((warning) => warning.includes('未登记根目录文件')))
    assert.ok(
      collection.manifest.files.some((file) => file.sourcePath === join(project, '.pi/mcp.json'))
    )
    assert.ok(
      collection.manifest.files.some((file) => file.sourcePath === join(project, 'mcp.json'))
    )
    assert.ok(
      collection.manifest.files.some(
        (file) => file.sourcePath === join(external, 'assets/example.txt')
      )
    )
    assert.ok(
      collection.manifest.files.some((file) => file.sourcePath === join(pkg, 'src/index.ts'))
    )
    assert.equal(
      collection.manifest.files.some((file) => file.sourcePath.includes('node_modules/ignored')),
      false
    )
    assert.equal(
      collection.manifest.files.some((file) => file.path.includes('runtime/process')),
      false
    )
    assert.equal(collection.manifest.packages[0]?.localPath, pkg)
    const declared = collection.manifest.files.find(
      (file) => file.sourcePath === join(project, '.pi/config/tool.json')
    )!
    assert.deepEqual(declared.secretPaths, ['/token'])
    assert.ok(declared.secretEntry)
    assert.match(declared.title, /project.*\.pi/)
    const archive = join(root, 'snapshot.enc')
    await writeEnvironmentArchive({ outputPath: archive, password, entries: collection.entries() })
    const entries = await archivedFiles(archive)
    const stored = JSON.parse(entries.get(declared.entry)!.toString()) as { token: string }
    assert.match(stored.token, /^secret:\/\//)
    assert.equal(
      entries.get(declared.entry)!.includes(Buffer.from('test-only-plugin-token')),
      false
    )
    await put(join(agent, 'tapd.json'), { unknownReference: `secret://${randomUUID()}` })
    const skipped = await collectL4Environment({
      agentDir: agent,
      cwd: project,
      includeSessions: false,
      includePluginData: false,
      store: memoryStore()
    })
    assert.equal(
      skipped.manifest.files.some((file) => file.path === 'tapd.json'),
      false
    )
    assert.match(await readFile(join(agent, 'tapd.json'), 'utf8'), /secret:\/\//)
  })
})

test('原生隐式HOME资源在绑定AgentDir下完整收集并使用隔离HOME', async () => {
  await fixture(async (root) => {
    const agent = join(root, 'agent')
    const home = join(root, 'home')
    const saved = { home: process.env.HOME, dir: process.env.PI_CODING_AGENT_DIR }
    process.env.HOME = home
    process.env.PI_CODING_AGENT_DIR = agent
    try {
      await put(join(agent, 'settings.json'), { packages: [] })
      const skill = join(home, '.agents/skills/demo/SKILL.md')
      const asset = join(home, '.agents/skills/demo/assets/file.txt')
      await put(skill, '# implicit fixture')
      await put(asset, 'implicit asset')
      const collection = await collectL4Environment({
        agentDir: agent,
        cwd: root,
        includeSessions: false,
        includePluginData: false,
        store: memoryStore()
      })
      assert.ok(collection.manifest.files.some((file) => file.sourcePath === skill))
      assert.ok(collection.manifest.files.some((file) => file.sourcePath === asset))
    } finally {
      if (saved.home === undefined) delete process.env.HOME
      else process.env.HOME = saved.home
      if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = saved.dir
    }
  })
})

test('binary目录声明递归恢复配套脚本并拒绝结构化目录和字段规则', async () => {
  await fixture(async (root) => {
    const agent = join(root, 'agent')
    const project = join(root, 'project')
    const target = join(root, 'target')
    const targetProject = join(root, 'target-project')
    const pkg = join(root, 'package')
    const entry = { base: 'project', path: 'companion-scripts', format: 'binary' }
    const metadata = (file: object): object => ({
      name: 'test-directory-resource',
      version: '1.0.0',
      piDesk: { environment: { files: [file] } }
    })
    await put(join(pkg, 'package.json'), metadata(entry))
    await put(join(agent, 'settings.json'), { packages: [pkg] })
    await mkdir(targetProject, { recursive: true })
    const script = join(project, '.pi/companion-scripts/nested/provision.mjs')
    const code = 'export default async function fixture() { return { ok: true } }\n'
    await put(script, code)
    await put(join(project, '.pi/companion-scripts/cache/ignored.json'), '{}')
    await put(join(project, '.pi/companion-scripts/node_modules/ignored/index.js'), 'ignored')
    const collection = await collectL4Environment({
      agentDir: agent,
      cwd: project,
      includeSessions: false,
      includePluginData: false,
      store: memoryStore()
    })
    const leaf = collection.manifest.files.find(
      (file) => file.path === 'companion-scripts/nested/provision.mjs'
    )!
    assert.ok(leaf)
    assert.equal(leaf.base, 'project')
    assert.equal(
      collection.manifest.files.some(
        (file) => file.path.includes('cache/ignored') || file.path.includes('node_modules/ignored')
      ),
      false
    )
    const archive = join(root, 'snapshot.enc')
    await writeEnvironmentArchive({ outputPath: archive, password, entries: collection.entries() })
    const preview = await inspectL4EnvironmentArchive({
      id: randomUUID(),
      archivePath: archive,
      password
    })
    await applyL4EnvironmentImport({
      directory: join(root, 'operation'),
      agentDir: target,
      archivePath: archive,
      password,
      manifest: preview.manifest,
      selection: {
        id: randomUUID(),
        selectedIds: [leaf.id],
        mappings: [{ from: project, to: targetProject }],
        overwrite: false
      },
      rollbackStore: memoryStore()
    })
    assert.equal(
      await readFile(join(targetProject, '.pi/companion-scripts/nested/provision.mjs'), 'utf8'),
      code
    )
    for (const format of ['json', 'yaml']) {
      await put(join(pkg, 'package.json'), metadata({ ...entry, format }))
      await assert.rejects(
        collectL4Environment({
          agentDir: agent,
          cwd: project,
          includeSessions: false,
          includePluginData: false,
          store: memoryStore()
        }),
        /目录声明只支持binary/
      )
    }
    for (const field of ['localPaths', 'secretPaths']) {
      await put(join(pkg, 'package.json'), metadata({ ...entry, [field]: ['/unsupported'] }))
      await assert.rejects(
        collectL4Environment({
          agentDir: agent,
          cwd: project,
          includeSessions: false,
          includePluginData: false,
          store: memoryStore()
        }),
        /二进制文件不能声明/
      )
    }
  })
})

test('伪造包不能覆盖原生状态、vault、签名key或缓存', async () => {
  await fixture(async (root) => {
    const file: L4EnvironmentFile = {
      id: 'forged',
      entry: 'files/forged',
      title: 'forged',
      category: 'config',
      base: 'agent',
      path: 'trust.json',
      sourcePath: join(root, 'source/trust.json'),
      bytes: 2,
      format: 'json',
      localPaths: [],
      mappingSources: [],
      omitPaths: [],
      secretPaths: [],
      sourceCwd: null,
      sessionId: null,
      children: [],
      warnings: [],
      secretEntry: null
    }
    for (const path of [
      'trust.json',
      'models-store.json',
      'pi-desk/auth-session-key',
      'config/credentials.enc',
      'config/CREDENTIALS.ENC',
      'config/desktop-environment.transaction.json',
      'cache/data.json'
    ]) {
      const manifest: L4EnvironmentManifest = {
        version: 1,
        sourcePlatform:
          process.platform === 'win32'
            ? 'win32'
            : process.platform === 'darwin'
              ? 'darwin'
              : 'linux',
        sourceAgentDir: join(root, 'source'),
        files: [{ ...file, path }],
        workSessions: [],
        pinnedCount: 0,
        packages: [],
        warnings: []
      }
      const outputPath = join(root, `${randomUUID()}.enc`)
      await writeEnvironmentArchive({
        outputPath,
        password,
        entries: (async function* () {
          for (const [path, data] of [
            ['manifest.json', Buffer.from(JSON.stringify(manifest))],
            ['files/forged', Buffer.from('{}')]
          ] as const)
            yield {
              path,
              size: data.length,
              content: (async function* () {
                yield data
              })()
            }
        })()
      })
      await assert.rejects(
        inspectL4EnvironmentArchive({ id: randomUUID(), archivePath: outputPath, password }),
        undefined,
        path
      )
    }
  })
})

test('归档只读取最新配置位置且不转换或删除未登记根文件', async () => {
  await fixture(async (root) => {
    const agent = join(root, 'agent')
    const pkg = join(root, 'package')
    const store = memoryStore()
    const ref = await store.put('test-only-current-secret')
    await put(join(pkg, 'package.json'), {
      name: 'test-current-format',
      version: '1.0.0',
      piDesk: {
        environment: {
          files: [{ base: 'config', path: 'current.json', format: 'json', secretPaths: ['/token'] }]
        }
      }
    })
    await put(join(agent, 'settings.json'), { packages: [pkg], unknownNativeField: 'preserved' })
    await put(join(agent, 'old.json'), '{unparseable-old-file')
    const original = await readFile(join(agent, 'old.json'))
    const before = await collectL4Environment({
      agentDir: agent,
      cwd: root,
      includeSessions: false,
      includePluginData: false,
      store
    })
    assert.equal(
      before.manifest.files.some((file) => file.path === 'config/current.json'),
      false
    )
    assert.equal(
      before.manifest.files.some((file) => file.path === 'old.json'),
      false
    )
    await put(join(agent, 'config/current.json'), { token: 'test-only-unprepared-plain' })
    await assert.rejects(
      collectL4Environment({
        agentDir: agent,
        cwd: root,
        includeSessions: false,
        includePluginData: false,
        store
      }),
      /必须为凭据引用/
    )
    assert.equal(
      JSON.parse(await readFile(join(agent, 'config/current.json'), 'utf8')).token,
      'test-only-unprepared-plain'
    )
    await put(join(agent, 'config/current.json'), { token: ref, retained: 'current-extra' })
    const current = await readFile(join(agent, 'config/current.json'))
    const native = await readFile(join(agent, 'settings.json'))
    const collection = await collectL4Environment({
      agentDir: agent,
      cwd: root,
      includeSessions: false,
      includePluginData: false,
      store
    })
    const archive = join(root, 'snapshot.enc')
    await writeEnvironmentArchive({ outputPath: archive, password, entries: collection.entries() })
    const entries = await archivedFiles(archive)
    const config = collection.manifest.files.find((file) => file.path === 'config/current.json')!
    assert.equal(JSON.parse(entries.get(config.entry)!.toString()).token, ref)
    assert.ok(config.secretEntry)
    assert.equal(
      collection.manifest.files.some((file) => file.path === 'old.json'),
      false
    )
    assert.deepEqual(await readFile(join(agent, 'old.json')), original)
    assert.deepEqual(await readFile(join(agent, 'config/current.json')), current)
    assert.deepEqual(await readFile(join(agent, 'settings.json')), native)
  })
})

test('L1注入的异步busy守卫拒绝时不排定重启且下一次空闲可接纳', async () => {
  await fixture(async (root) => {
    const saved = {
      dir: process.env.PI_CODING_AGENT_DIR,
      home: process.env.HOME,
      sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
      operations: globalThis.__piDeskEnvironmentOperations,
      restart: globalThis.__piDeskEnvironmentRestart,
      handler: globalThis.__piDeskRestartHandler
    }
    process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
    process.env.HOME = join(root, 'home')
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'agent/sessions')
    globalThis.__piDeskEnvironmentOperations = undefined
    let busy = true
    let closed = 0
    let notify!: () => void
    const restarted = new Promise<void>((resolveRestart) => {
      notify = resolveRestart
    })
    globalThis.__piDeskRestartHandler = () => {
      closed++
      notify()
    }
    initializeL2Environment({
      runPluginRestart: async (operation) => {
        if (busy) throw new Error('fixture busy')
        return operation()
      }
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await assert.rejects(
        L2EnvironmentOperations.export({
          password,
          includeSessions: false,
          includePluginData: false
        }),
        /fixture busy/
      )
      assert.equal(closed, 0)
      busy = false
      const result = await L2EnvironmentOperations.export({
        password,
        includeSessions: false,
        includePluginData: false
      })
      await Promise.race([
        restarted,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('restart not delivered')), 3000)
        })
      ])
      assert.equal(closed, 1)
      assert.equal((await L2EnvironmentOperations.get(result.id)).status, 'pending')
    } finally {
      clearTimeout(timeout)
      globalThis.__piDeskEnvironmentOperations = saved.operations
      globalThis.__piDeskEnvironmentRestart = saved.restart
      globalThis.__piDeskRestartHandler = saved.handler
      if (saved.home === undefined) delete process.env.HOME
      else process.env.HOME = saved.home
      if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = saved.dir
      if (saved.sessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = saved.sessions
    }
  })
})

test('committed清理失败/崩溃只清理不回滚，无journal中断明确unknown', async () => {
  await fixture(async (root) => {
    const agent = join(root, 'agent')
    const id = randomUUID()
    const directory = join(getL4EnvironmentOperationRoot(agent), id)
    const target = join(agent, 'config/selected.json')
    await put(target, { value: 'before' })
    await put(join(directory, 'operation.json'), operation(id))
    const store = memoryStore()
    const remove = store.delete
    let failCleanup = true
    store.delete = async (ref) => {
      if (failCleanup) {
        failCleanup = false
        throw new Error('injected cleanup')
      }
      return remove(ref)
    }
    const warnings = await applyL4EnvironmentTransaction({
      directory,
      agentDir: agent,
      targets: [target],
      lockTargets: [target],
      store,
      async apply() {
        await put(target, { value: 'committed' })
      }
    })
    assert.ok(warnings.length)
    assert.equal(
      JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8')).state,
      'committed'
    )
    assert.equal(
      JSON.parse(await readFile(join(directory, 'operation.json'), 'utf8')).status,
      'completed'
    )
    await put(join(directory, 'operation.json'), operation(id))
    await recoverL4EnvironmentBeforeRuntime(agent, store)
    assert.equal(JSON.parse(await readFile(target, 'utf8')).value, 'committed')
    const completed = JSON.parse(await readFile(join(directory, 'operation.json'), 'utf8')) as {
      status: string
      phase: string
      error: string | null
    }
    assert.equal(completed.status, 'completed')
    assert.equal(completed.phase, 'import-files-committed')
    assert.equal(completed.error, null)
    await assert.rejects(readFile(join(directory, 'journal.json')), { code: 'ENOENT' })
    const unknownId = randomUUID()
    const unknown = join(getL4EnvironmentOperationRoot(agent), unknownId, 'operation.json')
    await put(unknown, operation(unknownId))
    await recoverL4EnvironmentBeforeRuntime(agent, store)
    const result = JSON.parse(await readFile(unknown, 'utf8')) as { phase: string; error: string }
    assert.equal(result.phase, 'interrupted-unknown')
    assert.doesNotMatch(result.error, /已恢复/)
    const rollbackId = randomUUID()
    const rollbackDirectory = join(getL4EnvironmentOperationRoot(agent), rollbackId)
    await put(join(rollbackDirectory, 'operation.json'), operation(rollbackId))
    const beforeRollback = await readFile(target)
    await assert.rejects(
      applyL4EnvironmentTransaction({
        directory: rollbackDirectory,
        agentDir: agent,
        targets: [target, join(root, 'absent/deep/resource.bin')],
        lockTargets: [target],
        store,
        async apply() {
          await put(target, { value: 'partial' })
          throw new Error('injected before resource mkdir')
        }
      }),
      /injected before resource/
    )
    assert.deepEqual(await readFile(target), beforeRollback)
    assert.equal(
      JSON.parse(await readFile(join(rollbackDirectory, 'operation.json'), 'utf8')).phase,
      'import-rolled-back'
    )
    const pendingId = randomUUID()
    const pendingDirectory = join(getL4EnvironmentOperationRoot(agent), pendingId)
    await put(join(pendingDirectory, 'operation.json'), operation(pendingId))
    await put(join(pendingDirectory, 'journal.json'), {
      state: 'host-restored',
      keyReference: `secret://${randomUUID()}`,
      locks: [target],
      externalPending: true,
      desktopProcessUnreleased: true,
      desktopOperation: { agentDir: agent, operationId: pendingId },
      files: [{ target, backup: 'rollback/0.enc' }]
    })
    await withConfigTransaction(target, () => put(target, { value: 'later-cooperative-write' }))
    await assert.rejects(recoverL4EnvironmentBeforeRuntime(agent, store), /尚未尝试 cancel/)
    assert.equal(JSON.parse(await readFile(target, 'utf8')).value, 'later-cooperative-write')
  })
})

test('子会话保留subagents位置，空目标恢复所选pins并复用同Pi不同Desk绑定', async () => {
  await fixture(async (root) => {
    const source = join(root, 'source')
    const target = join(root, 'target')
    const sourceCwd = join(root, 'source-project')
    const targetCwd = join(root, 'target-project')
    await mkdir(sourceCwd)
    await mkdir(targetCwd)
    const parent = join(source, 'sessions/source/parent.jsonl')
    const child = join(source, 'sessions/source/subagents/parent-id/child.jsonl')
    const fork = join(source, 'sessions/source/fork.jsonl')
    await put(join(source, 'settings.json'), { packages: [] })
    await put(join(source, 'pi-desk/work-sessions.json'), {
      pinnedCount: 2,
      workSessions: [
        { workId: 'source-parent', cwd: sourceCwd, sessionId: 'parent-id' },
        { workId: 'source-fork', cwd: sourceCwd, sessionId: 'fork-id' }
      ]
    })
    await put(
      parent,
      [
        { type: 'session', id: 'parent-id', cwd: sourceCwd },
        { type: 'session_info', id: 'name', name: '会话可读标题' },
        { type: 'message', id: 'u', message: { role: 'user', content: '原始正文保持' } },
        {
          type: 'message',
          id: 't',
          message: { role: 'toolResult', toolName: 'agent', details: { sessionFile: child } }
        }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n'
    )
    await put(
      child,
      JSON.stringify({ type: 'session', id: 'child-id', cwd: sourceCwd, parentSession: parent }) +
        '\n'
    )
    await put(
      fork,
      JSON.stringify({ type: 'session', id: 'fork-id', cwd: sourceCwd, parentSession: parent }) +
        '\n' +
        JSON.stringify({
          type: 'message',
          id: 'fork-user',
          message: { role: 'user', content: '普通fork首条用户文本' }
        }) +
        '\n'
    )
    const collection = await collectL4Environment({
      agentDir: source,
      cwd: sourceCwd,
      includeSessions: true,
      includePluginData: false,
      store: memoryStore()
    })
    const archive = join(root, 'snapshot.enc')
    await writeEnvironmentArchive({ outputPath: archive, password, entries: collection.entries() })
    const preview = await inspectL4EnvironmentArchive({
      id: randomUUID(),
      archivePath: archive,
      password
    })
    assert.equal(preview.summary.items.filter((item) => item.category === 'session').length, 2)
    const item = preview.summary.items.find((item) => item.sessionId === 'parent-id')!
    assert.equal(item.title, '会话可读标题')
    assert.equal(
      preview.summary.items.find((item) => item.sessionId === 'fork-id')!.title,
      '普通fork首条用户文本'
    )
    const selection = {
      id: randomUUID(),
      selectedIds: [item.id],
      mappings: [{ from: sourceCwd, to: targetCwd }],
      overwrite: false
    }
    const plan = await planL4EnvironmentImport({
      agentDir: target,
      archivePath: archive,
      password,
      manifest: preview.manifest,
      selection
    })
    const plannedChild = plan.files.find(({ file }) => file.sessionId === 'child-id')!
    assert.match(plannedChild.target.replaceAll('\\', '/'), /\/subagents\/parent-id\/child\.jsonl$/)
    await applyL4EnvironmentImport({
      directory: join(root, 'operation'),
      agentDir: target,
      archivePath: archive,
      password,
      manifest: preview.manifest,
      selection,
      rollbackStore: memoryStore()
    })
    const bindingsPath = join(target, 'pi-desk/work-sessions.json')
    const bindings = JSON.parse(await readFile(bindingsPath, 'utf8')) as {
      pinnedCount: number
      workSessions: { workId: string; cwd: string; sessionId: string }[]
    }
    assert.equal(bindings.pinnedCount, 1)
    assert.equal(bindings.workSessions.length, 1)
    bindings.workSessions[0]!.workId = 'target-display-id'
    await put(bindingsPath, bindings)
    await applyL4EnvironmentImport({
      directory: join(root, 'operation-reuse'),
      agentDir: target,
      archivePath: archive,
      password,
      manifest: preview.manifest,
      selection,
      rollbackStore: memoryStore()
    })
    assert.equal(
      JSON.parse(await readFile(bindingsPath, 'utf8')).workSessions[0].workId,
      'target-display-id'
    )
    const plannedParent = plan.files.find(({ file }) => file.sessionId === 'parent-id')!
    const original = await readFile(plannedParent.target, 'utf8')
    await writeFile(
      plannedParent.target,
      original +
        JSON.stringify({
          type: 'message',
          id: 'different',
          message: { role: 'user', content: 'different history' }
        }) +
        '\n'
    )
    await assert.rejects(
      planL4EnvironmentImport({
        agentDir: target,
        archivePath: archive,
        password,
        manifest: preview.manifest,
        selection: { ...selection, overwrite: true }
      }),
      /已有不同内容/
    )
  })
})

test(
  '隔离官方manager安装入口通过stdin接受本地来源且不修改包声明',
  { timeout: 20000 },
  async (context) => {
    await fixture(async (root) => {
      const agent = join(root, 'agent')
      const pkg = join(root, 'package')
      await put(join(agent, 'settings.json'), { packages: [] })
      await put(join(pkg, 'package.json'), { name: 'test-offline-install', version: '1.0.0' })
      const original = await readFile(join(agent, 'settings.json'))
      const result = await new Promise<{ code: number | null; stderr: string }>(
        (resolveExit, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              pathToFileURL(resolve('src/server/l4_foundation/pi/l4-pi-runtime-register.mjs')).href,
              '--import',
              'tsx',
              resolve('src/server/l4_foundation/environment/l4-environment-package-install.mts')
            ],
            {
              env: {
                ...process.env,
                HOME: join(root, 'home'),
                PI_CODING_AGENT_DIR: agent,
                PI_CODING_AGENT_SESSION_DIR: join(agent, 'sessions'),
                PI_DESK_PI_PACKAGE_DIR: resolve('node_modules/@earendil-works/pi-coding-agent'),
                PI_OFFLINE: '1'
              },
              stdio: ['pipe', 'ignore', 'pipe'],
              windowsHide: true,
              detached: process.platform !== 'win32'
            }
          )
          context.after(() => terminateManagedTree(child))
          let stderr = ''
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
          })
          child.once('error', reject)
          child.once('close', (code) => resolveExit({ code, stderr }))
          child.stdin.end(
            JSON.stringify({ source: pkg, cwd: root, agentDir: agent, project: false })
          )
        }
      )
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(await readFile(join(agent, 'settings.json')), original)
    })
  }
)

test('Git恢复固定实际提交，不把branch或SSH身份误当版本', () => {
  const sha = '1234567890abcdef1234567890abcdef12345678'
  assert.equal(
    pinL4EnvironmentGitSource('git:github.com/example/package@feature/old', sha),
    `git:github.com/example/package@${sha}`
  )
  assert.equal(
    pinL4EnvironmentGitSource('git:git@example.org:team/package@branch', sha),
    `git:git@example.org:team/package@${sha}`
  )
  assert.equal(
    pinL4EnvironmentGitSource('https://example.org/team/package#old-tag', sha),
    `https://example.org/team/package@${sha}`
  )
  assert.throws(() => pinL4EnvironmentGitSource('git:example.org/team/package', 'main'))
})
