import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
import { bindConfigStore, getUnifiedConfigPath } from '../plugins/pi-desk-sdk/src/config-store.ts'

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
const { createSecretStore } = await jiti.import<
  typeof import('../plugins/pi-desk-sdk/src/secrets.ts')
>('../plugins/pi-desk-sdk/src/secrets.ts')

test('统一 YAML 在不同主密钥下归档恢复，源文件与旧配置保持不变', async () => {
  const runs = resolve('temp/run/unified-config')
  await mkdir(runs, { recursive: true })
  const root = await mkdtemp(join(runs, 'archive-roundtrip-'))
  const previous = process.env.PI_DESK_SECRET_KEY_FILE
  let success = false
  try {
    const source = join(root, 'source')
    const target = join(root, 'target')
    await mkdir(target)
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
    await config.set(value, ['/servers/*/*'])
    const hash = `scrypt:${'11'.repeat(16)}:${'22'.repeat(64)}`
    await bindConfigStore('pi-desk', 'auth', { agentDir: source }).set({ passwordHash: hash })
    const sourceBefore = await readFile(getUnifiedConfigPath(source))
    const legacy = join(target, 'legacy-config.json')
    await writeFile(legacy, 'keep-existing-legacy-bytes')
    const collection = await collectL4Environment({
      agentDir: source,
      cwd: root,
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
    process.env.PI_DESK_SECRET_KEY_FILE = targetKey
    await applyL4EnvironmentImport({
      directory: join(root, 'operation'),
      agentDir: target,
      archivePath: archive,
      password,
      manifest,
      selection: { id: randomUUID(), selectedIds: [item.id], mappings: [], overwrite: false },
      rollbackStore: createSecretStore({
        agentDir: join(root, 'rollback-agent'),
        keyProvider: async () => new Uint8Array(32).fill(9)
      })
    })
    const restored = bindConfigStore('plugins', 'example-plugin', { agentDir: target })
    assert.deepEqual(await restored.get(['/servers/*/*']), value)
    assert.deepEqual(await readFile(getUnifiedConfigPath(source)), sourceBefore)
    const restoredText = await readFile(getUnifiedConfigPath(target), 'utf8')
    assert.equal(restoredText.includes('fixture-password'), false)
    assert.equal(restoredText.includes('secret://'), false)
    assert.notEqual(restoredText, sourceBefore.toString('utf8'))
    assert.equal(await readFile(legacy, 'utf8'), 'keep-existing-legacy-bytes')
    assert.match(
      await readFile(join(target, 'pi-desk', 'auth-session-key'), 'utf8'),
      /^[a-f0-9]{64}\n$/u
    )
    success = true
  } finally {
    if (previous === undefined) delete process.env.PI_DESK_SECRET_KEY_FILE
    else process.env.PI_DESK_SECRET_KEY_FILE = previous
    if (success) await rm(root, { recursive: true, force: true })
    else console.error(`统一配置归档失败现场：${root}`)
  }
})
