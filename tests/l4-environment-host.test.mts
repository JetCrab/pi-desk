import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import test, { mock } from 'node:test'
import type { SecretStore } from '@jetcrab/pi-desk-sdk/secrets'
import { createJiti } from 'jiti'
const jiti = createJiti(import.meta.url, {
  nativeModules: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai'
  ],
  tsconfigPaths: resolve('tsconfig.json')
})
const { createSecretStore } = await jiti.import<
  typeof import('../plugins/pi-desk-sdk/src/secrets.ts')
>('../plugins/pi-desk-sdk/src/secrets.ts')
const { L2EnvironmentPackageSchema } = await jiti.import<
  typeof import('../src/common/l2_biz/environment/l2-environment-contract.ts')
>('../src/common/l2_biz/environment/l2-environment-contract.ts')
const { transformL4EnvironmentConfig } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-config.ts')
>('../src/server/l4_foundation/environment/l4-environment-config.ts')
const { collectL4Environment } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-collect.ts')
>('../src/server/l4_foundation/environment/l4-environment-collect.ts')
const { writeEnvironmentArchive } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-archive.ts')
>('../src/server/l4_foundation/environment/l4-environment-archive.ts')
const { inspectL4EnvironmentArchive, applyL4EnvironmentImport, planL4EnvironmentImport } =
  await jiti.import<
    typeof import('../src/server/l4_foundation/environment/l4-environment-import.ts')
  >('../src/server/l4_foundation/environment/l4-environment-import.ts')
const {
  applyL4EnvironmentTransaction,
  getL4EnvironmentOperationRoot,
  recoverL4EnvironmentBeforeRuntime,
  recoverL4EnvironmentTransaction
} = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-maintenance.ts')
>('../src/server/l4_foundation/environment/l4-environment-maintenance.ts')
const {
  canL4EnvironmentDesktop,
  exportL4EnvironmentDesktop,
  L4EnvironmentNativeProcessUnreleasedError
} = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-desktop.ts')
>('../src/server/l4_foundation/environment/l4-environment-desktop.ts')
const { L4EnvironmentOperations } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-operations.ts')
>('../src/server/l4_foundation/environment/l4-environment-operations.ts')

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const base = resolve('temp/run/environment-backup')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'host-contract-'))
  let success = false
  try {
    await run(root)
    success = true
  } finally {
    if (success) await rm(root, { recursive: true, force: true })
  }
}

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
      return Object.fromEntries(refs.map((ref) => [ref, values.get(ref)!]))
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

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

const password = 'test-only-environment-password'

test('离线导入登录配置生成目标签名材料，且不改变原生 Pi 认证', async () => {
  await fixture(async (root) => {
    const source = join(root, 'source')
    const target = join(root, 'target')
    const passwordHash = `scrypt:${'11'.repeat(16)}:${'22'.repeat(64)}`
    await json(join(source, 'config/pi-desk-auth.json'), { passwordHash })
    await json(join(target, 'auth.json'), { native: 'test-only-native-auth' })
    const nativeBefore = await readFile(join(target, 'auth.json'))
    const collection = await collectL4Environment({
      agentDir: source,
      cwd: root,
      includeSessions: false,
      includePluginData: false,
      store: memoryStore()
    })
    const archive = join(root, 'auth.enc')
    await writeEnvironmentArchive({ outputPath: archive, password, entries: collection.entries() })
    const { manifest } = await inspectL4EnvironmentArchive({
      id: randomUUID(),
      archivePath: archive,
      password
    })
    const item = manifest.files.find((file) => file.path === 'config/pi-desk-auth.json')!
    await applyL4EnvironmentImport({
      directory: join(root, 'operation'),
      agentDir: target,
      archivePath: archive,
      password,
      manifest,
      selection: { id: randomUUID(), selectedIds: [item.id], mappings: [], overwrite: false },
      rollbackStore: memoryStore()
    })
    assert.deepEqual(JSON.parse(await readFile(join(target, 'config/pi-desk-auth.json'), 'utf8')), {
      passwordHash
    })
    assert.match(
      await readFile(join(target, 'pi-desk/auth-session-key'), 'utf8'),
      /^[a-f0-9]{64}\n$/
    )
    assert.deepEqual(await readFile(join(target, 'auth.json')), nativeBefore)
  })
})

test('导入回滚不恢复整份旧保险库，保留未选配置及后来写入的凭据', async () => {
  await fixture(async (root) => {
    const source = join(root, 'source')
    const target = join(root, 'target')
    const packageRoot = join(root, 'test-package')
    await json(join(packageRoot, 'package.json'), {
      name: 'test-rollback-secrets',
      version: '1.0.0',
      piDesk: {
        environment: {
          files: [{ base: 'config', path: 'secret.json', format: 'json', secretPaths: ['/key'] }]
        }
      }
    })
    const keyProvider = async (): Promise<Uint8Array> => Buffer.alloc(32, 9)
    const sourceStore = createSecretStore({ agentDir: source, keyProvider })
    const targetStore = createSecretStore({ agentDir: target, keyProvider })
    const sourceRef = await sourceStore.put('test-only-imported-secret')
    const oldRef = await targetStore.put('test-only-kept-secret')
    await json(join(source, 'settings.json'), { packages: [packageRoot] })
    await json(join(source, 'config/secret.json'), { key: sourceRef })
    await json(join(source, 'config/pi-desk-auth.json'), {
      passwordHash: `scrypt:${'11'.repeat(16)}:${'22'.repeat(64)}`
    })
    await json(join(target, 'config/secret.json'), { key: oldRef })
    await mkdir(join(target, 'pi-desk'), { recursive: true })
    await writeFile(join(target, 'pi-desk/auth-session-key'), 'invalid-existing-key')
    const before = await readFile(join(target, 'config/secret.json'))
    const collection = await collectL4Environment({
      agentDir: source,
      cwd: root,
      includeSessions: false,
      includePluginData: false,
      store: sourceStore
    })
    const archive = join(root, 'rollback.enc')
    await writeEnvironmentArchive({ outputPath: archive, password, entries: collection.entries() })
    const { manifest } = await inspectL4EnvironmentArchive({
      id: randomUUID(),
      archivePath: archive,
      password
    })
    let concurrentRef = ''
    const interleavedStore: SecretStore = {
      ...targetStore,
      async import(values) {
        const mapping = await targetStore.import(values)
        concurrentRef = await targetStore.put('test-only-independent-secret')
        return mapping
      }
    }
    await assert.rejects(
      applyL4EnvironmentImport({
        directory: join(root, 'operation'),
        agentDir: target,
        archivePath: archive,
        password,
        manifest,
        selection: {
          id: randomUUID(),
          selectedIds: manifest.files
            .filter((file) =>
              ['config/secret.json', 'config/pi-desk-auth.json'].includes(file.path)
            )
            .map((file) => file.id),
          mappings: [],
          overwrite: true
        },
        targetStore: interleavedStore,
        rollbackStore: memoryStore()
      }),
      /登录保护配置/
    )
    assert.ok(concurrentRef)
    assert.equal(await targetStore.get(concurrentRef), 'test-only-independent-secret')
    assert.equal(await targetStore.get(oldRef), 'test-only-kept-secret')
    assert.deepEqual(await readFile(join(target, 'config/secret.json')), before)
    assert.equal(
      await readFile(join(target, 'pi-desk/auth-session-key'), 'utf8'),
      'invalid-existing-key'
    )
    await assert.rejects(readFile(join(target, 'config/pi-desk-auth.json')), { code: 'ENOENT' })
  })
})

test('静态包清单与声明字段映射保留相对路径、远端字段和任意程序参数', () => {
  assert.equal(
    L2EnvironmentPackageSchema.safeParse({
      files: [
        {
          base: 'project',
          path: 'tasks.yaml',
          format: 'yaml',
          localPaths: ['/tasks/*/copy/*/from']
        }
      ]
    }).success,
    true
  )
  const content = Buffer.from(
    '{\n // Keep comment\n "relative": "src/file", "absolute": "C:/work/src", "remotePath": "C:/work/remote", "program":"C:/work/tool", "args":["C:/work/a"]\n}'
  )
  const result = transformL4EnvironmentConfig({
    content,
    file: { format: 'json', localPaths: ['/relative', '/absolute'], omitPaths: [] },
    mappings: [{ source: 'C:/work', target: '/srv/work' }],
    sourcePlatform: 'win32',
    targetPlatform: 'posix'
  }).toString()
  assert.match(result, /Keep comment/)
  const data = JSON.parse(result.replace('// Keep comment', '')) as Record<string, unknown>
  assert.equal(data.relative, 'src/file')
  assert.equal(data.absolute, '/srv/work/src')
  assert.equal(data.remotePath, 'C:/work/remote')
  assert.equal(data.program, 'C:/work/tool')
  assert.deepEqual(data.args, ['C:/work/a'])
  const relative = Buffer.from('handler: ./scripts/run.sh\ncopy:\n  from: ../deliverable/file\n')
  assert.deepEqual(
    transformL4EnvironmentConfig({
      content: relative,
      file: { format: 'yaml', localPaths: ['/handler', '/copy/from'], omitPaths: [] },
      mappings: [],
      sourcePlatform: 'posix',
      targetPlatform: 'win32'
    }),
    relative
  )
})

test('维护提交中失败恢复全部已写原件并移除新文件，回滚备份不含明文秘密', async () => {
  await fixture(async (root) => {
    const original = join(root, 'target', 'auth.json')
    const added = join(root, 'target', 'new.json')
    await json(original, { token: 'test-only-native-secret' })
    const before = await readFile(original)
    const directory = join(root, 'operation')
    await assert.rejects(
      applyL4EnvironmentTransaction({
        directory,
        agentDir: join(root, 'agent'),
        store: memoryStore(),
        targets: [original, added],
        async apply() {
          assert.equal(
            (await readFile(join(directory, 'rollback/0.enc'))).includes(
              Buffer.from('test-only-native-secret')
            ),
            false
          )
          await writeFile(original, 'changed')
          await writeFile(added, 'new')
          throw new Error('injected write failure')
        }
      }),
      /injected write failure/
    )
    assert.deepEqual(await readFile(original), before)
    await assert.rejects(readFile(added), { code: 'ENOENT' })
    await assert.rejects(readFile(join(directory, 'journal.json')), { code: 'ENOENT' })
  })
})

test('原stage进程树未确认释放时恢复host但不提前cancel或启动Runtime', async () => {
  await fixture(async (root) => {
    const target = join(root, 'original.json')
    await writeFile(target, 'original-content')
    const directory = join(root, 'operation')
    await assert.rejects(
      applyL4EnvironmentTransaction({
        directory,
        agentDir: join(root, 'agent'),
        targets: [target],
        store: memoryStore(),
        async apply() {
          await writeFile(target, 'changed-content')
        },
        desktop: {
          operationId: randomUUID(),
          async stage() {
            throw new L4EnvironmentNativeProcessUnreleasedError()
          }
        }
      }),
      /尚未尝试 cancel/
    )
    assert.equal(await readFile(target, 'utf8'), 'original-content')
    assert.equal(
      JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8')).desktopProcessUnreleased,
      true
    )
  })
})

test('维护进程崩溃后，下一次启动恢复journal原件再允许创建Runtime', async () => {
  await fixture(async (root) => {
    const target = join(root, 'original.json')
    await writeFile(target, 'original-byte-content')
    const directory = join(root, 'operation')
    const storeDir = join(root, 'rollback-store')
    const maintenanceUrl = pathToFileURL(
      resolve('src/server/l4_foundation/environment/l4-environment-maintenance.ts')
    ).href
    const script = `import { createJiti } from 'jiti';
      const jiti=createJiti(import.meta.url,{nativeModules:['@earendil-works/pi-coding-agent','@earendil-works/pi-agent-core','@earendil-works/pi-ai'],tsconfigPaths:${JSON.stringify(resolve('tsconfig.json'))}});
      const { createSecretStore } = await jiti.import(${JSON.stringify(pathToFileURL(resolve('plugins/pi-desk-sdk/src/secrets.ts')).href)});
      const { applyL4EnvironmentTransaction } = await jiti.import(${JSON.stringify(maintenanceUrl)});
      import { writeFile } from 'node:fs/promises';
      await applyL4EnvironmentTransaction({ directory: ${JSON.stringify(directory)}, agentDir: ${JSON.stringify(root)},
        store: createSecretStore({agentDir:${JSON.stringify(storeDir)}, keyProvider:async()=>Buffer.alloc(32,7)}),
        targets:[${JSON.stringify(target)}],async apply(){await writeFile(${JSON.stringify(target)},'partial-write');process.exit(23)} });`
    const code = await new Promise<number | null>((resolveExit, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { stdio: 'pipe', windowsHide: true }
      )
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.once('error', reject)
      child.once('close', (code) =>
        code === 23
          ? resolveExit(code)
          : reject(new Error(stderr || `Unexpected child exit ${code}`))
      )
    })
    assert.equal(code, 23)
    assert.equal(await readFile(target, 'utf8'), 'partial-write')
    await recoverL4EnvironmentTransaction(
      directory,
      createSecretStore({ agentDir: storeDir, keyProvider: async () => Buffer.alloc(32, 7) })
    )
    assert.equal(await readFile(target, 'utf8'), 'original-byte-content')
    await assert.rejects(readFile(join(directory, 'journal.json')), { code: 'ENOENT' })
  })
})

test('回滚失败保留journal且启动恢复拒绝继续创建Runtime', async () => {
  await fixture(async (root) => {
    const agentDir = join(root, 'agent')
    const directory = join(getL4EnvironmentOperationRoot(agentDir), randomUUID())
    await json(join(directory, 'journal.json'), {
      state: 'prepared',
      keyReference: `secret://${randomUUID()}`,
      locks: [],
      files: []
    })
    await assert.rejects(recoverL4EnvironmentBeforeRuntime(agentDir, memoryStore()), /拒绝启动/)
    assert.match(await readFile(join(directory, 'journal.json'), 'utf8'), /prepared/)
  })
})

test('流式上传独立限额、错误密码拒绝且不支持重启不假报导出完成', async () => {
  await fixture(async (root) => {
    const operations = new L4EnvironmentOperations({
      agentDir: join(root, 'agent'),
      cwd: root,
      canRestart: () => false,
      schedule: () => {
        throw new Error('must not schedule')
      },
      uploadLimit: 16
    })
    await assert.rejects(
      operations.export({ password, includePluginData: true, includeSessions: true }),
      /不支持/
    )
    await assert.rejects(
      operations.upload(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.alloc(17))
            controller.close()
          }
        })
      ),
      /容量限制/
    )
    const uploaded = await operations.upload(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('not-an-archive'))
          controller.close()
        }
      })
    )
    await assert.rejects(operations.preview(uploaded.id, password))
    assert.equal((await operations.get(uploaded.id)).status, 'ready')
    await operations.cancel(uploaded.id)
    await assert.rejects(operations.get(uploaded.id), { code: 'ENOENT' })
  })
})

test('配置选择与纯会话导入隔离，父会话递归包含孩子，Pi正文和ID保持', async () => {
  await fixture(async (root) => {
    const source = join(root, 'source')
    const target = join(root, 'target')
    const sourceProject = join(root, 'source-project')
    const targetProject = join(root, 'target-project')
    await mkdir(sourceProject, { recursive: true })
    await mkdir(targetProject, { recursive: true })
    const parentPath = join(source, 'sessions/project/parent.jsonl')
    const childPath = join(source, 'sessions/project/child.jsonl')
    await json(join(source, 'settings.json'), { packages: [], shellPath: 'old-machine-shell' })
    await json(join(source, 'config/custom.json'), {
      keep: 'source-config',
      unknownPath: sourceProject
    })
    await json(join(source, 'pi-desk/work-sessions.json'), {
      workSessions: [{ workId: 'imported-work', cwd: sourceProject, sessionId: 'parent-id' }],
      pinnedCount: 1
    })
    const body =
      JSON.stringify({
        type: 'message',
        id: 'entry-1',
        message: { role: 'user', content: `Literal path ${sourceProject}` }
      }) + '\r\n'
    await mkdir(resolve(parentPath, '..'), { recursive: true })
    await writeFile(
      parentPath,
      JSON.stringify({ type: 'session', id: 'parent-id', cwd: sourceProject }) +
        '\r\n' +
        JSON.stringify({
          type: 'message',
          id: 'tool-entry',
          message: { role: 'toolResult', toolName: 'agent', details: { sessionFile: childPath } }
        }) +
        '\r\n' +
        body
    )
    await writeFile(
      childPath,
      JSON.stringify({
        type: 'session',
        id: 'child-id',
        cwd: sourceProject,
        parentSession: parentPath
      }) + '\n'
    )
    await writeFile(
      join(source, 'sessions/project/fork.jsonl'),
      JSON.stringify({
        type: 'session',
        id: 'fork-id',
        cwd: sourceProject,
        parentSession: parentPath
      }) + '\n'
    )
    await json(join(target, 'config/custom.json'), { keep: 'target-config' })
    await json(join(target, 'pi-desk/work-sessions.json'), {
      workSessions: [{ workId: 'existing-work', cwd: targetProject, sessionId: 'existing-id' }],
      pinnedCount: 1
    })
    const archive = join(root, 'backup.enc')
    const collection = await collectL4Environment({
      agentDir: source,
      cwd: sourceProject,
      includeSessions: true,
      includePluginData: false,
      store: memoryStore()
    })
    await writeEnvironmentArchive({ outputPath: archive, password, entries: collection.entries() })
    await assert.rejects(
      inspectL4EnvironmentArchive({
        id: randomUUID(),
        archivePath: archive,
        password: 'wrong-password'
      })
    )
    const inspected = await inspectL4EnvironmentArchive({
      id: randomUUID(),
      archivePath: archive,
      password
    })
    assert.equal(inspected.summary.items.filter((item) => item.category === 'session').length, 2)
    assert.equal(inspected.summary.items.find((item) => item.sessionId === 'parent-id')!.files, 2)
    assert.equal(
      inspected.summary.items.some((item) => item.sessionId === 'child-id'),
      false
    )
    const parent = inspected.manifest.files.find((file) => file.sessionId === 'parent-id')!
    const config = inspected.manifest.files.find((file) => file.path === 'config/custom.json')!
    const selection = {
      id: randomUUID(),
      selectedIds: [parent.id],
      mappings: [{ from: sourceProject, to: targetProject }],
      overwrite: false
    }
    const plan = await planL4EnvironmentImport({
      agentDir: target,
      archivePath: archive,
      password,
      manifest: inspected.manifest,
      selection
    })
    assert.equal(plan.files.length, 2)
    const configBefore = await readFile(join(target, 'config/custom.json'))
    await applyL4EnvironmentImport({
      directory: join(root, 'session-operation'),
      agentDir: target,
      archivePath: archive,
      password,
      manifest: inspected.manifest,
      selection,
      rollbackStore: memoryStore()
    })
    assert.deepEqual(await readFile(join(target, 'config/custom.json')), configBefore)
    await assert.rejects(readFile(join(target, 'config/credentials.enc')), { code: 'ENOENT' })
    const importedParent = await readFile(
      plan.files.find(({ file }) => file.sessionId === 'parent-id')!.target,
      'utf8'
    )
    assert.ok(importedParent.endsWith(body))
    const header = JSON.parse(importedParent.split('\r\n')[0]!) as { id: string; cwd: string }
    assert.equal(header.id, 'parent-id')
    assert.equal(header.cwd, targetProject)
    const bindings = JSON.parse(
      await readFile(join(target, 'pi-desk/work-sessions.json'), 'utf8')
    ) as { workSessions: { workId: string }[]; pinnedCount: number }
    assert.equal(bindings.pinnedCount, 1)
    assert.deepEqual(
      bindings.workSessions.map((item) => item.workId),
      ['existing-work', 'imported-work']
    )
    const sessionBefore = importedParent
    await applyL4EnvironmentImport({
      directory: join(root, 'config-operation'),
      agentDir: target,
      archivePath: archive,
      password,
      manifest: inspected.manifest,
      selection: { ...selection, selectedIds: [config.id], overwrite: true },
      rollbackStore: memoryStore()
    })
    assert.deepEqual(
      await readFile(join(target, 'config/custom.json')),
      await readFile(join(source, 'config/custom.json'))
    )
    assert.equal(
      await readFile(plan.files.find(({ file }) => file.sessionId === 'parent-id')!.target, 'utf8'),
      sessionBefore
    )
  })
})

test('现代静态声明按最新位置收集，项目敏感值经加密包恢复为新引用', async () => {
  await fixture(async (root) => {
    const source = join(root, 'source')
    const target = join(root, 'target')
    const sourceProject = join(root, 'source-project')
    const targetProject = join(root, 'target-project')
    const packageRoot = join(root, 'installed-test-package')
    const sourceStore = memoryStore()
    const projectRef = await sourceStore.put('test-only-project-secret')
    await mkdir(sourceProject)
    await mkdir(targetProject)
    await json(join(packageRoot, 'package.json'), {
      name: 'test-environment-package',
      version: '1.2.3',
      piDesk: {
        environment: {
          files: [
            {
              base: 'config',
              path: 'plugin.json',
              format: 'json',
              secretPaths: []
            },
            {
              base: 'config',
              path: 'plugin-agents.json',
              format: 'json',
              secretPaths: []
            },
            {
              base: 'project',
              path: 'test-hosts.yaml',
              format: 'yaml',
              secretPaths: ['/hosts/*/password'],
              localPaths: ['/handler']
            }
          ]
        }
      }
    })
    await json(join(source, 'settings.json'), {
      packages: [packageRoot],
      pluginAgents: { analyst: { model: 'test-model' } },
      nativeFlag: true
    })
    await json(join(source, 'config/plugin.json'), { current: 'current-value' })
    await json(join(source, 'config/plugin-agents.json'), {
      agents: { analyst: { model: 'test-model' } }
    })
    const sourceConfig = `handler: ./scripts/run.sh\nhosts:\n  demo:\n    password: ${projectRef}\n    remotePath: /remote/data\n`
    await mkdir(join(sourceProject, '.pi'))
    await writeFile(join(sourceProject, '.pi/test-hosts.yaml'), sourceConfig)
    const collection = await collectL4Environment({
      agentDir: source,
      cwd: sourceProject,
      includeSessions: false,
      includePluginData: false,
      store: sourceStore
    })
    assert.equal(
      collection.manifest.files.some((file) => file.path === 'config/plugin.json'),
      true
    )
    assert.equal(
      collection.manifest.files.some((file) => file.path === 'config/plugin-agents.json'),
      true
    )
    const archive = join(root, 'backup.enc')
    await writeEnvironmentArchive({ outputPath: archive, password, entries: collection.entries() })
    assert.equal((await readFile(archive)).includes(Buffer.from('test-only-project-secret')), false)
    assert.equal(
      JSON.parse(await readFile(join(source, 'config/plugin.json'), 'utf8')).current,
      'current-value'
    )
    assert.equal(await readFile(join(sourceProject, '.pi/test-hosts.yaml'), 'utf8'), sourceConfig)
    const inspected = await inspectL4EnvironmentArchive({
      id: randomUUID(),
      archivePath: archive,
      password
    })
    const projectFile = inspected.manifest.files.find((file) => file.base === 'project')!
    const targetStore = createSecretStore({
      agentDir: target,
      keyProvider: async () => Buffer.alloc(32, 8)
    })
    await applyL4EnvironmentImport({
      directory: join(root, 'operation'),
      agentDir: target,
      archivePath: archive,
      password,
      manifest: inspected.manifest,
      selection: {
        id: randomUUID(),
        selectedIds: [projectFile.id],
        mappings: [{ from: sourceProject, to: targetProject }],
        overwrite: false
      },
      targetStore,
      rollbackStore: memoryStore()
    })
    const imported = await readFile(join(targetProject, '.pi/test-hosts.yaml'), 'utf8')
    assert.equal(imported.includes('test-only-project-secret'), false)
    const reference = imported.match(/secret:\/\/[0-9a-f-]{36}/)?.[0]
    assert.ok(reference)
    assert.equal(await targetStore.get(reference), 'test-only-project-secret')
    assert.match(imported, /handler: \.\/scripts\/run.sh/)
    assert.match(imported, /remotePath: \/remote\/data/)
    await assert.rejects(readFile(join(target, 'config/plugin.json')), { code: 'ENOENT' })
  })
})

test('导入仅重建所选配置引用且保留目标未选凭据', async () => {
  await fixture(async (root) => {
    const source = join(root, 'source')
    const target = join(root, 'target')
    const keyProvider = async (): Promise<Uint8Array> => Buffer.alloc(32, 7)
    const sourceStore = createSecretStore({ agentDir: source, keyProvider })
    const targetStore = createSecretStore({ agentDir: target, keyProvider })
    const sourceRef = await sourceStore.put('test-only-source-secret')
    const keptRef = await targetStore.put('test-only-target-secret')
    const packageRoot = join(root, 'installed-test-package')
    await json(join(packageRoot, 'package.json'), {
      name: 'test-secret-declaration',
      version: '1.0.0',
      piDesk: {
        environment: {
          files: [
            { base: 'config', path: 'plugin.json', format: 'json', secretPaths: ['/credential'] }
          ]
        }
      }
    })
    await json(join(source, 'settings.json'), { packages: [packageRoot] })
    await json(join(source, 'config/plugin.json'), {
      credential: sourceRef,
      ordinaryText: sourceRef
    })
    await json(join(target, 'config/unselected.json'), { credential: keptRef })
    const collection = await collectL4Environment({
      agentDir: source,
      cwd: root,
      includeSessions: false,
      includePluginData: false,
      store: sourceStore
    })
    const archive = join(root, 'backup.enc')
    await writeEnvironmentArchive({ outputPath: archive, password, entries: collection.entries() })
    const { manifest } = await inspectL4EnvironmentArchive({
      id: randomUUID(),
      archivePath: archive,
      password
    })
    const file = manifest.files.find((file) => file.path === 'config/plugin.json')!
    await applyL4EnvironmentImport({
      directory: join(root, 'operation'),
      agentDir: target,
      archivePath: archive,
      password,
      manifest,
      selection: { id: randomUUID(), selectedIds: [file.id], mappings: [], overwrite: false },
      targetStore,
      rollbackStore: memoryStore()
    })
    const imported = JSON.parse(await readFile(join(target, 'config/plugin.json'), 'utf8')) as {
      credential: string
      ordinaryText: string
    }
    assert.equal(imported.ordinaryText, sourceRef)
    assert.notEqual(imported.credential, sourceRef)
    assert.equal(await targetStore.get(imported.credential), 'test-only-source-secret')
    assert.equal(await targetStore.get(keptRef), 'test-only-target-secret')
    assert.equal((await readFile(archive)).includes(Buffer.from('test-only-source-secret')), false)
  })
})

test('映射后预览复用加密暂存，真实相同内容不报冲突且确认仍读取原归档', async () => {
  await fixture(async (root) => {
    const source = join(root, 'source')
    const target = join(root, 'target')
    const sourceProject = join(root, 'source-project')
    const targetProject = join(root, 'target-project')
    await mkdir(sourceProject)
    await mkdir(targetProject)
    await json(join(source, 'config/local.json'), { directory: sourceProject })
    await json(join(target, 'config/local.json'), { directory: targetProject })
    const collection = await collectL4Environment({
      agentDir: source,
      cwd: root,
      includeSessions: false,
      includePluginData: false,
      store: memoryStore()
    })
    const file = collection.manifest.files.find((file) => file.path === 'config/local.json')!
    file.localPaths = ['/directory']
    file.mappingSources = [sourceProject]
    const archive = join(root, 'backup.enc')
    await writeEnvironmentArchive({ outputPath: archive, password, entries: collection.entries() })
    const operations = new L4EnvironmentOperations({
      agentDir: target,
      cwd: root,
      canRestart: () => true,
      schedule: () => {
        throw new Error('must not submit missing archive')
      }
    })
    const { id } = await operations.upload(
      Readable.toWeb(createReadStream(archive)) as ReadableStream<Uint8Array>
    )
    const first = await operations.preview(id, password)
    const item = first.items.find((item) => item.id === file.id)!
    assert.deepEqual(item.mappingSources, [sourceProject])
    assert.notEqual(item.conflicts.length, 0)
    await rename(join(operations.directory(id), 'archive.enc'), join(root, 'moved.enc'))
    const mapped = await operations.preview(id, password, [
      { from: sourceProject, to: targetProject }
    ])
    assert.deepEqual(mapped.items.find((item) => item.id === file.id)!.conflicts, [])
    await assert.rejects(
      operations.import({
        id,
        selectedIds: [file.id],
        mappings: [{ from: sourceProject, to: targetProject }],
        overwrite: false
      }),
      { code: 'ENOENT' }
    )
    await operations.cancel(id)
  })
})

test('native capability标记缺失不执行未知CLI，stage失败回滚host且不直接覆盖Rust配置', async () => {
  await fixture(async (root) => {
    const target = join(root, 'target')
    const configPath = join(target, 'config/desktop.json')
    const hostPath = join(target, 'config/selected.json')
    await json(configPath, { desktopVault: 'test-only-old-machine-ciphertext' })
    await json(hostPath, { value: 'original-host' })
    const previous = Object.fromEntries(
      [
        'PI_DESK_DESKTOP_ENVIRONMENT_VERSION',
        'PI_DESK_DESKTOP_EXECUTABLE',
        'PI_DESK_DESKTOP_CONFIG'
      ].map((key) => [key, process.env[key]])
    )
    process.env.PI_DESK_DESKTOP_EXECUTABLE = process.execPath
    process.env.PI_DESK_DESKTOP_CONFIG = configPath
    delete process.env.PI_DESK_DESKTOP_ENVIRONMENT_VERSION
    const platform =
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
    const portable = {
      version: 1,
      sourcePlatform: platform,
      config: { targets: [], tunnel: { controlKey: 'test-only-source-key' } },
      preferences: { hideOnOpen: true, showOnClose: true, autoStart: {} }
    }
    let pendingOperationId: string | null = null
    let rejectStage = true
    let cancelAllowed = true
    const calls: { flag: string; input: string }[] = []
    const mocked = mock.method(childProcess, 'spawn', (_command: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough
        stdout: PassThrough
        stderr: PassThrough
        exitCode: number | null
        signalCode: null
      }
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.exitCode = null
      child.signalCode = null
      let input = ''
      child.stdin.on('data', (chunk: Buffer) => {
        input += chunk.toString()
      })
      child.stdin.on('end', () => {
        calls.push({ flag: args[0]!, input })
        setImmediate(() => {
          if (args[0] === '--environment-export') {
            child.stdout.end(
              JSON.stringify({
                ...portable,
                config: { ...portable.config, tunnel: { controlKey: 'test-only-target-key' } }
              })
            )
            child.exitCode = 0
          } else if (args[0] === '--environment-stage') {
            pendingOperationId = (JSON.parse(input) as { operationId: string }).operationId
            child.stdout.end(
              rejectStage
                ? ''
                : JSON.stringify({ restartRequired: true, operationId: pendingOperationId })
            )
            child.exitCode = rejectStage ? 1 : 0
          } else {
            const operationId = (JSON.parse(input) as { operationId: string }).operationId
            child.stdout.end(
              JSON.stringify({ cancelled: cancelAllowed && operationId === pendingOperationId })
            )
            pendingOperationId = null
            child.exitCode = 0
          }
          child.stderr.end()
          child.emit('close', child.exitCode)
        })
      })
      return child as unknown as childProcess.ChildProcess
    })
    syncBuiltinESMExports()
    try {
      assert.equal(canL4EnvironmentDesktop(target), false)
      await assert.rejects(exportL4EnvironmentDesktop(target), /未声明/)
      assert.equal(calls.length, 0)
      process.env.PI_DESK_DESKTOP_ENVIRONMENT_VERSION = '1'
      const fileBase = {
        category: 'config',
        sourceCwd: null,
        sessionId: null,
        children: [],
        localPaths: [],
        mappingSources: [],
        omitPaths: [],
        secretPaths: [],
        warnings: [],
        secretEntry: null
      }
      const host = Buffer.from('{"value":"imported-host"}')
      const desktop = Buffer.from(JSON.stringify(portable))
      const manifest = {
        version: 1,
        sourcePlatform:
          process.platform === 'win32'
            ? 'win32'
            : process.platform === 'darwin'
              ? 'darwin'
              : 'linux',
        sourceAgentDir: join(root, 'source'),
        files: [
          {
            ...fileBase,
            id: 'host',
            entry: 'files/host',
            title: 'Host',
            base: 'agent',
            path: 'config/selected.json',
            sourcePath: join(root, 'source/config/selected.json'),
            bytes: host.length,
            format: 'json'
          },
          {
            ...fileBase,
            id: 'desktop',
            entry: 'files/desktop',
            title: 'Desktop',
            base: 'desktop',
            path: 'desktop.portable.json',
            sourcePath: join(root, 'source/config/desktop.json'),
            bytes: desktop.length,
            format: 'binary'
          }
        ],
        workSessions: [],
        pinnedCount: 0,
        packages: [],
        warnings: []
      }
      const archive = join(root, 'backup.enc')
      await writeEnvironmentArchive({
        outputPath: archive,
        password,
        entries: (async function* () {
          for (const [path, data] of [
            ['manifest.json', Buffer.from(JSON.stringify(manifest))],
            ['files/host', host],
            ['files/desktop', desktop]
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
      const inspected = await inspectL4EnvironmentArchive({
        id: randomUUID(),
        archivePath: archive,
        password
      })
      await assert.rejects(
        applyL4EnvironmentImport({
          directory: join(root, 'operation'),
          agentDir: target,
          archivePath: archive,
          password,
          manifest: inspected.manifest,
          selection: {
            id: randomUUID(),
            selectedIds: ['host', 'desktop'],
            mappings: [],
            overwrite: true
          },
          rollbackStore: memoryStore()
        }),
        /桌面环境操作失败/
      )
      assert.equal(JSON.parse(await readFile(hostPath, 'utf8')).value, 'original-host')
      assert.equal(
        JSON.parse(await readFile(configPath, 'utf8')).desktopVault,
        'test-only-old-machine-ciphertext'
      )
      const stage = calls.find((call) => call.flag === '--environment-stage')!
      assert.equal(
        JSON.parse(stage.input).environment.config.tunnel.controlKey,
        'test-only-source-key'
      )
      assert.equal(calls.filter((call) => call.flag === '--environment-cancel').length, 1)
      assert.equal(pendingOperationId, null)
      rejectStage = false
      const warnings = await applyL4EnvironmentImport({
        directory: join(root, 'operation-success'),
        agentDir: target,
        archivePath: archive,
        password,
        manifest: inspected.manifest,
        selection: {
          id: randomUUID(),
          selectedIds: ['host', 'desktop'],
          mappings: [],
          overwrite: true
        },
        rollbackStore: memoryStore()
      })
      assert.equal(
        warnings.some((warning) => warning.startsWith('桌面配置已暂存')),
        true
      )
      assert.equal(JSON.parse(await readFile(hostPath, 'utf8')).value, 'imported-host')
      assert.equal(
        JSON.parse(await readFile(configPath, 'utf8')).desktopVault,
        'test-only-old-machine-ciphertext'
      )
      assert.ok(pendingOperationId)
      pendingOperationId = null
      rejectStage = true
      cancelAllowed = false
      const beforeUncertain = await readFile(hostPath)
      await assert.rejects(
        applyL4EnvironmentImport({
          directory: join(root, 'operation-uncertain'),
          agentDir: target,
          archivePath: archive,
          password,
          manifest: inspected.manifest,
          selection: {
            id: randomUUID(),
            selectedIds: ['host', 'desktop'],
            mappings: [],
            overwrite: true
          },
          rollbackStore: memoryStore()
        }),
        /cancelled=false/
      )
      assert.deepEqual(await readFile(hostPath), beforeUncertain)
      assert.equal(
        JSON.parse(await readFile(join(root, 'operation-uncertain/journal.json'), 'utf8'))
          .externalPending,
        true
      )
    } finally {
      mocked.mock.restore()
      syncBuiltinESMExports()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

test('提交后不可取消，密码不落operation，重连可按id读取状态', async () => {
  await fixture(async (root) => {
    let submitted = false
    const options = {
      agentDir: join(root, 'agent'),
      cwd: root,
      canRestart: () => true,
      schedule: () => {
        submitted = true
      }
    }
    const operations = new L4EnvironmentOperations(options)
    const { id } = await operations.export({
      password,
      includePluginData: false,
      includeSessions: false
    })
    assert.equal(submitted, true)
    assert.equal((await new L4EnvironmentOperations(options).get(id)).status, 'pending')
    assert.equal(
      (await readFile(join(operations.directory(id), 'operation.json'), 'utf8')).includes(password),
      false
    )
    await assert.rejects(operations.cancel(id), /不能取消/)
  })
})
