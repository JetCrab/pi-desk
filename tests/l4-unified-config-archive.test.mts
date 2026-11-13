import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createJiti } from 'jiti'
import { parse as parseYaml, parseDocument } from 'yaml'
import { bindConfigStore, getUnifiedConfigPath } from '../plugins/pi-desk-sdk/src/config-store.ts'
import { getProjectConfigPath, withConfigTransaction } from '../plugins/pi-desk-sdk/src/config.ts'

const jiti = createJiti(import.meta.url, {
  nativeModules: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai'
  ],
  tsconfigPaths: resolve('tsconfig.json')
})
const { collectL4Environment } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-collect.ts')
>('../src/server/l4_foundation/environment/l4-environment-collect.ts')
const { writeEnvironmentArchive } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-archive.ts')
>('../src/server/l4_foundation/environment/l4-environment-archive.ts')
const { inspectL4EnvironmentArchive, applyL4EnvironmentImport } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-import.ts')
>('../src/server/l4_foundation/environment/l4-environment-import.ts')
const { applyL4EnvironmentTransaction } = await jiti.import<
  typeof import('../src/server/l4_foundation/environment/l4-environment-maintenance.ts')
>('../src/server/l4_foundation/environment/l4-environment-maintenance.ts')
const { createSecretStore } = await jiti.import<
  typeof import('../plugins/pi-desk-sdk/src/secrets.ts')
>('../plugins/pi-desk-sdk/src/secrets.ts')

test('全局与项目统一 YAML 跨主密钥恢复，失败回滚且项目不触发登录恢复', async () => {
  const runs = resolve('temp/run/unified-config')
  await mkdir(runs, { recursive: true })
  const root = await mkdtemp(join(runs, 'archive-roundtrip-'))
  const previous = process.env.PI_DESK_SECRET_KEY_FILE
  let success = false
  try {
    const source = join(root, 'source')
    const target = join(root, 'target')
    const sourceCwd = join(root, 'source-project')
    const targetCwd = join(root, 'target-project')
    await mkdir(target)
    await mkdir(sourceCwd)
    await mkdir(targetCwd)
    const sourceKey = join(root, 'source.key')
    const targetKey = join(root, 'target.key')
    await writeFile(sourceKey, randomBytes(32))
    await writeFile(targetKey, randomBytes(32))
    process.env.PI_DESK_SECRET_KEY_FILE = sourceKey
    const config = bindConfigStore('plugins', 'example-plugin', { agentDir: source })
    const value = {
      servers: [
        {
          host: '192.0.2.1',
          username: 'fixture-user',
          port: 2222,
          enabled: true,
          credentials: { password: 'fixture-password' }
        }
      ]
    }
    await config.set(value, { encryptPaths: ['/servers/*/*'] })
    const projectValue = {
      servers: [{ host: '198.51.100.2', credentials: { password: 'fixture-project-password' } }],
      unknown: { 'a/b~c': [null, false, 7], directory: sourceCwd }
    }
    await config.set(projectValue, {
      cwd: sourceCwd,
      encryptPaths: ['/servers/*/credentials', '/unknown/a~1b~0c']
    })
    const projectAuth = { projectOnly: 'not-host-login' }
    await bindConfigStore('pi-desk', 'auth', { agentDir: source }).set(projectAuth, {
      cwd: sourceCwd
    })
    const projectPath = getProjectConfigPath(sourceCwd)
    const projectDocument = parseDocument(await readFile(projectPath, 'utf8'))
    projectDocument.set('unknown-root', { keep: true })
    await writeFile(projectPath, '# 项目未知配置与注释须保留\n' + projectDocument.toString())
    const projectBefore = await readFile(projectPath)
    const hash = `scrypt:${'11'.repeat(16)}:${'22'.repeat(64)}`
    await bindConfigStore('pi-desk', 'auth', { agentDir: source }).set({ passwordHash: hash })
    await bindConfigStore('pi-desk', 'ignored-directories', { agentDir: source }).set({
      directories: [sourceCwd]
    })
    const sourceBefore = await readFile(getUnifiedConfigPath(source))
    const legacy = join(target, 'legacy-config.json')
    await writeFile(legacy, 'keep-existing-legacy-bytes')
    const collection = await collectL4Environment({
      agentDir: source,
      cwd: sourceCwd,
      includeSessions: false,
      includePluginData: false
    })
    const archive = join(root, 'environment.enc')
    const password = 'fixture-archive-password'
    await writeEnvironmentArchive({ outputPath: archive, password, entries: collection.entries() })
    const { manifest } = await inspectL4EnvironmentArchive({
      id: randomUUID(),
      archivePath: archive,
      password
    })
    const item = manifest.files.find((file) => file.path === 'config/pi-desk.yaml')
    assert.ok(item?.secretEntry)
    const projects = manifest.files.filter(
      (file) => file.base === 'project' && file.path === 'pi-desk.yaml'
    )
    assert.equal(projects.length, 1)
    const project = projects[0]!
    assert.equal(project.sourceCwd, sourceCwd)
    assert.ok(project.secretEntry)
    assert.deepEqual(await readFile(projectPath), projectBefore)
    assert.deepEqual(await readFile(getUnifiedConfigPath(source)), sourceBefore)
    const archiveBytes = await readFile(archive)
    assert.equal(archiveBytes.includes(Buffer.from('fixture-project-password')), false)
    assert.equal(archiveBytes.includes(Buffer.from('fixture-password')), false)
    process.env.PI_DESK_SECRET_KEY_FILE = targetKey
    const restored = bindConfigStore('plugins', 'example-plugin', { agentDir: target })
    await restored.set({ existing: 'global' })
    await restored.set({ existing: 'project' }, { cwd: targetCwd })
    const targetBefore = await readFile(getUnifiedConfigPath(target))
    const targetProjectBefore = await readFile(getProjectConfigPath(targetCwd))
    const authKeyPath = join(target, 'pi-desk', 'auth-session-key')
    await mkdir(join(target, 'pi-desk'), { recursive: true })
    await writeFile(authKeyPath, 'invalid-existing-login-key')
    const importInput = {
      directory: join(root, 'operation'),
      agentDir: target,
      archivePath: archive,
      password,
      manifest,
      selection: {
        id: randomUUID(),
        selectedIds: [item.id, project.id],
        mappings: [{ from: sourceCwd, to: targetCwd }],
        overwrite: true
      },
      rollbackStore: createSecretStore({
        agentDir: join(root, 'rollback-agent'),
        keyProvider: async () => new Uint8Array(32).fill(9)
      })
    }
    await assert.rejects(applyL4EnvironmentImport(importInput), /登录保护配置无法读取/u)
    assert.deepEqual(await readFile(getUnifiedConfigPath(target)), targetBefore)
    assert.deepEqual(await readFile(getProjectConfigPath(targetCwd)), targetProjectBefore)
    assert.equal(await readFile(authKeyPath, 'utf8'), 'invalid-existing-login-key')
    await rm(authKeyPath)
    await applyL4EnvironmentImport(importInput)
    assert.deepEqual(await restored.get({ decryptPaths: ['/servers/*/*'] }), value)
    assert.deepEqual(
      await restored.get({
        cwd: targetCwd,
        decryptPaths: ['/servers/*/credentials', '/unknown/a~1b~0c']
      }),
      projectValue
    )
    assert.deepEqual(
      await bindConfigStore('pi-desk', 'ignored-directories', { agentDir: target }).get(),
      { directories: [targetCwd] }
    )
    assert.deepEqual(await readFile(projectPath), projectBefore)
    assert.deepEqual(await readFile(getUnifiedConfigPath(source)), sourceBefore)
    const restoredText = await readFile(getUnifiedConfigPath(target), 'utf8')
    assert.equal(restoredText.includes('fixture-password'), false)
    assert.equal(restoredText.includes('secret://'), false)
    assert.notEqual(restoredText, sourceBefore.toString('utf8'))
    const restoredProjectText = await readFile(getProjectConfigPath(targetCwd), 'utf8')
    assert.equal(restoredProjectText.includes('fixture-project-password'), false)
    assert.equal(restoredProjectText.includes('secret://'), false)
    assert.match(restoredProjectText, /^# 项目未知配置与注释须保留/u)
    assert.notEqual(restoredProjectText, projectBefore.toString('utf8'))
    assert.deepEqual(parseYaml(restoredProjectText)['unknown-root'], { keep: true })
    assert.deepEqual(parseYaml(restoredProjectText)['pi-desk'].auth, projectAuth)
    assert.equal(await readFile(legacy, 'utf8'), 'keep-existing-legacy-bytes')
    assert.match(
      await readFile(join(target, 'pi-desk', 'auth-session-key'), 'utf8'),
      /^[a-f0-9]{64}\n$/u
    )
    const projectOnlyAgent = join(root, 'project-only-agent')
    const projectOnlyCwd = join(root, 'project-only-cwd')
    await mkdir(projectOnlyAgent)
    await mkdir(projectOnlyCwd)
    await applyL4EnvironmentImport({
      ...importInput,
      directory: join(root, 'project-only-operation'),
      agentDir: projectOnlyAgent,
      selection: {
        id: randomUUID(),
        selectedIds: [project.id],
        mappings: [{ from: sourceCwd, to: projectOnlyCwd }],
        overwrite: false
      }
    })
    const projectOnlyStore = bindConfigStore('plugins', 'example-plugin', {
      agentDir: projectOnlyAgent
    })
    assert.deepEqual(await projectOnlyStore.get(), {})
    assert.deepEqual(
      await projectOnlyStore.get({
        cwd: projectOnlyCwd,
        decryptPaths: ['/servers/*/credentials', '/unknown/a~1b~0c']
      }),
      projectValue
    )
    await assert.rejects(readFile(join(projectOnlyAgent, 'pi-desk', 'auth-session-key')), {
      code: 'ENOENT'
    })
    success = true
  } finally {
    if (previous === undefined) delete process.env.PI_DESK_SECRET_KEY_FILE
    else process.env.PI_DESK_SECRET_KEY_FILE = previous
    if (success) await rm(root, { recursive: true, force: true })
    else console.error(`统一配置归档失败现场：${root}`)
  }
})

test('无登录保护的全局统一配置可恢复且不创建签名材料', async () => {
  const runs = resolve('temp/run/unified-config')
  await mkdir(runs, { recursive: true })
  const root = await mkdtemp(join(runs, 'archive-without-auth-'))
  let success = false
  try {
    const source = join(root, 'source')
    const target = join(root, 'target')
    const config = { settings: { enabled: true }, unknown: ['keep'] }
    await bindConfigStore('plugins', 'example-plugin', { agentDir: source }).set(config)
    const collection = await collectL4Environment({
      agentDir: source,
      cwd: root,
      includeSessions: false,
      includePluginData: false
    })
    const archivePath = join(root, 'environment.enc')
    const password = 'fixture-no-auth-password'
    await writeEnvironmentArchive({
      outputPath: archivePath,
      password,
      entries: collection.entries()
    })
    const { manifest } = await inspectL4EnvironmentArchive({
      id: randomUUID(),
      archivePath,
      password
    })
    const item = manifest.files.find((file) => file.path === 'config/pi-desk.yaml')!
    await applyL4EnvironmentImport({
      directory: join(root, 'operation'),
      agentDir: target,
      archivePath,
      password,
      manifest,
      selection: { id: randomUUID(), selectedIds: [item.id], mappings: [], overwrite: false },
      rollbackStore: createSecretStore({
        agentDir: join(root, 'rollback-agent'),
        keyProvider: async () => new Uint8Array(32).fill(5)
      })
    })
    assert.deepEqual(
      await bindConfigStore('plugins', 'example-plugin', { agentDir: target }).get(),
      config
    )
    await assert.rejects(readFile(join(target, 'pi-desk', 'auth-session-key')), { code: 'ENOENT' })
    success = true
  } finally {
    if (success) await rm(root, { recursive: true, force: true })
    else console.error(`无登录保护归档失败现场：${root}`)
  }
})

test('环境事务与项目配置操作竞争时不反向持有全局主密钥锁', async (t) => {
  const runs = resolve('temp/run/unified-config')
  await mkdir(runs, { recursive: true })
  const root = await mkdtemp(join(runs, 'project-lock-order-'))
  const agentDir = join(root, 'a-agent')
  const cwd = join(root, 'z-project')
  const globalPath = getUnifiedConfigPath(agentDir)
  await mkdir(join(agentDir, 'config'), { recursive: true })
  await mkdir(join(cwd, '.pi'), { recursive: true })
  const projectPath = getProjectConfigPath(cwd)
  await writeFile(globalPath, '{}\n')
  await writeFile(projectPath, '{}\n')
  const require = createRequire(new URL('../plugins/pi-desk-sdk/package.json', import.meta.url))
  const lockfile = require('proper-lockfile') as {
    lock: (path: string, ...args: unknown[]) => Promise<() => Promise<void>>
  }
  const originalLock = lockfile.lock
  const writerStarted = Promise.withResolvers<void>()
  const transactionStarted = Promise.withResolvers<void>()
  let observeTransaction = false
  // 只观察真实锁的竞争开始，不替换文件锁、重试或释放行为。
  t.mock.method(lockfile, 'lock', (path: string, ...args: unknown[]) => {
    if (observeTransaction && path === projectPath) {
      observeTransaction = false
      transactionStarted.resolve()
    }
    return originalLock(path, ...args)
  })
  const config = bindConfigStore('plugins', 'lock-fixture', {
    agentDir,
    keyProvider: async () => new Uint8Array(32).fill(3)
  })
  let success = false
  let writer: Promise<string> | undefined
  let transaction: Promise<string[]> | undefined
  try {
    writer = withConfigTransaction(projectPath, async () => {
      writerStarted.resolve()
      await transactionStarted.promise
      return config.encrypt({ token: 'fixture-lock-token' })
    })
    await writerStarted.promise
    observeTransaction = true
    transaction = applyL4EnvironmentTransaction({
      directory: join(root, 'operation'),
      agentDir,
      targets: [globalPath, projectPath],
      lockTargets: [globalPath, projectPath],
      store: createSecretStore({
        agentDir: join(root, 'rollback-agent'),
        keyProvider: async () => new Uint8Array(32).fill(4)
      }),
      async apply(): Promise<void> {
        await writeFile(globalPath, '{"restored": "global"}\n')
        await writeFile(projectPath, '{"restored": "project"}\n')
      }
    })
    const [encrypted] = await Promise.all([writer, transaction])
    assert.deepEqual(await config.decrypt(encrypted), { token: 'fixture-lock-token' })
    assert.deepEqual(parseYaml(await readFile(globalPath, 'utf8')), { restored: 'global' })
    assert.deepEqual(parseYaml(await readFile(projectPath, 'utf8')), { restored: 'project' })
    success = true
  } finally {
    transactionStarted.resolve()
    await Promise.allSettled([writer, transaction])
    if (success) await rm(root, { recursive: true, force: true })
    else console.error(`统一配置锁竞争失败现场：${root}`)
  }
})
