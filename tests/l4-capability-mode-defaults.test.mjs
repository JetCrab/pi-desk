import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import Module from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {}
  if (request === '@earendil-works/pi-coding-agent') {
    return { getAgentDir: () => process.env.PI_CODING_AGENT_DIR }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { L4CapabilityModesStore } =
  await import('../src/server/l4_foundation/capability-modes/l4-capability-modes-store.ts')
const { bindConfigStore } = await import('@jetcrab/pi-desk-sdk/config')
Module._load = originalLoad

async function fixture() {
  const root = resolve('temp/pi/l4-capability-mode-defaults', `default-inheritance-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const other = join(root, 'other-project')
  const child = join(cwd, 'child')
  await Promise.all([agentDir, cwd, other, child].map((path) => mkdir(path, { recursive: true })))
  const config = bindConfigStore('pi-desk', 'capability-modes', { agentDir })
  return { root, agentDir, cwd, other, child, config, store: new L4CapabilityModesStore(agentDir) }
}

test('S2-T05：缺字段继承全局，null明确全开，项目原始层与父目录无关', async () => {
  const item = await fixture()
  const { store, cwd, child } = item
  assert.deepEqual(await store.readDefault(null), { defaultMode: null })
  assert.deepEqual(await store.readDefault(cwd), {})
  await store.replace({ global: { name: '全局模式' }, project: { name: '项目模式' } })
  await store.replaceDefault({ cwd: null, defaultMode: 'global' })
  assert.equal(await store.resolveDefault(cwd), 'global')
  await store.replaceDefault({ cwd, defaultMode: null })
  assert.equal(await store.resolveDefault(cwd), null)
  assert.equal(await store.resolveDefault(child), 'global')
  await store.replaceDefault({ cwd, defaultMode: 'project' })
  assert.equal(await store.resolveDefault(cwd), 'project')
  await store.replaceDefault({ cwd })
  assert.deepEqual(await store.readDefault(cwd), {})
  assert.equal(await store.resolveDefault(cwd), 'global')
  await assert.rejects(store.replaceDefault({ cwd: null }), /显式指定/u)
  await assert.rejects(store.replaceDefault({ cwd, defaultMode: 'unknown' }), /能力模式不存在/u)
  await assert.rejects(store.readDefault('relative'), /绝对普通目录/u)
  await assert.rejects(store.readDefault(join(cwd, 'missing')), /绝对普通目录/u)
  await rm(item.root, { recursive: true, force: true })
})

test('S2-T05：失效项目引用回退全局并记录定位，失效全局回退全开，不重写历史引用', async (context) => {
  const item = await fixture()
  await item.store.replace({ current: { name: '有效模式' } })
  await item.config.set({ modes: item.store.read(), defaultMode: 'current' })
  await item.config.set({ defaultMode: 'deleted' }, { cwd: item.cwd })
  const warnings = []
  context.mock.method(console, 'warn', (...args) => {
    warnings.push(args)
  })
  assert.deepEqual(await item.store.readDefault(item.cwd), { defaultMode: 'deleted' })
  assert.equal(await item.store.resolveDefault(item.cwd), 'current')
  assert.ok(warnings.some((args) => args[1]?.cwd === item.cwd && args[1]?.modeKey === 'deleted'))
  await item.config.set({ modes: item.store.read(), defaultMode: 'deleted-global' })
  assert.equal(await item.store.resolveDefault(item.cwd), null)
  assert.ok(warnings.some((args) => args[1]?.cwd === null && args[1]?.modeKey === 'deleted-global'))
  assert.deepEqual(await item.store.readDefault(item.cwd), { defaultMode: 'deleted' })
  await rm(item.root, { recursive: true, force: true })
})

test('S2-T05：模式保存保留全局defaultMode，项目保存保留同节和其他分组，不扫改其他项目', async () => {
  const item = await fixture()
  await item.config.set({
    modes: { current: { name: '原模式' } },
    defaultMode: 'current',
    extra: true
  })
  await item.config.set({ defaultMode: 'current', projectField: { keep: 1 } }, { cwd: item.cwd })
  const unrelated = bindConfigStore('pi-desk', 'preferences', { agentDir: item.agentDir })
  await unrelated.set({ keep: '项目其他字段' }, { cwd: item.cwd })
  await item.config.set({ defaultMode: 'current' }, { cwd: item.other })
  const otherPath = join(item.other, '.pi', 'pi-desk.yaml')
  const otherBefore = await readFile(otherPath, 'utf8')
  await item.store.replace({ current: { name: '重命名' } })
  assert.deepEqual(await item.config.get({ inherit: false }), {
    modes: { current: { name: '重命名' } },
    defaultMode: 'current',
    extra: true
  })
  await item.store.replaceDefault({ cwd: item.cwd })
  assert.deepEqual(await item.config.get({ cwd: item.cwd, inherit: false }), {
    projectField: { keep: 1 }
  })
  assert.deepEqual(await unrelated.get({ cwd: item.cwd, inherit: false }), { keep: '项目其他字段' })
  await item.store.replace({})
  assert.deepEqual(await item.store.readDefault(null), { defaultMode: null })
  assert.equal(await readFile(otherPath, 'utf8'), otherBefore)
  assert.deepEqual(await item.store.readDefault(item.other), { defaultMode: 'current' })
  assert.equal(await item.store.resolveDefault(item.other), null)
  await rm(item.root, { recursive: true, force: true })
})
