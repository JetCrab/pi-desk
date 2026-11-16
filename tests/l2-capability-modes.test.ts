import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { isCapabilityAllowed } from '@jetcrab/pi-desk-sdk/capabilities'
import type { L3CapabilityModes } from '../src/common/l3_modules/capability-modes/l3-capability-modes-contract'
import { L2CapabilityModesReplaceRequestSchema } from '../src/common/l2_biz/capability-modes/l2-capability-modes-contract'
import {
  l2AcceptCapabilitySave,
  l2AddCapabilityDraft,
  l2CapabilityModeSubmission,
  l2DirtyCapabilityItems,
  l2DiscardCapabilityItem,
  l2EmptyCapabilityDrafts,
  l2ForgetCapabilityMode,
  l2InitializeCapabilityDrafts,
  type L2CapabilityDrafts
} from '../src/client/l2_biz/capability-modes/l2-capability-modes-drafts'
import {
  l2CapabilityGroups,
  l2CapabilityRule,
  l2ReplaceCapabilityRule,
  l2ToggleCapability
} from '../src/client/l2_biz/capability-modes/l2-capability-modes-model'
import { createL2CapabilityModesBiz } from '../src/client/l2_biz/capability-modes/l2-capability-modes-biz'
import { L2CapabilityModeList } from '../src/client/l2_biz/capability-modes/views/l2-capability-mode-list'

function fixture(): L2CapabilityDrafts {
  const modes: L3CapabilityModes = {
    a: { name: 'Alpha', promptSource: 'custom', tools: { allow: ['read*'] } },
    b: { name: 'Beta', promptSource: 'global' }
  }
  return {
    saved: modes,
    modes: structuredClone(modes),
    global: { saved: 'global saved\n', content: 'global draft\n' },
    prompts: { a: { saved: 'alpha saved\n', content: 'alpha draft\n' } }
  }
}

test('初始模型不生成预设模式或默认配置', () => {
  const state = l2EmptyCapabilityDrafts()
  assert.deepEqual(state.modes, {})
  assert.deepEqual(l2DirtyCapabilityItems(state), [])
  const added = l2AddCapabilityDraft({ ...state, saved: {} }, 'new', 'New mode')
  assert.deepEqual(l2CapabilityModeSubmission(added, 'new'), {
    modes: { new: { name: 'New mode' } }
  })
})

test('按需初始化保留全局草稿和服务端完整规则，后续保存不以名称占位覆盖其他模式', () => {
  const state = l2EmptyCapabilityDrafts()
  state.global = { saved: 'saved global', content: 'unsaved global draft' }
  const modes: L3CapabilityModes = {
    existing: {
      name: 'Existing mode',
      promptSource: 'none',
      tools: { allow: ['read*', 'future-name'], deny: ['read-secret*'] },
      plugins: { unknown: { roles: { deny: ['future-role*'] } } }
    }
  }
  const initialized = l2InitializeCapabilityDrafts(state, modes)
  assert.deepEqual(initialized.global, state.global)
  assert.deepEqual(initialized.saved, modes)
  assert.notEqual(initialized.modes.existing, modes.existing)
  const added = l2AddCapabilityDraft(initialized, 'new', 'New mode')
  const request = l2CapabilityModeSubmission(added, 'new')
  assert.deepEqual(request.modes.existing, modes.existing)
  assert.equal(request.promptContents, undefined)
  added.modes.existing!.name = 'Unsaved rename'
  const refreshed = l2InitializeCapabilityDrafts(added, { existing: { name: 'Remote name' } })
  assert.equal(refreshed.modes.existing!.name, 'Unsaved rename')
  assert.deepEqual(refreshed.saved, modes)
})

test('尚未读取真实模式时列表只展示现有名称，不虚构提示词来源', async () => {
  const i18n = createInstance()
  await i18n.init({
    lng: 'en',
    resources: {
      en: {
        capabilityModes: {
          sourceGlobal: 'SOURCE_GLOBAL',
          sourceNone: 'SOURCE_NONE',
          sourceCustom: 'SOURCE_CUSTOM'
        }
      }
    }
  })
  const state = l2EmptyCapabilityDrafts()
  const render = (drafts: L2CapabilityDrafts): string =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(L2CapabilityModeList, {
          drafts,
          modeNames: { existing: 'Existing custom mode' },
          selected: { kind: 'global' },
          query: '',
          disabled: false,
          onQuery: () => {},
          onSelect: () => {}
        })
      )
    )
  const namesOnly = render(state)
  assert.match(namesOnly, /Existing custom mode/)
  assert.doesNotMatch(namesOnly, /SOURCE_GLOBAL|SOURCE_CUSTOM|SOURCE_NONE/)
  assert.deepEqual(state.modes, {})
  const loaded = render(
    l2InitializeCapabilityDrafts(state, {
      existing: { name: 'Existing custom mode', promptSource: 'custom' }
    })
  )
  assert.match(loaded, /SOURCE_CUSTOM/)
})

test('保存当前模式仅提交已保存全集与当前差异，不带其他模式或全局草稿', () => {
  const state = fixture()
  state.modes.a!.name = 'Alpha renamed'
  state.modes.b!.name = 'Beta draft'
  state.prompts.b = { saved: 'beta saved', content: 'beta draft' }
  const request = l2CapabilityModeSubmission(state, 'a')
  assert.equal(request.modes.a!.name, 'Alpha renamed')
  assert.equal(request.modes.b!.name, 'Beta')
  assert.deepEqual(request.promptContents, { a: 'alpha draft\n' })
  assert.equal(state.saved!.a!.name, 'Alpha')
  assert.equal(state.modes.b!.name, 'Beta draft')
})

test('部分模式保存成功后收敛成功草稿，失败草稿与全局草稿保持可重试', () => {
  let state = fixture()
  state.modes.b!.name = 'Beta draft'
  state = l2AcceptCapabilitySave(state, 'a', l2CapabilityModeSubmission(state, 'a'))
  assert.deepEqual(l2DirtyCapabilityItems(state), [{ kind: 'global' }, { kind: 'mode', key: 'b' }])
  assert.equal(state.saved!.a!.name, 'Alpha')
  assert.equal(state.prompts.a!.saved, 'alpha draft\n')
  const retry = l2CapabilityModeSubmission(state, 'b')
  assert.equal(retry.modes.a!.name, 'Alpha')
  assert.equal(retry.modes.b!.name, 'Beta draft')
  assert.equal(retry.promptContents, undefined)
})

test('复制使用独立Key、能力规则副本和专属正文，即使来源当前沿用全局', () => {
  const state = fixture()
  state.modes.a!.promptSource = 'global'
  const copy = l2AddCapabilityDraft(state, 'copy', 'Alpha copy', 'a', state.prompts.a!.content)
  copy.modes.copy!.tools!.allow!.push('write')
  copy.prompts.copy!.content = 'independent copy'
  assert.deepEqual(state.modes.a!.tools!.allow, ['read*'])
  assert.equal(state.prompts.a!.content, 'alpha draft\n')
  const request = l2CapabilityModeSubmission(copy, 'copy')
  assert.equal(request.modes.copy!.promptSource, 'global')
  assert.deepEqual(request.promptContents, { copy: 'independent copy' })
  assert.equal(request.modes.a!.promptSource, 'custom')
})

test('重命名不改变Key，切换来源保留正文，空custom正文可提交', () => {
  const state = fixture()
  state.modes.a = { ...state.modes.a!, name: 'Renamed', promptSource: 'none' }
  assert.deepEqual(l2CapabilityModeSubmission(state, 'a').promptContents, { a: 'alpha draft\n' })
  state.modes.a.promptSource = 'global'
  assert.equal(state.prompts.a!.content, 'alpha draft\n')
  state.modes.a.promptSource = 'custom'
  state.prompts.a!.content = ''
  const request = L2CapabilityModesReplaceRequestSchema.parse(
    l2CapabilityModeSubmission(state, 'a')
  )
  assert.equal(request.modes.a!.name, 'Renamed')
  assert.equal(request.modes.a!.promptSource, 'custom')
  assert.deepEqual(request.promptContents, { a: '' })
})

test('未修改正文不随元数据保存重复提交，空副本仍显式保存独立正文', () => {
  const state = fixture()
  state.prompts.a!.content = state.prompts.a!.saved!
  state.modes.a!.name = 'Rename only'
  assert.equal(l2CapabilityModeSubmission(state, 'a').promptContents, undefined)
  const copy = l2AddCapabilityDraft(state, 'copy', 'Copy', 'a', '')
  assert.deepEqual(l2CapabilityModeSubmission(copy, 'copy').promptContents, { copy: '' })
})

test('放弃当前项不清除其他草稿，新建项可移除；全部放弃恢复全部已保存项', () => {
  let state = fixture()
  state.modes.b!.name = 'Beta draft'
  state = l2AddCapabilityDraft(state, 'new', 'New')
  state = l2DiscardCapabilityItem(state, { kind: 'mode', key: 'a' })
  assert.equal(state.prompts.a!.content, 'alpha saved\n')
  assert.equal(state.modes.b!.name, 'Beta draft')
  assert.equal(state.global!.content, 'global draft\n')
  state = l2DirtyCapabilityItems(state).reduce(l2DiscardCapabilityItem, state)
  assert.deepEqual(l2DirtyCapabilityItems(state), [])
  assert.equal(state.modes.new, undefined)
  assert.equal(state.global!.content, 'global saved\n')
})

test('删除成功后只移除目标模式和正文，保留其他草稿与保存基线', () => {
  const state = fixture()
  state.modes.b!.name = 'Beta draft'
  const next = l2ForgetCapabilityMode(state, 'a')
  assert.equal(next.saved!.a, undefined)
  assert.equal(next.modes.a, undefined)
  assert.equal(next.prompts.a, undefined)
  assert.equal(next.saved!.b!.name, 'Beta')
  assert.equal(next.modes.b!.name, 'Beta draft')
  assert.deepEqual(next.global, state.global)
})

test('读取失败后的显式重写草稿可保存空内容，放弃恢复未读取状态', () => {
  const state = fixture()
  state.global = { saved: null, content: '' }
  state.prompts.a = { saved: null, content: '' }
  assert.deepEqual(l2CapabilityModeSubmission(state, 'a').promptContents, { a: '' })
  assert.equal(l2DiscardCapabilityItem(state, { kind: 'global' }).global, null)
  assert.equal(l2DiscardCapabilityItem(state, { kind: 'mode', key: 'a' }).prompts.a, undefined)
})

test('能力开关表示最终可用：缺省全开、allow空全关、deny优先', () => {
  assert.equal(isCapabilityAllowed({}, 'read'), true)
  assert.equal(isCapabilityAllowed({ allow: [] }, 'read'), false)
  assert.equal(isCapabilityAllowed({ allow: ['*'], deny: ['read'] }, 'read'), false)
  const off = l2ToggleCapability({}, 'read', false)
  assert.equal(isCapabilityAllowed(off.rule, 'read'), false)
  assert.equal(isCapabilityAllowed(off.rule, 'write'), true)
  const on = l2ToggleCapability({ allow: [] }, 'read', true)
  assert.equal(isCapabilityAllowed(on.rule, 'read'), true)
  assert.equal(isCapabilityAllowed(on.rule, 'write'), false)
})

test('单项开关不展开通配规则，匹配禁用通配需显式确认且保留不相关规则', () => {
  const rule = { allow: ['read*', 'future-tool'], deny: ['read-secret*', 'other*'] }
  const disabled = l2ToggleCapability(rule, 'read-file', false)
  assert.deepEqual(disabled.rule.allow, ['read*', 'future-tool'])
  assert.equal(isCapabilityAllowed(disabled.rule, 'read-newly-installed'), true)
  const enabled = l2ToggleCapability(rule, 'read-secret-file', true)
  assert.deepEqual(enabled.removedPatterns, ['read-secret*'])
  assert.deepEqual(enabled.rule.deny, ['other*'])
  assert.deepEqual(enabled.rule.allow, ['read*', 'future-tool'])
  assert.deepEqual(rule.deny, ['read-secret*', 'other*'])
})

test('目录按插件声明动态分组，未知插件及名称规则在其他组编辑后不丢失', () => {
  const mode = {
    name: 'Mode',
    tools: { allow: ['read*', 'not-discovered'] },
    plugins: { subagent: { roles: { deny: ['future-role*'] } }, unknown: { extra: { allow: [] } } }
  }
  const groups = l2CapabilityGroups(
    {
      tools: [],
      skills: [],
      plugins: { subagent: { roles: { label: 'Agent roles', options: [{ value: 'research' }] } } }
    },
    mode,
    'Tools'
  )
  assert.equal(groups.length, 4)
  const roles = groups.find((group) => group.label === 'Agent roles')!
  assert.deepEqual(roles.target, { kind: 'plugin', pluginName: 'subagent', group: 'roles' })
  assert.deepEqual(l2CapabilityRule(mode, roles.target), { deny: ['future-role*'] })
  const next = l2ReplaceCapabilityRule(mode, { kind: 'tools' }, { deny: ['bash'] })
  assert.deepEqual(next.plugins, mode.plugins)
  const pluginChanged = l2ReplaceCapabilityRule(mode, roles.target, { allow: ['research'] })
  assert.deepEqual(pluginChanged.tools, mode.tools)
  assert.deepEqual(pluginChanged.plugins!.unknown, mode.plugins.unknown)
})

test('业务通过统一API读取正文、全局独立保存、模式复合保存及空追加预览', async (t) => {
  const calls: Array<{ path: string; body: unknown; init: RequestInit }> = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const path = String(input)
      calls.push({ path, init, body: JSON.parse(String(init.body)) })
      const data =
        path === '/api/system-prompt/get'
          ? { content: 'saved\n' }
          : path === '/api/chat/context/get'
            ? { systemPrompt: 'base', baseSystemPrompt: 'base', tools: [] }
            : {}
      return Response.json({ code: 0, msg: '', data })
    }
  )
  const biz = createL2CapabilityModesBiz('444590a0-c0bd-46e1-a747-2810977bcd38')
  assert.equal(await biz.getPrompt(), 'saved\n')
  await biz.getPrompt('a')
  await biz.replaceGlobalPrompt('global\n\n')
  await biz.replace({
    modes: { a: { name: 'Alpha', promptSource: 'custom' } },
    promptContents: { a: '' }
  })
  const source = { workId: 'work', sessionId: 'session', branchId: 'branch' }
  const preview = await biz.preview(source, '')
  assert.equal(preview.baseSystemPrompt, 'base')
  assert.deepEqual(
    calls.map(({ path, body }) => ({ path, body })),
    [
      { path: '/api/system-prompt/get', body: {} },
      { path: '/api/system-prompt/get', body: { modeKey: 'a' } },
      { path: '/api/system-prompt/replace', body: { content: 'global\n\n' } },
      {
        path: '/api/capability-modes/replace',
        body: { modes: { a: { name: 'Alpha', promptSource: 'custom' } }, promptContents: { a: '' } }
      },
      { path: '/api/chat/context/get', body: { source, previewAppendSystemPrompt: '' } }
    ]
  )
  for (const call of calls) {
    assert.equal(call.init.method, 'POST')
    assert.equal(
      new Headers(call.init.headers).get('X-Pi-Desk-Client-Id'),
      '444590a0-c0bd-46e1-a747-2810977bcd38'
    )
  }
})

test('能力目录读取失败不阻断全局正文读取、草稿预览及独立保存', async (t) => {
  const calls: string[] = []
  let saved = 'saved global\n'
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const path = String(input)
      calls.push(path)
      const body = JSON.parse(String(init.body))
      if (path === '/api/capability-modes/get')
        return Response.json(
          { code: 500, msg: 'catalog fixture failed', data: null },
          { status: 500 }
        )
      if (path === '/api/system-prompt/replace') saved = body.content
      const data =
        path === '/api/system-prompt/get'
          ? { content: saved }
          : path === '/api/chat/context/get'
            ? {
                baseSystemPrompt: 'base',
                systemPrompt: `base\n\n${body.previewAppendSystemPrompt}`,
                tools: []
              }
            : {}
      return Response.json({ code: 0, msg: '', data })
    }
  )
  const biz = createL2CapabilityModesBiz('444590a0-c0bd-46e1-a747-2810977bcd38')
  assert.equal(await biz.getPrompt(), 'saved global\n')
  assert.deepEqual(calls, ['/api/system-prompt/get'])
  await assert.rejects(biz.get(), /catalog fixture failed/)
  const source = { workId: 'work', sessionId: 'session', branchId: 'branch' }
  assert.equal(
    (await biz.preview(source, 'unsaved global draft')).systemPrompt,
    'base\n\nunsaved global draft'
  )
  await biz.replaceGlobalPrompt('new global\n')
  assert.equal(saved, 'new global\n')
  assert.deepEqual(calls, [
    '/api/system-prompt/get',
    '/api/capability-modes/get',
    '/api/chat/context/get',
    '/api/system-prompt/replace'
  ])
})

test('保存失败不收敛草稿，非法正文Key在请求前拒绝', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    return Response.json({ code: 500, msg: 'fixture write failed', data: null }, { status: 500 })
  })
  const state = fixture()
  const before = structuredClone(state)
  const biz = createL2CapabilityModesBiz('444590a0-c0bd-46e1-a747-2810977bcd38')
  await assert.rejects(biz.replace(l2CapabilityModeSubmission(state, 'a')), /fixture write failed/)
  assert.deepEqual(state, before)
  assert.deepEqual(l2DirtyCapabilityItems(state), [{ kind: 'global' }, { kind: 'mode', key: 'a' }])
  await assert.rejects(biz.replace({ modes: {}, promptContents: { unknown: 'body' } }))
  assert.equal(calls, 1)
})
