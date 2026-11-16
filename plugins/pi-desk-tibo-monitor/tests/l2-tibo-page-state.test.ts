import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initialTiboPageState,
  prepareTiboSettings,
  tiboPageReducer
} from '../src/l2-browser-hooks.js'
import { defaultSettings, type TiboSettings, type TiboSnapshot } from '../src/l4-tibo-protocol.js'
import { DEFAULT_REGION } from '../src/l4-tibo-locale.js'

const selection = { provider: 'fixture', modelId: 'translator' }
const model = { ...selection, name: 'Fixture translator' }
const configured: TiboSettings = { ...defaultSettings(), enabled: true, model: selection }

function snapshot(settings: TiboSettings = defaultSettings()): TiboSnapshot {
  return {
    settings,
    status: {
      polling: false,
      translating: false,
      lastCheckedAt: null,
      lastSuccessAt: null,
      sourceUrl: null,
      error: null
    },
    records: []
  }
}

function opened(value: TiboSnapshot): ReturnType<typeof tiboPageReducer> {
  return tiboPageReducer(initialTiboPageState, { type: 'snapshot', snapshot: value })
}

test('只有默认配置且无记录时进入首次配置，已有配置或历史不被模型失效重置', () => {
  assert.equal(opened(snapshot()).view, 'setup')
  for (const settings of [
    { ...defaultSettings(), intervalSeconds: 300 },
    { ...defaultSettings(), retentionCount: 50 },
    { ...defaultSettings(), model: selection },
    configured
  ]) {
    assert.equal(opened(snapshot(settings)).view, 'posts')
  }
  const historical = snapshot()
  historical.records = [
    {
      id: 'x:100',
      title: '历史动态',
      preview: '已保存的正文',
      link: 'https://x.com/fixture/status/100',
      publishedAt: 100,
      quotePreview: null,
      resetLevel: null,
      translated: false
    }
  ]
  const existing = opened(historical)
  assert.equal(existing.view, 'posts')
  assert.deepEqual(existing.snapshot?.records, historical.records)
  assert.equal(tiboPageReducer(existing, { type: 'settings' }).view, 'settings')
})

test('首次提交使用实际Provider模型目录且启用监听，不修改原草稿', () => {
  const draft = { ...defaultSettings(), model: selection }
  const ready = prepareTiboSettings(draft, true, [model], false, DEFAULT_REGION)
  assert.equal(ready.error, null)
  assert.deepEqual(ready.settings, {
    enabled: true,
    intervalSeconds: 60,
    retentionCount: 100,
    model: { provider: 'fixture', modelId: 'translator' }
  })
  assert.equal(draft.enabled, false)

  const pending = prepareTiboSettings(draft, true, [model], true, DEFAULT_REGION)
  assert.equal(pending.settings, null)
  assert.match(pending.error ?? '', /loading/)
  for (const models of [[], [{ ...model, provider: 'other-provider' }]]) {
    const unavailable = prepareTiboSettings(draft, true, models, false, DEFAULT_REGION)
    assert.equal(unavailable.settings, null)
    assert.match(unavailable.error ?? '', /unavailable/)
  }
  assert.equal(
    prepareTiboSettings(defaultSettings(), true, [model], false, DEFAULT_REGION).settings,
    null
  )
})

test('后续停用允许保留失效模型，不会因读取模型失败强制继续监听', () => {
  const draft = { ...configured, enabled: false }
  assert.equal(prepareTiboSettings(draft, false, [], true, DEFAULT_REGION).error, null)
  assert.equal(prepareTiboSettings(configured, false, [], false, DEFAULT_REGION).settings, null)
})

test('间隔与保留条数沿用整数边界，拒绝小数、空数值和超范围', () => {
  for (const [intervalSeconds, retentionCount] of [
    [30, 10],
    [86400, 200]
  ]) {
    assert.equal(
      prepareTiboSettings(
        { ...configured, intervalSeconds, retentionCount },
        true,
        [model],
        false,
        DEFAULT_REGION
      ).error,
      null
    )
  }
  for (const intervalSeconds of [29, 86401, 30.5, Number.NaN]) {
    const result = prepareTiboSettings(
      { ...configured, intervalSeconds },
      false,
      [model],
      false,
      DEFAULT_REGION
    )
    assert.equal(result.settings, null)
    assert.match(result.error ?? '', /30 and 86400/)
  }
  for (const retentionCount of [9, 201, 10.5, Number.NaN]) {
    const result = prepareTiboSettings(
      { ...configured, retentionCount },
      false,
      [model],
      false,
      DEFAULT_REGION
    )
    assert.equal(result.settings, null)
    assert.match(result.error ?? '', /10 and 200/)
  }
})

test('编辑中状态刷新不覆盖草稿，保存失败保留输入，取消还原并返回阅读', () => {
  const original = snapshot(configured)
  let state = tiboPageReducer(opened(original), { type: 'settings' })
  const draft = { ...configured, intervalSeconds: 300, retentionCount: 50 }
  state = tiboPageReducer(state, { type: 'draft', settings: draft })
  state = tiboPageReducer(state, {
    type: 'snapshot',
    snapshot: snapshot({ ...configured, retentionCount: 20 })
  })
  assert.deepEqual(state.draft, draft)
  assert.deepEqual(state.saved, configured)

  state = tiboPageReducer(state, { type: 'saving' })
  for (const action of [
    { type: 'posts' } as const,
    { type: 'settings' } as const,
    { type: 'draft', settings: configured } as const
  ]) {
    assert.equal(tiboPageReducer(state, action), state, '保存中不能切换页面或改草稿')
  }
  state = tiboPageReducer(state, { type: 'save-failed', error: 'fixture: save failed' })
  assert.equal(state.view, 'settings')
  assert.equal(state.saving, false)
  assert.equal(state.error, 'fixture: save failed')
  assert.deepEqual(state.draft, draft)
  assert.deepEqual(state.saved, configured)

  state = tiboPageReducer(state, { type: 'posts' })
  assert.equal(state.view, 'posts')
  assert.deepEqual(state.draft, configured)
  assert.equal(state.error, null)
  assert.deepEqual(original.settings, configured)
})

test('保存成功只使用服务端返回快照，无记录仍为空态', () => {
  let state = opened(snapshot())
  state = tiboPageReducer(state, {
    type: 'draft',
    settings: { ...defaultSettings(), model: selection }
  })
  state = tiboPageReducer(state, { type: 'saving' })
  const result = snapshot(configured)
  state = tiboPageReducer(state, { type: 'saved', snapshot: result })
  assert.equal(state.view, 'posts')
  assert.equal(state.saving, false)
  assert.deepEqual(state.snapshot?.records, [])
  assert.deepEqual(state.saved, result.settings)
  assert.deepEqual(state.draft, result.settings)
})
