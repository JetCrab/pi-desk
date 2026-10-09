import assert from 'node:assert/strict'
import test from 'node:test'
import {
  L2PluginManagementBatchRequestSchema,
  L2PluginManagementBatchResponseSchema,
  L2PluginManagementItemSchema,
  L2PluginManagementListRequestSchema
} from '../src/common/l2_biz/plugin/l2-plugin-management-contract'

test('批量安装不要求版本或标签，并允许各包选择自己的渠道', () => {
  assert.deepEqual(
    L2PluginManagementBatchRequestSchema.parse({
      action: 'add',
      items: [{ source: 'npm:@fixture/plain' }, { source: 'npm:@fixture/develop', tag: 'dev' }]
    }),
    {
      action: 'add',
      items: [{ source: 'npm:@fixture/plain' }, { source: 'npm:@fixture/develop', tag: 'dev' }]
    }
  )
  assert.ok(
    L2PluginManagementBatchRequestSchema.safeParse({
      action: 'update',
      sources: ['npm:@fixture/plain', 'npm:@fixture/develop']
    }).success
  )
  assert.ok(
    L2PluginManagementBatchRequestSchema.safeParse({
      action: 'del',
      sources: ['npm:@fixture/plain', 'npm:@fixture/develop']
    }).success
  )
})

test('渠道检查和批量改渠道不会要求安装版本，操作范围必须非空', () => {
  assert.deepEqual(L2PluginManagementListRequestSchema.parse({ checkUpdates: true, tag: 'dev' }), {
    checkUpdates: true,
    tag: 'dev'
  })
  assert.ok(
    L2PluginManagementBatchRequestSchema.safeParse({
      action: 'tag',
      sources: ['npm:@fixture/plugin'],
      tag: 'dev'
    }).success
  )
  for (const input of [
    { action: 'update', sources: [] },
    { action: 'del', sources: [] },
    { action: 'add', items: [] },
    { action: 'tag', sources: ['npm:test'], tag: '1.0.0' },
    { action: 'del', sources: ['npm:test'], tag: 'dev' }
  ])
    assert.equal(L2PluginManagementBatchRequestSchema.safeParse(input).success, false)
})

test('批量接纳结果逐项保留错误，不把部分成功伪装成全部完成', () => {
  const value = {
    snapshot: { plugins: [], restartRequired: false, loadError: null },
    results: [
      { source: 'npm:@fixture/ok', error: null },
      { source: 'npm:@fixture/failed', error: '该插件不存在' }
    ]
  }
  assert.deepEqual(L2PluginManagementBatchResponseSchema.parse(value), value)
})

const emptyCapabilities = {
  error: null,
  extensions: [],
  tools: [],
  skills: [],
  prompts: [],
  themes: [],
  providers: [],
  piDesk: { methods: [], browserEntries: [], messageDeclarations: [] }
}

test('旧插件列表Item解析默认保持Package与无operation', () => {
  const item = L2PluginManagementItemSchema.parse({
    source: 'npm:@fixture/legacy-package',
    pluginName: null,
    version: null,
    updateAvailable: null,
    status: 'ready',
    error: null,
    capabilities: emptyCapabilities
  })

  assert.equal(item.kind, 'package')
  assert.equal(item.operation, null)
  assert.equal(item.description, null)
})

test('本地extension、disabled和服务端operation状态可按协议往返解析', () => {
  const item = L2PluginManagementItemSchema.parse({
    source: 'C:/isolated/agent/extensions/local-plugin.ts',
    kind: 'extension',
    description: '读取项目构建日志',
    operation: { action: 'update', phase: 'waiting', message: '等待维护静默窗口' },
    pluginName: null,
    version: null,
    updateAvailable: null,
    status: 'disabled',
    error: null,
    capabilities: emptyCapabilities
  })

  assert.equal(item.kind, 'extension')
  assert.equal(item.status, 'disabled')
  assert.equal(item.description, '读取项目构建日志')
  assert.deepEqual(item.operation, {
    action: 'update',
    phase: 'waiting',
    message: '等待维护静默窗口'
  })
})
