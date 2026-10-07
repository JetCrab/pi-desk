import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HostRegion, HostSettings } from '@jetcrab/pi-desk-sdk/settings'
import { TiboRuntime } from '../src/l2-tibo-runtime.js'
import { writeStore } from '../src/l4-tibo-storage.js'

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待地区缓存变更超时')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

test('后台分析读取共享地区，改变地区及重启后不误用旧缓存', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'tibo-shared-region-'))
  const path = join(root, 'store.json')
  context.after(() => rm(root, { recursive: true, force: true }))
  let region: HostRegion = { locale: 'en', timeZone: 'America/New_York' }
  const listeners = new Set<() => void>()
  const settings: HostSettings = {
    getSnapshot: () => ({ region }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  const regions: HostRegion[] = []
  const host = {
    setState() {},
    notifications: { publish: () => 'notice', update() {}, delete() {} }
  }
  await writeStore(path, {
    settings: {
      enabled: false,
      model: { provider: 'fixture', modelId: 'translator' },
      intervalSeconds: 60,
      retentionCount: 10
    },
    records: [
      {
        id: 'post',
        title: 'Post',
        text: 'Original text',
        publishedAt: 1000,
        link: 'https://x.com/alice/status/1',
        analysis: { translation: '旧中文译文', reset: { level: 'none', reason: '无' }, times: [] }
      }
    ]
  })
  const options = {
    path,
    settings,
    translate: async (
      _post: unknown,
      _model: unknown,
      _signal: AbortSignal,
      target: HostRegion
    ) => {
      regions.push({ ...target })
      return {
        translation: target.locale === 'en' ? 'English translation' : '中文译文',
        reset: { level: 'none' as const, reason: 'none' },
        times: []
      }
    }
  }
  let runtime = await TiboRuntime.create(host, options)
  context.after(() => runtime.dispose())
  assert.equal(
    (await runtime.translateRecord('post'))?.analysis?.translation,
    'English translation'
  )
  assert.deepEqual(regions, [{ locale: 'en', timeZone: 'America/New_York' }])
  region = { locale: 'zh-CN', timeZone: 'Asia/Kathmandu' }
  for (const listener of listeners) listener()
  assert.equal(runtime.snapshot().records[0]?.translated, false)
  assert.equal(runtime.snapshot().records[0]?.preview, 'Original text')
  await waitFor(() => runtime.record('post')?.analysis === null)
  assert.equal((await runtime.translateRecord('post'))?.analysis?.translation, '中文译文')
  assert.equal(runtime.record('post')?.text, 'Original text')
  assert.deepEqual(regions[1], region)
  await runtime.dispose()
  assert.equal(listeners.size, 0)
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(stored.analysisRegion, region)
  assert.equal('locale' in stored.settings, false)
  assert.equal('timeZone' in stored.settings, false)
  runtime = await TiboRuntime.create(host, options)
  await runtime.translateRecord('post')
  assert.equal(regions.length, 2, '同一地区重启应复用缓存')
  await runtime.dispose()
  region = { locale: 'en', timeZone: 'UTC' }
  runtime = await TiboRuntime.create(host, options)
  await runtime.translateRecord('post')
  assert.equal(regions.length, 3, '重启时地区变化应重新分析')
})
