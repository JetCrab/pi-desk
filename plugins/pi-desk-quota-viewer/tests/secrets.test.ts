import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { on, once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createSecretStore, type SecretStore } from '@jetcrab/pi-desk-sdk/secrets'
import { quotaAdapterRegistry } from '../src/adapters/registry.js'
import { readStoredConfig, writeStoredConfig, type StoredConfig } from '../src/l2-quota-config.js'
import { QuotaViewerRuntime } from '../src/runtime.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../temp/run/quota-secrets')

function config(): StoredConfig {
  return {
    sources: [
      {
        sourceId: '11111111-1111-4111-8111-111111111111',
        adapter: 'openrouter',
        name: '测试账户',
        enabled: false,
        config: { managementKey: 'test-only-api-key', apiKey: '' }
      }
    ],
    display: { resetTimeFormat: 'countdown', hiddenItemKeys: [] }
  }
}

async function fixture(context: test.TestContext, name: string): Promise<string> {
  const directory = join(root, `${name}-${process.pid}`)
  await mkdir(directory, { recursive: true })
  context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

type WorkerMessage = { kind: string; reference?: string; message?: string }

function transactionStore(agentDir: string): ReturnType<typeof createSecretStore> {
  return createSecretStore({ agentDir, keyProvider: async () => new Uint8Array(32).fill(11) })
}

async function startWorker(
  agentDir: string,
  mode: string
): Promise<{
  messages: WorkerMessage[]
  send: (kind: string, value?: StoredConfig) => void
  waitFor: (kind: string) => Promise<WorkerMessage>
  stop: () => Promise<void>
}> {
  const child = fork(
    fileURLToPath(new URL('./config-transaction-worker.ts', import.meta.url)),
    [agentDir, mode],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }
  )
  const exited = once(child, 'exit')
  const messages: WorkerMessage[] = []
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.on('message', (message: WorkerMessage) => {
    messages.push(message)
  })
  const lifetime = new AbortController()
  child.once('exit', () => lifetime.abort(new Error(`测试进程已退出：${stderr}`)))
  const worker = {
    messages,
    send(kind: string, value?: StoredConfig): void {
      child.send({ kind, value })
    },
    async waitFor(kind: string): Promise<WorkerMessage> {
      const previous = messages.find((message) => message.kind === kind)
      if (previous) return previous
      const failure = messages.find((message) => message.kind === 'error')
      if (failure) throw new Error(failure.message)
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)])
      for await (const [payload] of on(child, 'message', { signal })) {
        const message = payload as WorkerMessage
        if (message.kind === kind) return message
        if (message.kind === 'error') throw new Error(message.message)
      }
      throw new Error(`测试进程没有报告：${kind}`)
    },
    async stop(): Promise<void> {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited
    }
  }
  try {
    await worker.waitFor('ready')
    return worker
  } catch (error) {
    await worker.stop()
    throw error
  }
}

test('凭据能力不可用时最新配置查询与保存明确失败且原引用不变', async (context) => {
  const agentDir = await fixture(context, 'key-unavailable')
  const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  await writeStoredConfig(path, config(), quotaAdapterRegistry, transactionStore(agentDir))
  const original = await readFile(path, 'utf8')
  const secretStore = createSecretStore({
    agentDir,
    keyProvider: async () => {
      throw new Error('测试密钥不可用')
    }
  })
  const runtime = new QuotaViewerRuntime({ pushGlobal() {} }, { configPath: path, secretStore })
  context.after(() => runtime.dispose())
  await assert.rejects(runtime.settings(), /注入的凭据密钥提供器失败/)
  await assert.rejects(
    runtime.saveSettings({ display: { resetTimeFormat: 'absolute' } }),
    /注入的凭据密钥提供器失败/
  )
  assert.equal(await readFile(path, 'utf8'), original)
})

test('UI明文仅在保存时转引用，空值不入库，后续读写复用引用', async (context) => {
  const agentDir = await fixture(context, 'protected-current-config')
  const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  const store = transactionStore(agentDir)
  await writeStoredConfig(path, config(), quotaAdapterRegistry, store)
  const value = await readStoredConfig(path, quotaAdapterRegistry, store)
  assert.equal(value.sources[0].config.managementKey, 'test-only-api-key')
  const original = await readFile(path, 'utf8')
  const stored = JSON.parse(original) as StoredConfig
  assert.match(stored.sources[0].config.managementKey, /^secret:\/\/[0-9a-f-]{36}$/)
  assert.equal(stored.sources[0].config.apiKey, '')
  assert.equal(original.includes('test-only-api-key'), false)
  await writeStoredConfig(path, value, quotaAdapterRegistry, store)
  assert.equal(await readFile(path, 'utf8'), original)
  assert.deepEqual(await readStoredConfig(path, quotaAdapterRegistry, store), value)
})

test('真实跨进程完整配置替换串行，后到显式提交生效且引用不悬空', async (context) => {
  const agentDir = await fixture(context, 'process-interleaving')
  const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  const store = transactionStore(agentDir)
  await writeStoredConfig(path, config(), quotaAdapterRegistry, store)
  const originalReference = (JSON.parse(await readFile(path, 'utf8')) as StoredConfig).sources[0]
    .config.managementKey
  const stale = await readStoredConfig(path, quotaAdapterRegistry, store)
  const first = await startWorker(agentDir, 'hold-write')
  let second: Awaited<ReturnType<typeof startWorker>> | undefined
  try {
    const changed = config()
    changed.sources[0].config.managementKey = 'process-a-key'
    first.send('start', changed)
    const allocated = await first.waitFor('allocated')
    second = await startWorker(agentDir, 'write')
    second.send('start', stale)
    await second.waitFor('lock-contended')
    first.send('continue')
    await first.waitFor('done')
    await second.waitFor('done')
    assert.ok(
      second.messages.some(
        (message) => message.kind === 'reference-read' && message.reference === allocated.reference
      )
    )
    const stored = JSON.parse(await readFile(path, 'utf8')) as StoredConfig
    assert.notEqual(stored.sources[0].config.managementKey, originalReference)
    assert.equal(
      (await readStoredConfig(path, quotaAdapterRegistry, store)).sources[0].config.managementKey,
      'test-only-api-key'
    )
    assert.equal(await store.get(originalReference), 'test-only-api-key')
  } finally {
    await first.stop()
    await second?.stop()
  }
})

test('发布前最新文件在锁外变化时不覆盖新内容并回收未提交引用', async (context) => {
  const agentDir = await fixture(context, 'current-file-changed')
  const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  const store = transactionStore(agentDir)
  await writeStoredConfig(path, config(), quotaAdapterRegistry, store)
  const worker = await startWorker(agentDir, 'hold-write')
  try {
    const pending = config()
    pending.sources[0].config.managementKey = 'pending-test-key'
    worker.send('start', pending)
    const allocated = await worker.waitFor('allocated')
    const changed = JSON.parse(await readFile(path, 'utf8')) as StoredConfig
    changed.sources[0].name = '最新文件的外部设置'
    const content = JSON.stringify(changed)
    await writeFile(path, content)
    worker.send('continue')
    assert.match((await worker.waitFor('error')).message ?? '', /额度配置文件已变化/)
    assert.equal(await readFile(path, 'utf8'), content)
    assert.equal(await store.get(allocated.reference!), null)
    assert.equal(
      (await readStoredConfig(path, quotaAdapterRegistry, store)).sources[0].config.managementKey,
      'test-only-api-key'
    )
  } finally {
    await worker.stop()
  }
})

test('发布后最新文件被外部修改时保留文件与已发布引用', async (context) => {
  const agentDir = await fixture(context, 'current-file-changed-after-publish')
  const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  const store = transactionStore(agentDir)
  await writeStoredConfig(path, config(), quotaAdapterRegistry, store)
  const worker = await startWorker(agentDir, 'hold-after-publish')
  try {
    const pending = config()
    pending.sources[0].config.managementKey = 'published-test-key'
    worker.send('start', pending)
    const published = await worker.waitFor('published')
    const changed = JSON.parse(await readFile(path, 'utf8')) as StoredConfig
    changed.sources[0].name = '发布后更新的最新文件'
    const content = JSON.stringify(changed)
    await writeFile(path, content)
    worker.send('continue')
    assert.match((await worker.waitFor('error')).message ?? '', /额度配置文件已变化/)
    assert.equal(await readFile(path, 'utf8'), content)
    assert.equal(await store.get(published.reference!), 'published-test-key')
    assert.equal(
      (await readStoredConfig(path, quotaAdapterRegistry, store)).sources[0].name,
      changed.sources[0].name
    )
  } finally {
    await worker.stop()
  }
})

test('只有旧root与pi-super明文副本时返回空配置且不读取改写或删除旧文件', async (context) => {
  const agentDir = await fixture(context, 'old-files-isolated')
  const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  const legacy = join(agentDir, 'pi-desk-quota-viewer.json')
  const older = join(agentDir, 'pi-super-quota-viewer.json')
  const original = JSON.stringify(config())
  await writeFile(legacy, original)
  await writeFile(older, original)
  const worker = await startWorker(agentDir, 'read')
  try {
    worker.send('start', config())
    await worker.waitFor('done')
    assert.equal(
      worker.messages.some((message) => message.kind === 'plaintext-write'),
      false
    )
    await assert.rejects(readFile(path), { code: 'ENOENT' })
    assert.equal(await readFile(legacy, 'utf8'), original)
    assert.equal(await readFile(older, 'utf8'), original)
    assert.deepEqual(
      (await readStoredConfig(path, quotaAdapterRegistry, transactionStore(agentDir))).sources,
      []
    )
  } finally {
    await worker.stop()
  }
})

test('旧文件损坏或内容不同不会影响最新引用配置且全部保持原字节', async (context) => {
  const agentDir = await fixture(context, 'old-files-conflict-isolated')
  const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  const legacy = join(agentDir, 'pi-desk-quota-viewer.json')
  const older = join(agentDir, 'pi-super-quota-viewer.json')
  await writeFile(legacy, '{旧文件不解析}')
  await writeFile(older, JSON.stringify({ sources: [] }))
  const store = transactionStore(agentDir)
  await writeStoredConfig(path, config(), quotaAdapterRegistry, store)
  const before = await readFile(path, 'utf8')
  assert.deepEqual(await readStoredConfig(path, quotaAdapterRegistry, store), config())
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal(await readFile(legacy, 'utf8'), '{旧文件不解析}')
  assert.equal(await readFile(older, 'utf8'), JSON.stringify({ sources: [] }))
})

test('配置提交后临时文件清理失败不撤销已发布凭据', async (context) => {
  const agentDir = await fixture(context, 'committed-cleanup-failure')
  const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  const store = transactionStore(agentDir)
  await writeStoredConfig(path, config(), quotaAdapterRegistry, store)
  const worker = await startWorker(agentDir, 'cleanup-failure')
  try {
    const changed = config()
    changed.sources[0].config.managementKey = 'published-test-key'
    worker.send('start', changed)
    await worker.waitFor('cleanup-failed')
    await worker.waitFor('done')
    assert.equal(
      worker.messages.some((message) => message.kind === 'reference-deleted'),
      false
    )
    assert.equal(
      (await readStoredConfig(path, quotaAdapterRegistry, store)).sources[0].config.managementKey,
      'published-test-key'
    )
  } finally {
    await worker.stop()
  }
})

test('其他配置共享的已发布引用在更新及删除来源后仍可读取', async (context) => {
  const agentDir = await fixture(context, 'shared-reference')
  const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  const sharedPath = join(agentDir, 'config', 'other-project.json')
  const store = transactionStore(agentDir)
  await writeStoredConfig(path, config(), quotaAdapterRegistry, store)
  const shared = JSON.parse(await readFile(path, 'utf8')) as StoredConfig
  const reference = shared.sources[0].config.managementKey
  await writeStoredConfig(sharedPath, shared, quotaAdapterRegistry, store)
  const changed = config()
  changed.sources[0].config.managementKey = 'new-project-key'
  await writeStoredConfig(path, changed, quotaAdapterRegistry, store)
  await writeStoredConfig(path, { ...changed, sources: [] }, quotaAdapterRegistry, store)
  assert.equal(await store.get(reference), 'test-only-api-key')
  assert.equal(
    (await readStoredConfig(sharedPath, quotaAdapterRegistry, store)).sources[0].config
      .managementKey,
    'test-only-api-key'
  )
})

test('发布后验证暂时失败时保留新引用供后续重新读取', async (context) => {
  const agentDir = await fixture(context, 'uncertain-commit')
  const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  const store = transactionStore(agentDir)
  await writeStoredConfig(path, config(), quotaAdapterRegistry, store)
  const old = (JSON.parse(await readFile(path, 'utf8')) as StoredConfig).sources[0].config
    .managementKey
  const controlled: SecretStore = {
    async get(reference) {
      const published = JSON.parse(await readFile(path, 'utf8')) as StoredConfig
      if (reference !== old && published.sources[0].config.managementKey === reference)
        throw new Error('测试发布后验证暂时失败')
      return store.get(reference)
    },
    put: (value, reference) => store.put(value, reference),
    delete: (reference) => store.delete(reference),
    export: (references) => store.export(references),
    import: (values) => store.import(values)
  }
  const changed = config()
  changed.sources[0].config.managementKey = 'uncertain-test-key'
  await assert.rejects(
    writeStoredConfig(path, changed, quotaAdapterRegistry, controlled),
    /测试发布后验证暂时失败/
  )
  const reference = (JSON.parse(await readFile(path, 'utf8')) as StoredConfig).sources[0].config
    .managementKey
  assert.equal(await store.get(reference), 'uncertain-test-key')
  assert.equal(
    (await readStoredConfig(path, quotaAdapterRegistry, store)).sources[0].config.managementKey,
    'uncertain-test-key'
  )
})

test('密钥更新或目标写入失败时原引用仍能读取原值', async (context) => {
  const agentDir = await fixture(context, 'failed-save')
  const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  const store = transactionStore(agentDir)
  const value = config()
  await writeStoredConfig(path, value, quotaAdapterRegistry, store)
  const before = await readFile(path, 'utf8')
  value.sources[0].config.managementKey = 'changed-test-key'
  value.sources[0].name = 'x'.repeat(300 * 1024)
  await assert.rejects(writeStoredConfig(path, value, quotaAdapterRegistry, store), /额度配置超过/)
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal(
    (await readStoredConfig(path, quotaAdapterRegistry, store)).sources[0].config.managementKey,
    'test-only-api-key'
  )
})
