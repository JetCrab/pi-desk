import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance, type Resource } from 'i18next'
import { L2_AUTH_MESSAGES } from '../src/common/l2_biz/auth/l2-auth-messages'
import { L2_CAPABILITY_MODE_MESSAGES } from '../src/common/l2_biz/capability-modes/l2-capability-mode-messages'
import { L2_PLUGIN_MANAGEMENT_MESSAGES } from '../src/common/l2_biz/plugin/l2-plugin-management-messages'
import { L2_PROJECT_HISTORY_MESSAGES } from '../src/common/l2_biz/project-preview/l2-project-history-messages'
import { L2_SETTINGS_MESSAGES } from '../src/common/l2_biz/settings/l2-settings-messages'
import { L2_SKILLS_MESSAGES } from '../src/common/l2_biz/settings/l2-skills-messages'
import { L2_TASK_CENTER_MESSAGES } from '../src/common/l2_biz/task-center/l2-task-center-messages'
import { L2_WORKBENCH_LOCALE_MESSAGES } from '../src/common/l2_biz/workbench/l2-workbench-locale-messages'
import { L2_WORKBENCH_PICKER_MESSAGES } from '../src/common/l2_biz/workbench/l2-workbench-picker-messages'
import { L3_CONVERSATION_LOCALE_MESSAGES } from '../src/common/l3_modules/conversation/l3-conversation-locale-messages'
import { L3_PROJECT_FILES_LOCALE_MESSAGES } from '../src/common/l3_modules/project-files/l3-project-files-locale-messages'
import {
  createL4BilingualText,
  L4LocalizedTextSchema,
  selectL4LocalizedText
} from '../src/common/l4_foundation/locale/l4-localized-text'
import { L4_HOST_ERROR_MESSAGES } from '../src/common/l4_foundation/locale/l4-host-error-messages'
import { L4_LOCALE_MESSAGES } from '../src/common/l4_foundation/locale/l4-locale-messages'
import {
  L4_LOCALE_STORAGE_KEY,
  L4_TIME_ZONE_STORAGE_KEY,
  resolveL4Locale,
  resolveL4TimeZone
} from '../src/common/l4_foundation/locale/l4-locale'
import {
  changeL3RegionLanguage,
  changeL3RegionTimeZone
} from '../src/client/l3_modules/region/l3-region-biz'
import {
  readL4Region,
  readL4HostSettings,
  replaceL4HostSettings,
  setL4RegionDisplayLocale,
  startL4Region
} from '../src/client/l4_foundation/locale/l4-region-store'
import {
  l4LocalizedErrorMessage,
  registerL4ErrorTranslator
} from '../src/client/l4_foundation/locale/l4-localized-error'

import type { L4AppSocketClient } from '../src/client/l4_foundation/realtime/app-socket/l4-app-socket'

const localeCatalogs: readonly {
  en: unknown
  'zh-CN': unknown
}[] = [
  L2_AUTH_MESSAGES,
  L2_CAPABILITY_MODE_MESSAGES,
  L2_PLUGIN_MANAGEMENT_MESSAGES,
  L2_PROJECT_HISTORY_MESSAGES,
  L2_SETTINGS_MESSAGES,
  L2_SKILLS_MESSAGES,
  L2_TASK_CENTER_MESSAGES,
  L2_WORKBENCH_LOCALE_MESSAGES,
  L2_WORKBENCH_PICKER_MESSAGES,
  L3_CONVERSATION_LOCALE_MESSAGES,
  L3_PROJECT_FILES_LOCALE_MESSAGES,
  L4_HOST_ERROR_MESSAGES,
  L4_LOCALE_MESSAGES
]

function leafKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, nested]) =>
    leafKeys(nested, prefix ? `${prefix}.${key}` : key)
  )
}

function commonResources(): Resource {
  return {
    en: { common: { ...L4_LOCALE_MESSAGES.en.common } },
    'zh-CN': { common: { ...L4_LOCALE_MESSAGES['zh-CN'].common } }
  }
}

class MemoryStorage {
  readonly values = new Map<string, string>()
  failReads = false
  failWrites = false

  getItem(key: string): string | null {
    if (this.failReads) throw new Error('storage unavailable')
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('storage unavailable')
    this.values.set(key, value)
  }
}

function installBrowser(languages: readonly string[]): {
  storage: MemoryStorage
  setConfirmResponse: (confirmed: boolean) => void
  getReloadCount: () => number
  dispatchStorage: (key: string | null) => void
  restore: () => void
} {
  const storage = new MemoryStorage()
  let confirmed = false
  let reloadCount = 0
  const windowTarget = Object.assign(new EventTarget(), {
    confirm: () => confirmed,
    location: {
      reload: () => {
        reloadCount += 1
      }
    }
  })
  const documentTarget = Object.assign(new EventTarget(), {
    visibilityState: 'visible'
  })
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of [
    ['window', windowTarget],
    ['document', documentTarget],
    ['navigator', { languages, language: languages[0] ?? 'en' }],
    ['localStorage', storage]
  ] as const) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value
    })
  }

  return {
    storage,
    setConfirmResponse: (value) => {
      confirmed = value
    },
    getReloadCount: () => reloadCount,
    dispatchStorage: (key) => {
      const event = new Event('storage')
      Object.defineProperty(event, 'key', { value: key })
      windowTarget.dispatchEvent(event)
    },
    restore: () => {
      for (const [key, descriptor] of [...globals.entries()].reverse()) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    }
  }
}

test('全部中英文资源使用相同词条键', () => {
  for (const catalog of localeCatalogs) {
    assert.deepEqual(leafKeys(catalog.en).sort(), leafKeys(catalog['zh-CN']).sort())
  }
})

test('中英文插值、0/1/2复数和缺失词条回退正常', async () => {
  const instance = createInstance()
  await instance.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: commonResources(),
    defaultNS: 'common',
    ns: ['common'],
    initAsync: false,
    interpolation: { escapeValue: false }
  })
  const english = instance.getFixedT('en', 'common')
  const chinese = instance.getFixedT('zh-CN', 'common')
  assert.equal(
    english('socketRequestTimeout', { path: 'chat/send' }),
    'WebSocket request timed out: chat/send'
  )
  assert.equal(
    chinese('socketRequestTimeout', { path: 'chat/send' }),
    'WebSocket 请求超时：chat/send'
  )
  for (const [count, expected] of [
    [0, '0 differences'],
    [1, '1 difference'],
    [2, '2 differences']
  ] as const) {
    assert.equal(english('diffCount', { count }), expected)
  }
  for (const count of [0, 1, 2]) {
    assert.equal(chinese('diffCount', { count }), `${count} 处差异`)
  }

  const fallback = createInstance()
  await fallback.init({
    lng: 'zh-CN',
    fallbackLng: 'en',
    resources: {
      en: { common: { englishOnly: 'English fallback' } },
      'zh-CN': { common: {} }
    },
    defaultNS: 'common',
    ns: ['common'],
    initAsync: false
  })
  assert.equal(fallback.t('englishOnly'), 'English fallback')
  assert.equal(fallback.t('missingKey'), 'missingKey')
})

test('LocalizedText保留Pi字符串并按语言选择实际双语说明', () => {
  const text = createL4BilingualText('中文说明', 'English description')
  assert.deepEqual(L4LocalizedTextSchema.parse(text), text)
  assert.equal(selectL4LocalizedText(text, 'zh-CN'), '中文说明')
  assert.equal(selectL4LocalizedText(text, 'en'), 'English description')
  assert.equal(selectL4LocalizedText('Pi 原始诊断', 'en'), 'Pi 原始诊断')

  registerL4ErrorTranslator((key) => (key === 'errors:known' ? 'Translated error' : null))
  try {
    assert.equal(
      l4LocalizedErrorMessage({ msg: 'Original server message', i18n: { key: 'errors:known' } }),
      'Translated error'
    )
    assert.equal(
      l4LocalizedErrorMessage({ msg: 'Original server message', i18n: { key: 'errors:missing' } }),
      'Original server message'
    )
  } finally {
    registerL4ErrorTranslator(null)
  }
})

test('共享地区只采用服务端快照，保存成功后按既有确认流程重载语言', async () => {
  assert.equal(resolveL4Locale(['zh-TW', 'en-US']), 'zh-CN')
  assert.equal(resolveL4Locale(['fr-FR']), 'en')
  assert.equal(resolveL4TimeZone('Not/AZone'), 'UTC')
  const browser = installBrowser(['fr-FR'])
  browser.storage.values.set(L4_LOCALE_STORAGE_KEY, 'en')
  browser.storage.values.set(L4_TIME_ZONE_STORAGE_KEY, 'Pacific/Honolulu')
  const stop = startL4Region()
  replaceL4HostSettings({ region: { locale: 'zh-CN', timeZone: 'UTC' } })
  const requests: unknown[] = []
  const appSocket = {
    request: async (
      _contract: unknown,
      input: { update: { region: { locale?: 'en' | 'zh-CN'; timeZone?: string } } }
    ) => {
      requests.push(input)
      replaceL4HostSettings({ region: { ...readL4HostSettings().region, ...input.update.region } })
      return {}
    }
  } as unknown as L4AppSocketClient
  try {
    assert.equal(readL4Region()?.timeZone, 'UTC')
    assert.equal(await changeL3RegionLanguage('en', 'confirm', appSocket, () => true), 'cancelled')
    browser.setConfirmResponse(true)
    assert.equal(await changeL3RegionLanguage('en', 'confirm', appSocket, () => false), 'blocked')
    assert.equal(requests.length, 0)
    assert.equal(await changeL3RegionLanguage('en', 'confirm', appSocket, () => true), 'changed')
    assert.equal(browser.getReloadCount(), 1)
    assert.equal(readL4Region()?.locale, 'zh-CN')
    assert.equal(readL4Region()?.pendingLocale, 'en')
    assert.equal(await changeL3RegionTimeZone('Asia/Kathmandu', appSocket), true)
    assert.equal(readL4Region()?.timeZone, 'Asia/Kathmandu')
    assert.deepEqual(requests, [
      { key: 'settings', update: { region: { locale: 'en' } } },
      { key: 'settings', update: { region: { timeZone: 'Asia/Kathmandu' } } }
    ])
    assert.equal(browser.storage.values.get(L4_TIME_ZONE_STORAGE_KEY), 'Pacific/Honolulu')
  } finally {
    stop()
    browser.restore()
  }
})

test('共享设置保存失败不产生本地权威覆盖', async () => {
  const browser = installBrowser(['en'])
  const stop = startL4Region()
  replaceL4HostSettings({ region: { locale: 'en', timeZone: 'UTC' } })
  const appSocket = {
    request: async () => {
      throw new Error('offline')
    }
  } as unknown as L4AppSocketClient
  try {
    assert.equal(await changeL3RegionTimeZone('America/New_York', appSocket), false)
    assert.equal(readL4Region()?.timeZone, 'UTC')
    browser.dispatchStorage(null)
    assert.equal(readL4Region()?.timeZone, 'UTC')
  } finally {
    stop()
    browser.restore()
  }
})

test('登录页临时展示语言不影响共享地区，服务端更新仍建立正确基线', () => {
  const browser = installBrowser(['en'])
  const stop = startL4Region()
  replaceL4HostSettings({ region: { locale: 'zh-CN', timeZone: 'Asia/Shanghai' } })
  try {
    setL4RegionDisplayLocale('en')
    assert.equal(readL4Region()?.locale, 'en')
    assert.deepEqual(readL4HostSettings().region, { locale: 'zh-CN', timeZone: 'Asia/Shanghai' })
    assert.equal(browser.storage.values.size, 0)
    replaceL4HostSettings({ region: { locale: 'en', timeZone: 'America/New_York' } })
    assert.equal(readL4Region()?.timeZone, 'America/New_York')
    assert.equal(readL4Region()?.pendingLocale, null)
  } finally {
    stop()
    browser.restore()
  }
})

test('夏令时只影响区域化展示，不改变Unix毫秒时间点', () => {
  const before = Date.parse('2024-03-10T06:30:00.000Z')
  const after = Date.parse('2024-03-10T07:30:00.000Z')
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit'
  })
  assert.equal(formatter.format(before), '1:30 AM')
  assert.equal(formatter.format(after), '3:30 AM')
  assert.equal(after - before, 60 * 60 * 1000)
})
