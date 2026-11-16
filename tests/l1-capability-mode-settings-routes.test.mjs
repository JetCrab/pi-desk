import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import Module from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  CapabilityModeSchema,
  SessionCapabilityRulesSchema
} from '@jetcrab/pi-desk-sdk/capabilities'
import * as contracts from '../src/common/l2_biz/capability-modes/l2-capability-modes-contract.ts'
import {
  L2ChatModelContextGetRequestSchema,
  L2ChatModelContextGetResponseSchema
} from '../src/common/l2_biz/chat/l2-chat-context-contract.ts'

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {}
  if (request === '@earendil-works/pi-coding-agent') {
    return { getAgentDir: () => process.env.PI_CODING_AGENT_DIR }
  }
  if (request.endsWith('/l4-capability-catalog')) {
    return { readL4CapabilityCatalog: async () => ({ tools: [], skills: [], plugins: {} }) }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { L4CapabilityModesStore } =
  await import('../src/server/l4_foundation/capability-modes/l4-capability-modes-store.ts')
const { POST: getPrompt } = await import('../src/app/api/system-prompt/get/route.ts')
const { POST: replacePrompt } = await import('../src/app/api/system-prompt/replace/route.ts')
const { POST: getDefaults } = await import('../src/app/api/capability-mode-defaults/get/route.ts')
const { POST: replaceDefaults } =
  await import('../src/app/api/capability-mode-defaults/replace/route.ts')
const { POST: replaceModes } = await import('../src/app/api/capability-modes/replace/route.ts')
Module._load = originalLoad

function post(path, payload) {
  return new Request(`http://localhost/api/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pi-Desk-Client-Id': 'bb81edd4-44c0-45c2-adf1-9557bfdd2e46'
    },
    body: JSON.stringify(payload)
  })
}

test('Schema：旧模式兼容，来源严格枚举，解析后空正文和预览空草稿有效', () => {
  assert.deepEqual(CapabilityModeSchema.parse({ name: '旧模式' }), { name: '旧模式' })
  for (const promptSource of ['global', 'none', 'custom']) {
    assert.equal(
      CapabilityModeSchema.parse({ name: '来源', promptSource }).promptSource,
      promptSource
    )
  }
  assert.equal(
    CapabilityModeSchema.safeParse({ name: '非法', promptSource: 'inherit' }).success,
    false
  )
  const rules = { tools: {}, skills: {}, capabilities: {} }
  assert.deepEqual(SessionCapabilityRulesSchema.parse(rules), rules)
  assert.equal(
    SessionCapabilityRulesSchema.parse({ ...rules, appendSystemPrompt: '' }).appendSystemPrompt,
    ''
  )
  const source = { workId: 'schema-fixture', sessionId: randomUUID(), branchId: 'branch' }
  assert.equal(
    L2ChatModelContextGetRequestSchema.parse({ source, previewAppendSystemPrompt: '' })
      .previewAppendSystemPrompt,
    ''
  )
  assert.deepEqual(
    L2ChatModelContextGetResponseSchema.parse({
      systemPrompt: '现有正文',
      baseSystemPrompt: '',
      tools: []
    }),
    {
      systemPrompt: '现有正文',
      baseSystemPrompt: '',
      tools: []
    }
  )
  assert.equal(
    contracts.L2CapabilityModeDefaultsReplaceRequestSchema.safeParse({ cwd: null }).success,
    false
  )
  assert.deepEqual(
    contracts.L2CapabilityModeDefaultsReplaceRequestSchema.parse({ cwd: '/project' }),
    { cwd: '/project' }
  )
})

test('HTTP：新App路由读写真实隔离资源，未知字段/Key/默认值为400，custom缺文件为500', async () => {
  const root = resolve('temp/pi/l1-capability-mode-settings-routes', `settings-api-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await Promise.all([agentDir, cwd].map((path) => mkdir(path, { recursive: true })))
  const previous = globalThis.__piDeskCapabilityModesStore
  const store = new L4CapabilityModesStore(agentDir)
  globalThis.__piDeskCapabilityModesStore = store
  const request = (path, input) => post(path, input)
  assert.equal((await getPrompt(request('system-prompt/get', {}))).status, 200)
  assert.deepEqual(
    await (await replacePrompt(request('system-prompt/replace', { content: '全局正文\n' }))).json(),
    { code: 0, msg: '', data: {} }
  )
  assert.deepEqual((await (await getPrompt(request('system-prompt/get', {}))).json()).data, {
    content: '全局正文\n'
  })
  const modes = { custom: { name: '独立模式', promptSource: 'custom' } }
  assert.equal(
    (
      await replaceModes(
        request('capability-modes/replace', { modes, promptContents: { custom: '' } })
      )
    ).status,
    200
  )
  assert.deepEqual(
    (await (await getPrompt(request('system-prompt/get', { modeKey: 'custom' }))).json()).data,
    { content: '' }
  )
  assert.equal(
    (
      await replaceDefaults(
        request('capability-mode-defaults/replace', { cwd: null, defaultMode: 'custom' })
      )
    ).status,
    200
  )
  assert.deepEqual(
    (await (await getDefaults(request('capability-mode-defaults/get', { cwd: null }))).json()).data,
    { defaultMode: 'custom' }
  )
  assert.equal(
    (await replaceDefaults(request('capability-mode-defaults/replace', { cwd, defaultMode: null })))
      .status,
    200
  )
  assert.deepEqual(
    (await (await getDefaults(request('capability-mode-defaults/get', { cwd }))).json()).data,
    { defaultMode: null }
  )
  assert.equal(
    (await replaceDefaults(request('capability-mode-defaults/replace', { cwd }))).status,
    200
  )
  assert.deepEqual(
    (await (await getDefaults(request('capability-mode-defaults/get', { cwd }))).json()).data,
    {}
  )
  for (const [handler, path, payload] of [
    [getPrompt, 'system-prompt/get', { modeKey: '' }],
    [getPrompt, 'system-prompt/get', { modeKey: '../unknown' }],
    [getPrompt, 'system-prompt/get', { path: 'arbitrary.md' }],
    [replacePrompt, 'system-prompt/replace', { content: '', modeKey: 'custom' }],
    [replaceModes, 'capability-modes/replace', { modes, promptContents: { unrelated: '正文' } }],
    [replaceModes, 'capability-modes/replace', { modes, content: '不允许正文进配置' }],
    [replaceDefaults, 'capability-mode-defaults/replace', { cwd: null }],
    [replaceDefaults, 'capability-mode-defaults/replace', { cwd, defaultMode: 'unknown' }],
    [getDefaults, 'capability-mode-defaults/get', { cwd: 'relative' }],
    [getDefaults, 'capability-mode-defaults/get', { cwd: join(cwd, 'missing') }],
    [getDefaults, 'capability-mode-defaults/get', { cwd: null, unknown: true }]
  ]) {
    const response = await handler(request(path, payload))
    assert.equal(response.status, 400, path)
    assert.equal((await response.json()).data, null)
  }
  assert.equal(
    (
      await getPrompt(
        new Request('http://localhost/api/system-prompt/get', { method: 'POST', body: '{' })
      )
    ).status,
    400
  )
  const yaml = await readFile(join(agentDir, 'config', 'pi-desk.yaml'), 'utf8')
  assert.ok(!yaml.includes('全局正文'))
  await rm(join(agentDir, 'config', 'system-prompts', 'modes'), { recursive: true })
  const missing = await getPrompt(request('system-prompt/get', { modeKey: 'custom' }))
  assert.equal(missing.status, 500)
  assert.match((await missing.json()).msg, /自定义提示词文件缺失/u)
  assert.equal(
    (
      await replaceModes(
        request('capability-modes/replace', { modes, promptContents: { custom: '显式修复' } })
      )
    ).status,
    200
  )
  assert.equal(await store.readPrompt('custom'), '显式修复')
  globalThis.__piDeskCapabilityModesStore = previous
  await rm(root, { recursive: true, force: true })
})
