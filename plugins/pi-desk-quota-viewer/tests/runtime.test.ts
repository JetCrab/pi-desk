import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/session'
import type { QuotaAdapter } from '../src/adapters/types.js'
import { defaultQuotaViewerConfigPath, QuotaViewerRuntime } from '../src/runtime.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
let directoryIndex = 0

function testRoot(name: string): string {
  directoryIndex += 1
  return join(
    projectRoot,
    'temp',
    'pi',
    'quota-viewer',
    'tests',
    name,
    `${process.pid}-${directoryIndex}`
  )
}

function jsonObject(value: unknown): PluginJsonObject {
  return JSON.parse(JSON.stringify(value)) as PluginJsonObject
}

function plugin(pushes: PluginJsonObject[]) {
  return {
    pushGlobal(_event: string, data: PluginJsonObject) {
      pushes.push(data)
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待 Runtime 状态超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function balanceResult(value: number) {
  return {
    warning: null,
    resources: [
      {
        key: 'balance',
        kind: 'balance' as const,
        label: '余额',
        scope: {},
        unit: { kind: 'custom' as const, label: '余额' },
        available: { state: 'known' as const, value },
        expiresAt: null
      }
    ]
  }
}

function createAdapter(input?: {
  name?: string
  minRefreshIntervalMs?: number
  load?: QuotaAdapter['load']
}): QuotaAdapter {
  const name = input?.name ?? 'fixture'
  return {
    descriptor: {
      adapter: name,
      label: `Fixture ${name}`,
      description: 'Fixture Adapter',
      dataSource: 'official_api',
      resourceKinds: ['balance'],
      fields: [
        { key: 'endpoint', kind: 'text', label: 'Endpoint', required: true },
        { key: 'token', kind: 'secret', label: 'Token', required: true }
      ]
    },
    cacheTtlMs: 60_000,
    minRefreshIntervalMs: input?.minRefreshIntervalMs ?? 0,
    timeoutMs: 5_000,
    validateConfig(config) {
      const endpoint = config.endpoint?.trim()
      const token = config.token?.trim()
      if (!endpoint) throw new Error('Endpoint 不能为空')
      if (!token) throw new Error('Token 不能为空')
      if (Object.keys(config).some((key) => key !== 'endpoint' && key !== 'token')) {
        throw new Error('未知 Fixture 字段')
      }
      return { endpoint, token }
    },
    load:
      input?.load ??
      (async () => ({
        warning: null,
        resources: [
          {
            key: 'balance',
            kind: 'balance',
            label: '余额',
            scope: {},
            unit: { kind: 'custom', label: '余额' },
            available: { state: 'known', value: 0 },
            expiresAt: null
          }
        ]
      }))
  }
}

const logger = { info() {}, warn() {} }

test('旧配置文件首次访问复制到 Pi Desk 路径并保留原文件', async (context) => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const agentDir = testRoot('legacy-path')
  context.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    await rm(agentDir, { recursive: true, force: true })
  })
  await mkdir(agentDir, { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir

  const previousPath = join(agentDir, 'pi-super-quota-viewer.json')
  const previousContent = '{"sources":[]}'
  await writeFile(previousPath, previousContent, 'utf8')

  const currentPath = defaultQuotaViewerConfigPath()
  assert.equal(currentPath, join(agentDir, 'pi-desk-quota-viewer.json'))
  assert.equal(await readFile(currentPath, 'utf8'), previousContent)
  assert.equal(await readFile(previousPath, 'utf8'), previousContent)

  const currentContent = '{"sources":[],"hiddenResourceKeys":[]}'
  await writeFile(currentPath, currentContent, 'utf8')
  assert.equal(defaultQuotaViewerConfigPath(), currentPath)
  assert.equal(await readFile(currentPath, 'utf8'), currentContent)
})

test('旧版账号级显示偏好重设，来源与密钥保持不变', async () => {
  const root = testRoot('legacy-config')
  const configPath = join(root, 'config.json')
  const sourceId = '11111111-1111-4111-8111-111111111111'
  await mkdir(root, { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify({
      sources: [
        {
          sourceId,
          adapter: 'fixture',
          name: '旧配置来源',
          enabled: false,
          config: { endpoint: 'legacy', token: 'legacy-token' }
        }
      ],
      hiddenResourceKeys: [`${sourceId}:balance`]
    })
  )
  const runtime = new QuotaViewerRuntime(plugin([]), {
    adapters: [createAdapter()],
    configPath,
    logger,
    fetch: async () => new Response('{}')
  })
  const settings = await runtime.settings()
  assert.deepEqual(settings.display, { resetTimeFormat: 'countdown', hiddenItemKeys: [] })
  assert.equal(settings.sources[0]?.sourceId, sourceId)
  assert.equal(settings.sources[0]?.values.token, 'legacy-token')
  await runtime.saveSettings(jsonObject({ display: { resetTimeFormat: 'absolute' } }))
  const persisted = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(persisted.hiddenResourceKeys, undefined)
  assert.equal(persisted.sources[0]?.config.token, 'legacy-token')
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})

test('settings-save 分配 sourceId 并返回可直接编辑的密钥原值', async () => {
  const root = testRoot('settings')
  const configPath = join(root, 'agent', 'pi-desk-quota-viewer.json')
  await mkdir(join(root, 'agent'), { recursive: true })
  const runtime = new QuotaViewerRuntime(plugin([]), {
    adapters: [createAdapter()],
    configPath,
    logger,
    fetch: async () => new Response('{}')
  })
  const saved = await runtime.saveSettings(
    jsonObject({
      sources: [
        {
          adapter: 'fixture',
          name: '主账号',
          enabled: true,
          values: { endpoint: 'first', token: 'secret-token' }
        }
      ]
    })
  )
  assert.equal(saved.sources.length, 1)
  assert.match(saved.sources[0]?.sourceId ?? '', /^[0-9a-f-]{36}$/)
  assert.equal(saved.sources[0]?.values.token, 'secret-token')

  const sourceId = saved.sources[0]?.sourceId
  assert.ok(sourceId)
  const updated = await runtime.saveSettings(
    jsonObject({
      sources: [
        {
          sourceId,
          adapter: 'fixture',
          name: '主账号',
          enabled: true,
          values: { endpoint: 'second', token: 'next-secret-token' }
        }
      ]
    })
  )
  assert.equal(updated.sources[0]?.values.endpoint, 'second')
  const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
    sources: Array<{ config: Record<string, string> }>
  }
  assert.equal(stored.sources[0]?.config.token, 'next-secret-token')
  assert.equal(updated.sources[0]?.values.token, 'next-secret-token')
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})

test('settings-save 独立保存显示项和时间格式时保留来源、资源、密钥及另一项设置', async () => {
  const root = testRoot('hidden-only')
  const pushes: PluginJsonObject[] = []
  let loadCalls = 0
  const runtime = new QuotaViewerRuntime(plugin(pushes), {
    adapters: [
      createAdapter({
        load: async () => {
          loadCalls += 1
          return {
            warning: null,
            resources: [
              {
                key: 'balance',
                kind: 'balance',
                label: '余额',
                scope: {},
                unit: { kind: 'custom', label: '余额' },
                available: { state: 'known', value: 12 },
                expiresAt: null
              }
            ]
          }
        }
      })
    ],
    configPath: join(root, 'config.json'),
    logger,
    fetch: async () => new Response('{}')
  })
  const initial = await runtime.saveSettings(
    jsonObject({
      sources: [
        {
          adapter: 'fixture',
          name: '保留来源',
          enabled: true,
          values: { endpoint: 'endpoint', token: 'original-token' }
        }
      ]
    })
  )
  const sourceId = initial.sources[0]?.sourceId
  assert.ok(sourceId)
  await waitFor(() => runtime.snapshot().sources[0]?.refreshing === false)
  const callsBeforeHiddenSave = loadCalls

  const hiddenKey = 'fixture:["balance","余额",""]'
  await runtime.saveSettings(jsonObject({ display: { resetTimeFormat: 'absolute' } }))
  const saved = await runtime.saveSettings(jsonObject({ display: { hiddenItemKeys: [hiddenKey] } }))
  assert.deepEqual(saved.display, { resetTimeFormat: 'absolute', hiddenItemKeys: [hiddenKey] })
  assert.equal(loadCalls, callsBeforeHiddenSave)
  const resource = runtime.snapshot().sources[0]?.resources[0]
  assert.deepEqual(resource?.key, 'balance')
  assert.deepEqual(resource?.kind === 'balance' ? resource.available : null, {
    state: 'known',
    value: 12
  })
  const stored = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
    sources: Array<{ sourceId: string; config: Record<string, string> }>
    display: { hiddenItemKeys: string[]; resetTimeFormat: string }
  }
  assert.equal(stored.sources[0]?.sourceId, sourceId)
  assert.equal(stored.sources[0]?.config.endpoint, 'endpoint')
  assert.equal(stored.sources[0]?.config.token, 'original-token')
  assert.deepEqual(stored.display, { resetTimeFormat: 'absolute', hiddenItemKeys: [hiddenKey] })
  const latestPush = pushes.at(-1)
  assert.ok(latestPush)
  assert.deepEqual(latestPush.display, saved.display)
  await Promise.all([
    runtime.saveSettings(jsonObject({ display: { resetTimeFormat: 'countdown' } })),
    runtime.saveSettings(jsonObject({ display: { hiddenItemKeys: [] } }))
  ])
  assert.deepEqual(runtime.snapshot().display, { resetTimeFormat: 'countdown', hiddenItemKeys: [] })
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})

test('渠道隐藏项去重，保留无账号渠道规则并裁剪未知渠道', async () => {
  const root = testRoot('hidden-normalize')
  const runtime = new QuotaViewerRuntime(plugin([]), {
    adapters: [createAdapter()],
    configPath: join(root, 'config.json'),
    logger,
    fetch: async () => new Response('{}')
  })
  const initial = await runtime.saveSettings(
    jsonObject({
      sources: [
        {
          adapter: 'fixture',
          name: '启用来源',
          enabled: true,
          values: { endpoint: 'enabled', token: 'token' }
        },
        {
          adapter: 'fixture',
          name: '禁用来源',
          enabled: false,
          values: { endpoint: 'disabled', token: 'token' }
        }
      ]
    })
  )
  const enabledId = initial.sources[0]?.sourceId
  const disabledId = initial.sources[1]?.sourceId
  assert.ok(enabledId)
  assert.ok(disabledId)
  const hiddenKey = 'fixture:["balance","余额",""]'
  const normalized = await runtime.saveSettings(
    jsonObject({
      display: { hiddenItemKeys: [hiddenKey, hiddenKey, 'missing:["balance","余额",""]'] }
    })
  )
  assert.deepEqual(normalized.display.hiddenItemKeys, [hiddenKey])

  const afterDelete = await runtime.saveSettings(
    jsonObject({
      sources: [
        {
          sourceId: disabledId,
          adapter: 'fixture',
          name: '禁用来源',
          enabled: false,
          values: { endpoint: 'disabled', token: 'token' }
        }
      ]
    })
  )
  assert.deepEqual(afterDelete.display.hiddenItemKeys, [hiddenKey])
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})

test('settings-save 拒绝空对象、格式无效和超过上限的隐藏项', async () => {
  const root = testRoot('hidden-validation')
  const runtime = new QuotaViewerRuntime(plugin([]), {
    adapters: [createAdapter()],
    configPath: join(root, 'config.json'),
    logger,
    fetch: async () => new Response('{}')
  })
  const initial = await runtime.saveSettings(
    jsonObject({
      sources: [
        {
          adapter: 'fixture',
          name: '校验来源',
          enabled: false,
          values: { endpoint: 'endpoint', token: 'token' }
        }
      ]
    })
  )
  const sourceId = initial.sources[0]?.sourceId
  assert.ok(sourceId)
  const invalidInputs: PluginJsonObject[] = [
    jsonObject({}),
    jsonObject({ display: {} }),
    jsonObject({ display: { hiddenItemKeys: ['not-a-resource-key'] } }),
    jsonObject({ display: { resetTimeFormat: 'invalid' } })
  ]
  for (const input of invalidInputs) {
    await assert.rejects(
      runtime.saveSettings(input),
      (error: unknown) => error instanceof PluginMethodError && error.code === 400
    )
  }
  const tooManyKeys = Array.from(
    { length: 501 },
    (_, index) => `fixture:["balance","resource-${index}",""]`
  )
  await assert.rejects(
    runtime.saveSettings(jsonObject({ display: { hiddenItemKeys: tooManyKeys } })),
    (error: unknown) => error instanceof PluginMethodError && error.code === 400
  )
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})

test('settings-save 拒绝未知字段、未知 Adapter 和已有来源切换 Adapter', async () => {
  const root = testRoot('validation')
  const configPath = join(root, 'config.json')
  const runtime = new QuotaViewerRuntime(plugin([]), {
    adapters: [createAdapter(), createAdapter({ name: 'other' })],
    configPath,
    logger,
    fetch: async () => new Response('{}')
  })
  await assert.rejects(
    runtime.saveSettings(
      jsonObject({
        sources: [
          {
            adapter: 'fixture',
            name: '错误字段',
            enabled: true,
            values: { endpoint: 'x', token: 'y', extra: 'z' }
          }
        ]
      })
    ),
    (error: unknown) => error instanceof PluginMethodError && error.code === 400
  )
  await assert.rejects(
    runtime.saveSettings(
      jsonObject({
        sources: [{ adapter: 'missing', name: '未知', enabled: true, values: {} }]
      })
    ),
    (error: unknown) => error instanceof PluginMethodError && error.code === 400
  )
  const saved = await runtime.saveSettings(
    jsonObject({
      sources: [
        {
          adapter: 'fixture',
          name: '来源',
          enabled: false,
          values: { endpoint: 'x', token: 'y' }
        }
      ]
    })
  )
  await assert.rejects(
    runtime.saveSettings(
      jsonObject({
        sources: [
          {
            sourceId: saved.sources[0]?.sourceId,
            adapter: 'other',
            name: '来源',
            enabled: false,
            values: { endpoint: 'x', token: 'y' }
          }
        ]
      })
    ),
    (error: unknown) => error instanceof PluginMethodError && error.code === 400
  )
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})

test('每来源缓存去重，刷新失败保留最后成功数据', async () => {
  const root = testRoot('cache')
  let calls = 0
  let fail = false
  const adapter = createAdapter({
    load: async () => {
      calls += 1
      if (fail) throw new Error('fixture refresh failed')
      return {
        warning: null,
        resources: [
          {
            key: 'balance',
            kind: 'balance',
            label: '余额',
            scope: {},
            unit: { kind: 'custom', label: '余额' },
            available: { state: 'known', value: calls },
            expiresAt: null
          }
        ]
      }
    }
  })
  const pushes: PluginJsonObject[] = []
  const runtime = new QuotaViewerRuntime(plugin(pushes), {
    adapters: [adapter],
    configPath: join(root, 'config.json'),
    logger,
    fetch: async () => new Response('{}')
  })
  await runtime.saveSettings(
    jsonObject({
      sources: [
        {
          adapter: 'fixture',
          name: '缓存来源',
          enabled: true,
          values: { endpoint: 'x', token: 'y' }
        }
      ]
    })
  )
  await waitFor(() => runtime.snapshot().sources[0]?.refreshing === false)
  assert.equal(calls, 1)
  await runtime.query(false)
  assert.equal(calls, 1)
  fail = true
  await runtime.query(true)
  await waitFor(() => runtime.snapshot().sources[0]?.refreshing === false)
  assert.equal(calls, 2)
  const state = runtime.snapshot().sources[0]
  assert.match(state?.error ?? '', /fixture refresh failed/)
  assert.equal(state?.resources[0]?.kind, 'balance')
  if (state?.resources[0]?.kind === 'balance') {
    assert.deepEqual(state.resources[0].available, { state: 'known', value: 1 })
  }
  assert.ok(pushes.length >= 4)
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})

test('改名保留来源资源、有效期和在途请求', async () => {
  const root = testRoot('rename-in-flight')
  const pending = deferred<Awaited<ReturnType<QuotaAdapter['load']>>>()
  let calls = 0
  let pendingSignal: AbortSignal | undefined
  const adapter = createAdapter({
    load: async ({ signal }) => {
      calls += 1
      if (calls === 1) return balanceResult(10)
      pendingSignal = signal
      return pending.promise
    }
  })
  const runtime = new QuotaViewerRuntime(plugin([]), {
    adapters: [adapter],
    configPath: join(root, 'config.json'),
    logger,
    fetch: async () => new Response('{}')
  })

  try {
    const saved = await runtime.saveSettings(
      jsonObject({
        sources: [
          {
            adapter: 'fixture',
            name: '原名称',
            enabled: true,
            values: { endpoint: 'endpoint', token: 'token' }
          }
        ]
      })
    )
    const sourceId = saved.sources[0]?.sourceId
    assert.ok(sourceId)
    await waitFor(() => runtime.snapshot().sources[0]?.refreshing === false)
    const before = runtime.snapshot().sources[0]
    const beforeResource = before?.resources[0]
    assert.equal(
      beforeResource?.kind === 'balance' && beforeResource.available.state === 'known'
        ? beforeResource.available.value
        : null,
      10
    )

    await runtime.query(true)
    await waitFor(() => calls === 2 && runtime.snapshot().sources[0]?.refreshing === true)
    await runtime.saveSettings(
      jsonObject({
        sources: [
          {
            sourceId,
            adapter: 'fixture',
            name: '新名称',
            enabled: true,
            values: { endpoint: 'endpoint', token: 'token' }
          }
        ]
      })
    )

    const renamed = runtime.snapshot().sources[0]
    assert.equal(calls, 2)
    assert.equal(pendingSignal?.aborted, false)
    assert.equal(renamed?.name, '新名称')
    assert.equal(renamed?.refreshing, true)
    assert.equal(renamed?.observedAt, before?.observedAt)
    assert.equal(renamed?.staleAt, before?.staleAt)
    assert.deepEqual(renamed?.resources, before?.resources)

    pending.resolve(balanceResult(20))
    await waitFor(() => {
      const state = runtime.snapshot().sources[0]
      return (
        state?.refreshing === false &&
        state.resources[0]?.kind === 'balance' &&
        state.resources[0].available.state === 'known' &&
        state.resources[0].available.value === 20
      )
    })
    assert.equal(runtime.snapshot().sources[0]?.name, '新名称')
  } finally {
    pending.resolve(balanceResult(20))
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('变更、新增和禁用只影响对应来源且旧 generation 不回写', async () => {
  const root = testRoot('source-isolation')
  const oldRequest = deferred<Awaited<ReturnType<QuotaAdapter['load']>>>()
  const oldRequestReturned = deferred<void>()
  const firstCalls: string[] = []
  let secondCalls = 0
  let oldSignal: AbortSignal | undefined
  const firstAdapter = createAdapter({
    name: 'first',
    load: async ({ config, signal }) => {
      const endpoint = config.endpoint ?? ''
      firstCalls.push(endpoint)
      if (
        endpoint === 'first-original' &&
        firstCalls.filter((calledEndpoint) => calledEndpoint === endpoint).length === 2
      ) {
        oldSignal = signal
        const result = await oldRequest.promise
        oldRequestReturned.resolve(undefined)
        return result
      }
      return balanceResult(
        endpoint === 'first-original' ? 10 : endpoint === 'first-changed' ? 11 : 30
      )
    }
  })
  const secondAdapter = createAdapter({
    name: 'second',
    load: async () => {
      secondCalls += 1
      return balanceResult(20)
    }
  })
  const pushes: PluginJsonObject[] = []
  const runtime = new QuotaViewerRuntime(plugin(pushes), {
    adapters: [firstAdapter, secondAdapter],
    configPath: join(root, 'config.json'),
    logger,
    fetch: async () => new Response('{}')
  })

  try {
    const initial = await runtime.saveSettings(
      jsonObject({
        sources: [
          {
            adapter: 'first',
            name: '第一来源',
            enabled: true,
            values: { endpoint: 'first-original', token: 'token' }
          },
          {
            adapter: 'second',
            name: '第二来源',
            enabled: true,
            values: { endpoint: 'second-original', token: 'token' }
          }
        ]
      })
    )
    const firstId = initial.sources[0]?.sourceId
    const secondId = initial.sources[1]?.sourceId
    assert.ok(firstId)
    assert.ok(secondId)
    await waitFor(() => runtime.snapshot().sources.every((source) => !source.refreshing))
    await runtime.query(true)
    await waitFor(() => {
      const second = runtime.snapshot().sources.find((source) => source.sourceId === secondId)
      return oldSignal !== undefined && secondCalls === 2 && second?.refreshing === false
    })
    const secondCallsBeforeChange = secondCalls

    const updated = await runtime.saveSettings(
      jsonObject({
        sources: [
          {
            sourceId: firstId,
            adapter: 'first',
            name: '第一来源',
            enabled: true,
            values: { endpoint: 'first-changed', token: 'token' }
          },
          {
            sourceId: secondId,
            adapter: 'second',
            name: '第二来源',
            enabled: true,
            values: { endpoint: 'second-original', token: 'token' }
          },
          {
            adapter: 'first',
            name: '新增来源',
            enabled: true,
            values: { endpoint: 'new-source', token: 'token' }
          }
        ]
      })
    )
    const newId = updated.sources[2]?.sourceId
    assert.ok(newId)
    await waitFor(() => {
      const sources = runtime.snapshot().sources
      const changed = sources.find((source) => source.sourceId === firstId)
      const added = sources.find((source) => source.sourceId === newId)
      return (
        oldSignal?.aborted === true &&
        changed?.refreshing === false &&
        changed?.resources[0]?.kind === 'balance' &&
        changed.resources[0].available.state === 'known' &&
        changed.resources[0].available.value === 11 &&
        added?.refreshing === false
      )
    })
    assert.deepEqual(firstCalls, [
      'first-original',
      'first-original',
      'first-changed',
      'new-source'
    ])
    assert.equal(secondCalls, secondCallsBeforeChange)

    const pushCountAfterNewGeneration = pushes.length
    oldRequest.resolve(balanceResult(999))
    await oldRequestReturned.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(pushes.length, pushCountAfterNewGeneration)
    const afterOldResult = runtime.snapshot().sources
    const changedSource = afterOldResult.find((source) => source.sourceId === firstId)
    const changedResource = changedSource?.resources[0]
    assert.equal(
      changedResource?.kind === 'balance' && changedResource.available.state === 'known'
        ? changedResource.available.value
        : null,
      11
    )
    const secondBeforeDisable = afterOldResult.find((source) => source.sourceId === secondId)
    const newBeforeDisable = afterOldResult.find((source) => source.sourceId === newId)

    await runtime.saveSettings(
      jsonObject({
        sources: [
          {
            sourceId: firstId,
            adapter: 'first',
            name: '第一来源',
            enabled: false,
            values: { endpoint: 'first-changed', token: 'token' }
          },
          {
            sourceId: secondId,
            adapter: 'second',
            name: '第二来源',
            enabled: true,
            values: { endpoint: 'second-original', token: 'token' }
          },
          {
            sourceId: newId,
            adapter: 'first',
            name: '新增来源',
            enabled: true,
            values: { endpoint: 'new-source', token: 'token' }
          }
        ]
      })
    )
    const afterDisable = runtime.snapshot().sources
    assert.equal(
      afterDisable.some((source) => source.sourceId === firstId),
      false
    )
    assert.equal(secondCalls, secondCallsBeforeChange)
    assert.deepEqual(firstCalls, [
      'first-original',
      'first-original',
      'first-changed',
      'new-source'
    ])
    assert.deepEqual(
      afterDisable.find((source) => source.sourceId === secondId)?.resources,
      secondBeforeDisable?.resources
    )
    assert.deepEqual(
      afterDisable.find((source) => source.sourceId === newId)?.resources,
      newBeforeDisable?.resources
    )
  } finally {
    oldRequest.resolve(balanceResult(999))
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('来源配置变更保留最小刷新间隔与 retryAt 限流窗', async () => {
  const root = testRoot('retry-at')
  let calls = 0
  const adapter = createAdapter({
    minRefreshIntervalMs: 60_000,
    load: async () => {
      calls += 1
      return {
        warning: '一个子请求被限流',
        retryAt: Date.now() + 60_000,
        resources: [
          {
            key: 'balance',
            kind: 'balance',
            label: '余额',
            scope: {},
            unit: { kind: 'custom', label: '余额' },
            available: { state: 'known', value: 10 },
            expiresAt: null
          }
        ]
      }
    }
  })
  const runtime = new QuotaViewerRuntime(plugin([]), {
    adapters: [adapter],
    configPath: join(root, 'config.json'),
    logger,
    fetch: async () => new Response('{}')
  })
  const saved = await runtime.saveSettings(
    jsonObject({
      sources: [
        {
          adapter: 'fixture',
          name: '限流来源',
          enabled: true,
          values: { endpoint: 'x', token: 'y' }
        }
      ]
    })
  )
  const sourceId = saved.sources[0]?.sourceId
  assert.ok(sourceId)
  await waitFor(() => runtime.snapshot().sources[0]?.refreshing === false)
  assert.equal(calls, 1)
  await runtime.saveSettings(
    jsonObject({
      sources: [
        {
          sourceId,
          adapter: 'fixture',
          name: '限流来源',
          enabled: true,
          values: { endpoint: 'changed', token: 'y' }
        }
      ]
    })
  )
  await runtime.query(true)
  assert.equal(calls, 1)
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})

test(
  'POSIX 配置文件保存为 owner-only 并保留更严格权限',
  { skip: process.platform === 'win32' },
  async () => {
    const root = testRoot('permissions')
    const configPath = join(root, 'config.json')
    const runtime = new QuotaViewerRuntime(plugin([]), {
      adapters: [createAdapter()],
      configPath,
      logger,
      fetch: async () => new Response('{}')
    })
    try {
      const first = await runtime.saveSettings(
        jsonObject({
          sources: [
            {
              adapter: 'fixture',
              name: '权限来源',
              enabled: false,
              values: { endpoint: 'x', token: 'y' }
            }
          ]
        })
      )
      assert.equal((await stat(configPath)).mode & 0o777, 0o600)
      await chmod(configPath, 0o400)
      await runtime.saveSettings(
        jsonObject({
          sources: [
            {
              sourceId: first.sources[0]?.sourceId,
              adapter: 'fixture',
              name: '权限来源',
              enabled: false,
              values: { endpoint: 'updated', token: 'y' }
            }
          ]
        })
      )
      assert.equal((await stat(configPath)).mode & 0o777, 0o400)
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('dispose 取消活动请求并等待任务释放', async () => {
  const root = testRoot('dispose')
  let aborted = false
  const adapter = createAdapter({
    load: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(signal.reason)
          },
          { once: true }
        )
      })
  })
  const runtime = new QuotaViewerRuntime(plugin([]), {
    adapters: [adapter],
    configPath: join(root, 'config.json'),
    logger,
    fetch: async () => new Response('{}')
  })
  await runtime.saveSettings(
    jsonObject({
      sources: [
        {
          adapter: 'fixture',
          name: '活动来源',
          enabled: true,
          values: { endpoint: 'x', token: 'y' }
        }
      ]
    })
  )
  await waitFor(() => runtime.snapshot().sources[0]?.refreshing === true)
  await runtime.dispose()
  assert.equal(aborted, true)
  assert.deepEqual(runtime.snapshot(), {
    error: null,
    sources: [],
    display: { resetTimeFormat: 'countdown', hiddenItemKeys: [] }
  })
  await rm(root, { recursive: true, force: true })
})
