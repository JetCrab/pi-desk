import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import {
  readL4CodePreferences,
  saveL4CodePreferences,
  subscribeL4CodePreferences
} from '../src/client/l4_foundation/ui/code/l4-code-preferences'
import { L3ProjectFileRuntime } from '../src/client/l3_modules/project-files/l3-project-file-runtime'
import type { L3ProjectFileReader } from '../src/client/l3_modules/project-files/l3-project-reader'

const STORAGE_KEY = 'pi-super:code-preferences'
const LEGACY_KEY = 'pi-super:project-preview:global'

class Browser extends EventTarget {
  readonly values = new Map<string, string>()
  readonly localStorage = {
    getItem: (key: string): string | null => this.values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      this.values.set(key, value)
    }
  }

  changed(key: string | null): void {
    const event = new Event('storage')
    Object.defineProperty(event, 'key', { value: key })
    this.dispatchEvent(event)
  }
}

function browserFixture(initial: Record<string, string> = {}): {
  browser: Browser
  dispose: () => void
} {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const browser = new Browser()
  for (const [key, value] of Object.entries(initial)) browser.values.set(key, value)
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  const unsubscribe = subscribeL4CodePreferences(() => undefined)
  return {
    browser,
    dispose(): void {
      unsubscribe()
      if (previous) Object.defineProperty(globalThis, 'window', previous)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  }
}

const reader: L3ProjectFileReader = {
  async list() {
    return { entries: [], truncated: false }
  },
  async search() {
    return { matches: [], truncated: false }
  },
  async get(path) {
    return { kind: 'text', content: path, size: path.length }
  },
  async diff(_root, path) {
    return {
      kind: 'text',
      original: { path, content: 'before' },
      modified: { path, content: 'after' }
    }
  }
}

function runtime(): L3ProjectFileRuntime {
  return new L3ProjectFileRuntime('C:/project', reader, { imagePreviewMode: () => 'compressed' })
}

test('代码偏好默认换行，保存开启和关闭，并向同页面消费者和其他标签页同步', () => {
  const fixture = browserFixture()
  const seen: boolean[] = []
  const unsubscribe = subscribeL4CodePreferences(() => seen.push(readL4CodePreferences().wrapLines))
  try {
    assert.deepEqual(readL4CodePreferences(), {
      wrapLines: true,
      diffViewMode: 'side-by-side',
      collapseUnchanged: true
    })
    saveL4CodePreferences({ wrapLines: false })
    assert.equal(readL4CodePreferences().wrapLines, false)
    assert.equal(JSON.parse(fixture.browser.values.get(STORAGE_KEY)!).wrapLines, false)
    saveL4CodePreferences({ diffViewMode: 'inline', collapseUnchanged: false })
    assert.deepEqual(JSON.parse(fixture.browser.values.get(STORAGE_KEY)!), {
      wrapLines: false,
      diffViewMode: 'inline',
      collapseUnchanged: false
    })
    fixture.browser.values.set(STORAGE_KEY, JSON.stringify({ wrapLines: true }))
    fixture.browser.changed(STORAGE_KEY)
    assert.equal(readL4CodePreferences().wrapLines, true)
    assert.deepEqual(seen, [false, false, true])
    fixture.browser.values.clear()
    fixture.browser.changed(null)
    assert.equal(readL4CodePreferences().wrapLines, true)
  } finally {
    unsubscribe()
    fixture.dispose()
  }
})

test('迁移旧项目预览换行选择，不覆盖已有统一偏好或修改旧布局', () => {
  const legacy = JSON.stringify({ wrapLines: false, maximized: true })
  const fixture = browserFixture({ [LEGACY_KEY]: legacy })
  try {
    assert.equal(readL4CodePreferences().wrapLines, false)
    assert.equal(JSON.parse(fixture.browser.values.get(STORAGE_KEY)!).wrapLines, false)
    assert.equal(fixture.browser.values.get(LEGACY_KEY), legacy)
    fixture.browser.values.set(LEGACY_KEY, JSON.stringify({ wrapLines: true }))
    fixture.browser.changed(STORAGE_KEY)
    assert.equal(readL4CodePreferences().wrapLines, false)
  } finally {
    fixture.dispose()
  }
})

test('文件和 Diff 共用选择，切换、重新加载、关闭重开不恢复默认', async () => {
  const fixture = browserFixture()
  const first = runtime()
  const second = runtime()
  try {
    first.openFile('a.ts')
    second.openFile('b.ts')
    await setImmediate()
    first.setWrapLines('a.ts', false)
    assert.equal(readL4CodePreferences().wrapLines, false)
    first.reloadFile('a.ts')
    await setImmediate()
    first.closeTabs('a.ts', 'current')
    first.openFile('a.ts')
    await setImmediate()
    assert.equal(readL4CodePreferences().wrapLines, false)

    second.openDiff('', 'b.ts')
    await setImmediate()
    second.setDiffWrapLines(true)
    second.setDiffViewMode('inline')
    second.setDiffCollapseUnchanged(false)
    second.reloadDiff()
    await setImmediate()
    second.openDiff('', 'c.ts')
    await setImmediate()
    assert.deepEqual(readL4CodePreferences(), {
      wrapLines: true,
      diffViewMode: 'inline',
      collapseUnchanged: false
    })
    first.setWrapLines('a.ts', false)
    assert.equal(readL4CodePreferences().wrapLines, false)
    assert.equal(readL4CodePreferences().diffViewMode, 'inline')
  } finally {
    first.dispose()
    second.dispose()
    fixture.dispose()
  }
})

test('损坏的偏好记录回退默认设置，释放订阅后不再处理旧页面事件', () => {
  const fixture = browserFixture({ [STORAGE_KEY]: '{broken' })
  assert.equal(readL4CodePreferences().wrapLines, true)
  fixture.dispose()
  const next = browserFixture({ [STORAGE_KEY]: JSON.stringify({ wrapLines: false }) })
  try {
    fixture.browser.changed(null)
    assert.equal(readL4CodePreferences().wrapLines, false)
  } finally {
    next.dispose()
  }
})
