import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { HostSettingsSchema } from '../plugins/pi-desk-sdk/src/settings.ts'
import { L4HostSettingsStore } from '../src/server/l4_foundation/l4-host-settings-store.ts'
import { L3AppRuntime } from '../src/server/l3_modules/app-runtime/l3-app-runtime.ts'
import { applyL3AppRuntimeEvent } from '../src/common/l3_modules/app-runtime/l3-app-runtime-state.ts'
import { L3AppRuntimeApplyRequestSchema } from '../src/common/l3_modules/app-runtime/l3-app-runtime-contract.ts'

async function fixture(context: test.TestContext): Promise<L4HostSettingsStore> {
  const base = resolve('temp/tests/shared-settings')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'persistent-region-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  return new L4HostSettingsStore(join(root, 'pi-desk-settings.json'), () => ({
    region: { locale: 'en', timeZone: 'UTC' }
  }))
}

test('共享设置只保存生效地区，串行合并修改且快照不可变', async (context) => {
  const store = await fixture(context)
  const first = store.getSnapshot()
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.region))
  assert.equal(Reflect.set(first.region, 'timeZone', 'Asia/Shanghai'), false)
  let updates = 0
  const unsubscribe = store.subscribe(() => {
    updates += 1
  })
  await Promise.all([
    store.update({ locale: 'zh-CN' }),
    store.update({ timeZone: 'America/New_York' })
  ])
  assert.deepEqual(store.getSnapshot(), {
    region: { locale: 'zh-CN', timeZone: 'America/New_York' }
  })
  assert.equal(updates, 2)
  unsubscribe()
  await store.update({ timeZone: 'Asia/Kathmandu' })
  assert.equal(updates, 2)
  assert.equal(
    HostSettingsSchema.safeParse({ region: { locale: 'en', timeZone: 'invalid-zone' } }).success,
    false
  )
  await assert.rejects(store.update({ timeZone: 'invalid-zone' }))
  assert.equal(store.getSnapshot().region.timeZone, 'Asia/Kathmandu')
})

test('服务重启读取已保存值而不是新的运行环境默认值', async (context) => {
  const base = resolve('temp/tests/shared-settings')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'restart-region-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'pi-desk-settings.json')
  const store = new L4HostSettingsStore(path, () => ({ region: { locale: 'en', timeZone: 'UTC' } }))
  await store.update({ locale: 'zh-CN', timeZone: 'Australia/Lord_Howe' })
  const restarted = new L4HostSettingsStore(path, () => {
    throw new Error('不应覆盖已有设置')
  })
  assert.deepEqual(restarted.getSnapshot(), store.getSnapshot())
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), store.getSnapshot())
})

test('共享设置通过现有应用快照与推送同步多个客户端并释放订阅', async (context) => {
  const store = await fixture(context)
  const runtime = new L3AppRuntime(store)
  let first = runtime.readSnapshot()
  let second = runtime.readSnapshot()
  let events = 0
  runtime.subscribe((event) => {
    first = applyL3AppRuntimeEvent(first, event)
    second = applyL3AppRuntimeEvent(second, event)
    events += 1
  })
  await runtime.applyClient({ key: 'settings', update: { region: { timeZone: 'Asia/Kolkata' } } })
  assert.equal(first.settings.region.timeZone, 'Asia/Kolkata')
  assert.deepEqual(second.settings, first.settings)
  assert.deepEqual(runtime.readSnapshot().settings, store.getSnapshot())
  assert.equal(events, 1)
  assert.equal(
    L3AppRuntimeApplyRequestSchema.safeParse({ key: 'settings', update: { region: {} } }).success,
    false
  )
  assert.equal(
    L3AppRuntimeApplyRequestSchema.safeParse({ key: 'settings', update: { arbitrary: true } })
      .success,
    false
  )
  runtime.dispose()
  await store.update({ timeZone: 'UTC' })
  assert.equal(events, 1)
})
