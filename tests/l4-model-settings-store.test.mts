import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
import {
  L2ModelSettingsGetResponseSchema,
  L2ModelSettingsReplaceRequestSchema
} from '../src/common/l2_biz/model-settings/l2-model-settings-contract.ts'

type Store = typeof import('../src/server/l4_foundation/model-settings/l4-model-settings-store')
type Config = Record<string, unknown>
const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: resolve('tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})

function fixtureConfig(): Config {
  return {
    customHostData: { keep: ['unchanged'] },
    providers: {
      fixture: {
        baseUrl: 'http://127.0.0.1:9/v1',
        api: 'openai-completions',
        apiKey: 'fixture-only',
        headers: { 'X-Provider': 'fixture' },
        customProviderData: { retained: true },
        models: [
          {
            id: 'test-model',
            reasoning: true,
            thinkingLevelMap: { off: null, low: 'low', high: 'high', max: 'max' },
            inputLimits: { images: { resize: { maxWidth: 1568, maxHeight: 1568 } } },
            promptCache: { short: 300, long: 3600 },
            samplingParams: { temperature: 0.7, top_p: 0.9 },
            cost: {
              input: 1,
              output: 2,
              cacheRead: 0.1,
              cacheWrite: 0.2,
              tiers: [
                { inputTokensAbove: 64000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.4 }
              ]
            },
            compat: {
              thinkingFormat: 'baseten',
              supportsStore: false,
              chatTemplateArgs: { enable_thinking: true }
            },
            headers: { 'X-Model': 'fixture' },
            customModelData: { preserved: ['yes'] }
          }
        ]
      }
    },
    modelPresets: [
      { provider: 'fixture', modelId: 'test-model', thinkingLevel: 'high', color: null }
    ]
  }
}

async function withFixture(
  input: Config | string,
  run: (store: Store, path: string, agentDir: string) => Promise<void>
): Promise<void> {
  const root = resolve('temp/pi/l4-model-settings-store', `native-roundtrip-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const keys = ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_OFFLINE'] as const
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  let passed = false
  try {
    await mkdir(join(agentDir, 'sessions'), { recursive: true })
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
    process.env.PI_OFFLINE = '1'
    const path = join(agentDir, 'models.json')
    await writeFile(path, typeof input === 'string' ? input : JSON.stringify(input))
    await writeFile(join(agentDir, 'auth.json'), '{}')
    const store = await jiti.import<Store>(
      '../src/server/l4_foundation/model-settings/l4-model-settings-store.ts'
    )
    await run(store, path, agentDir)
    passed = true
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error(`模型设置验证现场：${root}`)
  }
}

async function readConfig(path: string): Promise<Config> {
  return JSON.parse(await readFile(path, 'utf8')) as Config
}

function providerOf(config: Config): Record<string, unknown> {
  return (config.providers as Record<string, Record<string, unknown>>).fixture
}

function modelOf(config: Config): Record<string, unknown> {
  return (providerOf(config).models as Record<string, unknown>[])[0]
}

test('模型设置：表单无改动往返不固化默认、不删除 baseten 和高级字段', async () => {
  const initial = fixtureConfig()
  await withFixture(initial, async (store, path) => {
    const settings = L2ModelSettingsGetResponseSchema.parse(await store.readL4ModelSettings())
    assert.deepEqual(settings.nativeConfig, initial)
    assert.equal(settings.providers[0].models[0].compat?.thinkingFormat, 'baseten')
    assert.equal(settings.providers[0].models[0].api, null)
    assert.equal(settings.providers[0].models[0].baseUrl, null)
    await store.replaceL4ModelSettings({ providers: settings.providers })
    assert.deepEqual(await readConfig(path), initial)
  })
})

test('模型设置：局部编辑只改变对应字段，保留费率阶梯与缺省声明', async () => {
  const initial = fixtureConfig()
  await withFixture(initial, async (store, path) => {
    const settings = await store.readL4ModelSettings()
    settings.providers[0].models[0].name = '编辑后的名称'
    await store.replaceL4ModelSettings({ providers: settings.providers })
    const expected = structuredClone(initial)
    modelOf(expected).name = '编辑后的名称'
    assert.deepEqual(await readConfig(path), expected)
  })
})

test('模型设置：覆盖层的生效值可读可改，未改项仍保留在原声明', async () => {
  const initial = fixtureConfig()
  modelOf(initial).contextWindow = 32000
  providerOf(initial).modelOverrides = {
    'test-model': {
      contextWindow: 64000,
      input: ['text', 'image'],
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
      cost: { input: 3 }
    }
  }
  await withFixture(initial, async (store, path) => {
    const settings = L2ModelSettingsGetResponseSchema.parse(await store.readL4ModelSettings())
    const model = settings.providers[0].models[0]
    assert.equal(model.contextWindow, 64000)
    assert.deepEqual(model.input, ['text', 'image'])
    assert.equal(
      model.thinkingLevels.find((item) => item.level === 'xhigh')?.providerValue,
      'xhigh'
    )
    assert.equal(model.cost?.input, 3)
    await store.replaceL4ModelSettings({ providers: settings.providers })
    assert.deepEqual(await readConfig(path), initial)
    model.contextWindow = 96000
    await store.replaceL4ModelSettings({ providers: settings.providers })
    const saved = await readConfig(path)
    assert.equal(modelOf(saved).contextWindow, 32000)
    const overrides = providerOf(saved).modelOverrides as Record<string, Record<string, unknown>>
    assert.equal(overrides['test-model'].contextWindow, 96000)
    assert.equal((await store.readL4ModelSettings()).providers[0].models[0].contextWindow, 96000)
  })
})

test('模型设置：原生配置可以维护官方低频能力且不混用两种保存模式', async () => {
  await withFixture(fixtureConfig(), async (store, path) => {
    const settings = await store.readL4ModelSettings()
    const nativeConfig = structuredClone(settings.nativeConfig)
    const config = nativeConfig as Config
    providerOf(config).modelOverrides = {
      'test-model': {
        contextWindow: 256000,
        promptCache: { long: 7200 },
        samplingParams: { temperature: 0.4 },
        inputLimits: { images: { resize: { jpegQuality: 70 } } }
      }
    }
    const parsed = L2ModelSettingsReplaceRequestSchema.parse({ nativeConfig })
    await store.replaceL4ModelSettings(parsed)
    assert.deepEqual(await readConfig(path), nativeConfig)
    assert.equal((await store.readL4ModelSettings()).providers[0].models[0].contextWindow, 256000)
    assert.equal(
      L2ModelSettingsReplaceRequestSchema.safeParse({ nativeConfig, providers: settings.providers })
        .success,
      false
    )
    assert.equal(
      L2ModelSettingsReplaceRequestSchema.safeParse({ nativeConfig: { invalid: () => undefined } })
        .success,
      false
    )
  })
})

test('模型设置：未配置价格不是免费，清空价格移除模型各层费率', async () => {
  const initial = fixtureConfig()
  delete modelOf(initial).cost
  await withFixture(initial, async (store) => {
    assert.equal((await store.readL4ModelSettings()).providers[0].models[0].cost, null)
  })
  const priced = fixtureConfig()
  providerOf(priced).modelOverrides = { 'test-model': { cost: { input: 3 } } }
  await withFixture(priced, async (store, path) => {
    const settings = await store.readL4ModelSettings()
    settings.providers[0].models[0].cost = null
    await store.replaceL4ModelSettings({ providers: settings.providers })
    assert.equal((await store.readL4ModelSettings()).providers[0].models[0].cost, null)
    const saved = await readConfig(path)
    assert.equal(modelOf(saved).cost, undefined)
    const overrides = providerOf(saved).modelOverrides as Record<string, Record<string, unknown>>
    assert.equal(overrides['test-model'].cost, undefined)
  })
})

test('模型设置：原生配置校验失败不改变原文件', async () => {
  const initial = fixtureConfig()
  await withFixture(initial, async (store, path) => {
    const before = await readFile(path, 'utf8')
    const invalid = structuredClone(initial)
    modelOf(invalid).contextWindow = 0
    await assert.rejects(
      store.replaceL4ModelSettings(
        L2ModelSettingsReplaceRequestSchema.parse({ nativeConfig: invalid })
      )
    )
    assert.equal(await readFile(path, 'utf8'), before)
  })
})

test('模型设置：读取 Pi 接受的 BOM、单行注释和尾逗号，不破坏字符串', async () => {
  const initial = fixtureConfig()
  initial.literal = 'https://example.test/a//b?value=\"//quoted\"'
  const json = JSON.stringify(initial, null, 2)
  const annotated =
    '\uFEFF// Pi configuration\n' +
    json.replace('"providers": {', '"providers": { // endpoints\n').replace(/\n}$/, ',\n}')
  await withFixture(annotated, async (store) => {
    const settings = L2ModelSettingsGetResponseSchema.parse(await store.readL4ModelSettings())
    assert.deepEqual(settings.nativeConfig, initial)
  })
  await withFixture('/* not supported by Pi */' + json, async (store) => {
    await assert.rejects(store.readL4ModelSettings(), /解析失败/)
  })
})

test('模型设置：请求头按实际生效层写回，移除时不重新暴露隐藏同名值', async () => {
  const initial = fixtureConfig()
  modelOf(initial).headers = { 'X-Shared': 'raw', 'X-Raw': 'keep' }
  providerOf(initial).modelOverrides = {
    'test-model': { headers: { 'X-Shared': 'hidden', 'X-Override': 'old' } }
  }
  await withFixture(initial, async (store, path) => {
    const settings = await store.readL4ModelSettings()
    const model = settings.providers[0].models[0]
    assert.deepEqual(model.headers, { 'X-Shared': 'raw', 'X-Raw': 'keep', 'X-Override': 'old' })
    model.headers = { 'X-Shared': 'new-raw', 'X-Raw': 'keep', 'X-Override': 'new-override' }
    await store.replaceL4ModelSettings({ providers: settings.providers })
    const saved = await readConfig(path)
    assert.equal((modelOf(saved).headers as Record<string, string>)['X-Shared'], 'new-raw')
    const overrides = providerOf(saved).modelOverrides as Record<
      string,
      Record<string, Record<string, string>>
    >
    assert.equal(overrides['test-model'].headers['X-Shared'], 'hidden')
    assert.equal(overrides['test-model'].headers['X-Override'], 'new-override')
    const next = await store.readL4ModelSettings()
    assert.deepEqual(next.providers[0].models[0].headers, model.headers)
    delete next.providers[0].models[0].headers['X-Shared']
    await store.replaceL4ModelSettings({ providers: next.providers })
    assert.equal(
      'X-Shared' in (await store.readL4ModelSettings()).providers[0].models[0].headers,
      false
    )
  })
})

test('模型目录：补充目录不可用时仍可使用 Pi 内置和自定义目录', async () => {
  await withFixture(fixtureConfig(), async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (): Promise<Response> => {
      throw new Error('fixture: supplemental catalog unavailable')
    }
    try {
      const { listL4ModelCatalog } = await jiti.import<
        typeof import('../src/server/l4_foundation/model-settings/l4-model-catalog-store')
      >('../src/server/l4_foundation/model-settings/l4-model-catalog-store.ts')
      const result = await listL4ModelCatalog({
        query: 'test-model',
        refresh: true,
        page: { index: 1, size: 10 }
      })
      assert.ok(
        result.models.some((item) =>
          item.sources.some(
            (source) => source.provider === 'fixture' && source.modelId === 'test-model'
          )
        )
      )
      assert.equal(result.refreshResult, 'partial')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
