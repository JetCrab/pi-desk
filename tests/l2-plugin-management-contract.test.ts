import assert from 'node:assert/strict'
import test from 'node:test'
import { L2PluginManagementItemSchema } from '../src/common/l2_biz/plugin/l2-plugin-management-contract'

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
