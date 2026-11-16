import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createL2ModelSettingsBiz,
  saveL2ProjectDefaultChanges,
  type L2ModelSettingsBiz
} from '../src/client/l2_biz/settings/l2-model-settings-biz'
import {
  readL2ModelSettingsTab,
  readL2SettingsSection
} from '../src/client/l2_biz/settings/l2-settings-biz'

test('项目默认仅保存改变的 Owner，全局模式不写项目模型', async () => {
  const calls: unknown[] = []
  const biz: Pick<L2ModelSettingsBiz, 'replaceProjectDefault' | 'replaceCapabilityModeDefault'> = {
    async replaceProjectDefault(input): Promise<void> {
      calls.push(['model', input])
    },
    async replaceCapabilityModeDefault(input): Promise<void> {
      calls.push(['mode', input])
    }
  }
  assert.deepEqual(await saveL2ProjectDefaultChanges(biz, {}), { model: null, mode: null })
  assert.deepEqual(calls, [])
  const mode = await saveL2ProjectDefaultChanges(biz, { mode: { cwd: null, defaultMode: null } })
  assert.equal(mode.model, null)
  assert.equal(mode.mode?.status, 'fulfilled')
  assert.deepEqual(calls, [['mode', { cwd: null, defaultMode: null }]])
  calls.length = 0
  const model = await saveL2ProjectDefaultChanges(biz, {
    model: { cwd: '/fixture/project', default: null }
  })
  assert.equal(model.model?.status, 'fulfilled')
  assert.equal(model.mode, null)
  assert.deepEqual(calls, [['model', { cwd: '/fixture/project', default: null }]])
})

for (const failedOwner of ['model', 'mode'] as const) {
  test(`项目默认${failedOwner}失败仍报告另一 Owner 已成功，重试可只提交失败范围`, async () => {
    const calls: string[] = []
    let fail = true
    const failure = new Error(`${failedOwner} fixture failed`)
    const biz: Pick<L2ModelSettingsBiz, 'replaceProjectDefault' | 'replaceCapabilityModeDefault'> =
      {
        async replaceProjectDefault(): Promise<void> {
          calls.push('model')
          if (fail && failedOwner === 'model') throw failure
        },
        async replaceCapabilityModeDefault(): Promise<void> {
          calls.push('mode')
          if (fail && failedOwner === 'mode') throw failure
        }
      }
    const changes = {
      model: { cwd: '/fixture/project', default: null },
      mode: { cwd: '/fixture/project', defaultMode: null }
    }
    const result = await saveL2ProjectDefaultChanges(biz, changes)
    assert.equal(result.model?.status, failedOwner === 'model' ? 'rejected' : 'fulfilled')
    assert.equal(result.mode?.status, failedOwner === 'mode' ? 'rejected' : 'fulfilled')
    const failed = result[failedOwner]
    assert.equal(failed?.status === 'rejected' ? failed.reason : null, failure)
    fail = false
    calls.length = 0
    const retried = await saveL2ProjectDefaultChanges(
      biz,
      failedOwner === 'model' ? { model: changes.model } : { mode: changes.mode }
    )
    assert.deepEqual(calls, [failedOwner])
    assert.equal(retried[failedOwner]?.status, 'fulfilled')
  })
}

test('项目模式跟随、全开与固定 Key 使用独立 HTTP 请求并保留原生模型请求', async (t) => {
  const calls: Array<{ path: string; body: unknown; init: RequestInit }> = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const path = String(input)
      const body: unknown = JSON.parse(String(init.body))
      calls.push({ path, body, init })
      const data = path.endsWith('/capability-mode-defaults/get') ? { defaultMode: null } : {}
      return Response.json({ code: 0, msg: '', data })
    }
  )
  const clientId = 'c3c2c7e2-76ba-4f58-a432-78d265362471'
  const biz = createL2ModelSettingsBiz(clientId)
  assert.deepEqual(await biz.getCapabilityModeDefault(null), { defaultMode: null })
  await biz.replaceCapabilityModeDefault({ cwd: '/fixture/project' })
  await biz.replaceCapabilityModeDefault({ cwd: '/fixture/project', defaultMode: null })
  await biz.replaceCapabilityModeDefault({ cwd: '/fixture/project', defaultMode: 'review' })
  await biz.replaceProjectDefault({
    cwd: '/fixture/project',
    default: { provider: 'fixture', modelId: 'fixture-model', thinkingLevel: 'high' }
  })
  assert.deepEqual(
    calls.map(({ path, body }) => ({ path, body })),
    [
      { path: '/api/capability-mode-defaults/get', body: { cwd: null } },
      { path: '/api/capability-mode-defaults/replace', body: { cwd: '/fixture/project' } },
      {
        path: '/api/capability-mode-defaults/replace',
        body: { cwd: '/fixture/project', defaultMode: null }
      },
      {
        path: '/api/capability-mode-defaults/replace',
        body: { cwd: '/fixture/project', defaultMode: 'review' }
      },
      {
        path: '/api/project-model-default/replace',
        body: {
          cwd: '/fixture/project',
          default: { provider: 'fixture', modelId: 'fixture-model', thinkingLevel: 'high' }
        }
      }
    ]
  )
  for (const call of calls) {
    assert.equal(call.init.method, 'POST')
    assert.equal(new Headers(call.init.headers).get('X-Pi-Desk-Client-Id'), clientId)
  }
})

test('旧设置分类与常用组合继续恢复，旧项目默认页签迁至独立入口', (t) => {
  const values = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: { getItem: (key: string): string | null => values.get(key) ?? null } }
  })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  for (const section of [
    'appearance',
    'region',
    'habits',
    'auth',
    'environment',
    'about',
    'plugin:fixture:settings'
  ]) {
    values.set('pi-super:settings:section', section)
    assert.equal(readL2SettingsSection(), section)
  }
  values.set('pi-super:settings:section', 'models')
  values.set('pi-super:settings:model-tab', 'presets')
  assert.equal(readL2SettingsSection(), 'models')
  assert.equal(readL2ModelSettingsTab(), 'presets')
  values.set('pi-super:settings:model-tab', 'project-default')
  assert.equal(readL2SettingsSection(), 'project-default')
  assert.equal(readL2ModelSettingsTab(), 'providers')
})
