import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HostRegion } from '@jetcrab/pi-desk-sdk/settings'
import type { useTiboPage } from '../src/l2-browser-hooks.js'
import { TiboSettingsView } from '../src/views/l2-tibo-settings-view.js'
import { TiboFeedView } from '../src/views/l2-tibo-feed-view.js'
import { TiboPostView } from '../src/views/l2-tibo-post-view.js'
import { defaultSettings, type TiboRecord, type TiboSnapshot } from '../src/l4-tibo-protocol.js'

const region: HostRegion = { locale: 'zh-CN', timeZone: 'UTC' }
const selection = { provider: 'fixture', modelId: 'translator' }
const model = { ...selection, name: '实际目录模型' }
const snapshot: TiboSnapshot = {
  settings: defaultSettings(),
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

function pageState(
  overrides: Partial<ReturnType<typeof useTiboPage>> = {}
): ReturnType<typeof useTiboPage> {
  return {
    snapshot,
    view: 'setup',
    draft: defaultSettings(),
    models: [model],
    modelsLoading: false,
    modelsError: null,
    canSave: false,
    loading: false,
    saving: false,
    dirty: false,
    error: null,
    confirmingLeave: false,
    setDraft() {},
    async save() {},
    reload() {},
    confirmLeave() {},
    showSettings() {},
    async showPosts() {},
    cancelSettings() {},
    ...overrides
  }
}

test('首次三项配置直接可见，无页签或折叠，模型未就绪不能开始', () => {
  const html = renderToStaticMarkup(
    createElement(TiboSettingsView, {
      region,
      state: pageState({ modelsLoading: true })
    })
  )
  for (const label of ['翻译模型', '检查间隔（秒）', '保留动态（条）', '开始监听']) {
    assert.ok(html.includes(label), label)
  }
  assert.match(html, /正在读取模型/)
  assert.match(html, /min="30" max="86400" step="1"/)
  assert.match(html, /min="10" max="200" step="1"/)
  assert.match(html, /<button[^>]*disabled=""[^>]*>开始监听<\/button>/)
  assert.doesNotMatch(html, /<details|role="tab|启用监听|>取消</)
})

test('后续设置四项直接展示，模型读取错误和保存错误均可见且可恢复', () => {
  const draft = { ...defaultSettings(), enabled: true, model: selection, retentionCount: 50 }
  const html = renderToStaticMarkup(
    createElement(TiboSettingsView, {
      region,
      state: pageState({
        view: 'settings',
        draft,
        models: [],
        modelsError: 'fixture: model catalog failed',
        error: 'fixture: save failed',
        dirty: true
      })
    })
  )
  for (const label of [
    '翻译模型',
    '启用监听',
    '检查间隔（秒）',
    '保留动态（条）',
    'fixture: model catalog failed',
    'fixture: save failed',
    '重新读取模型',
    '保存设置',
    '取消'
  ]) {
    assert.ok(html.includes(label), label)
  }
  assert.match(html, /value="50"/)
  assert.doesNotMatch(html, /<details|更多设置|运行状态/)
})

test('可用模型使用实际目录名称；保存中禁止提交和取消', () => {
  const state = pageState({
    view: 'settings',
    draft: { ...defaultSettings(), enabled: true, model: selection },
    saving: true,
    dirty: true
  })
  const html = renderToStaticMarkup(createElement(TiboSettingsView, { region, state }))
  assert.ok(html.includes('实际目录模型'))
  assert.match(html, /<button[^>]*disabled=""[^>]*>保存中…<\/button>/)
  assert.match(html, /<button[^>]*disabled=""[^>]*>取消<\/button>/)
})

test('无动态保持真实空态，不显示配置统计或伪造正文，监听错误不会隐藏', () => {
  const html = renderToStaticMarkup(
    createElement(TiboFeedView, {
      region,
      snapshot: { ...snapshot, status: { ...snapshot.status, error: 'fixture: RSS failed' } },
      selectedId: null,
      error: 'fixture: snapshot failed',
      onSelectPost() {}
    })
  )
  assert.ok(html.includes('暂无动态'))
  assert.ok(html.includes('fixture: RSS failed'))
  assert.ok(html.includes('fixture: snapshot failed'))
  assert.doesNotMatch(html, /<article|上次检查|翻译模型|检查间隔|保留动态/)
})

test('历史摘要与正文保留译文、原文、时间、引用链接、重置信号和翻译重试', () => {
  const record: TiboRecord = {
    id: 'x:100',
    title: '夹具动态',
    text: 'Fixture original post',
    link: 'https://x.com/fixture/status/100',
    publishedAt: Date.UTC(2026, 0, 1, 12),
    quote: {
      author: 'Fixture author',
      text: 'Fixture original quote',
      link: 'https://x.com/fixture/status/99'
    },
    analysis: {
      translation: '来自真实DTO结构的译文',
      quoteTranslation: '来自真实DTO结构的引用译文',
      reset: { level: 'possible', reason: '夹具推测依据' },
      times: [{ source: 'today', localTime: '2026-01-01 12:00 UTC', assumption: '夹具时间依据' }]
    }
  }
  const history = {
    id: record.id,
    title: record.title,
    preview: '夹具历史摘要',
    link: record.link,
    publishedAt: record.publishedAt,
    quotePreview: '夹具历史引用',
    resetLevel: 'possible' as const,
    translated: true
  }
  const html = renderToStaticMarkup(
    createElement(
      TiboFeedView,
      {
        region,
        snapshot: { ...snapshot, records: [history, { ...history, id: 'x:99' }] },
        selectedId: record.id,
        error: null,
        onSelectPost() {}
      },
      createElement(TiboPostView, {
        record,
        region,
        link: record.link,
        loading: false,
        error: 'fixture: translation failed',
        onRetry() {}
      })
    )
  )
  for (const label of [
    '最近动态',
    '夹具历史摘要',
    '来自真实DTO结构的译文',
    'Fixture original post',
    '来自真实DTO结构的引用译文',
    'Fixture original quote',
    '可能重置 · 推测',
    '夹具推测依据',
    '夹具时间依据',
    '2026-01-01 12:00 UTC',
    'fixture: translation failed',
    '重试'
  ]) {
    assert.ok(html.includes(label), label)
  }
  assert.match(html, /href="https:\/\/x\.com\/fixture\/status\/100"/)
  assert.match(html, /href="https:\/\/x\.com\/fixture\/status\/99"/)
  assert.match(html, /dateTime="2026-01-01T12:00:00.000Z"/)
})
