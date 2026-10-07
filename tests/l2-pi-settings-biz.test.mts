import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createL2PiSettingsBiz,
  parseL2McpImport
} from '../src/client/l2_biz/pi-settings/l2-pi-settings-biz'

import {
  buildL2McpDraft,
  createL2McpDraft
} from '../src/client/l2_biz/pi-settings/l2-pi-settings-model'

test('MCP 常用字段编辑保留原生字符串、其他传输字段和未知配置', () => {
  const original = {
    type: 'stdio',
    command: 'fixture',
    args: ['--path', '', 'folder with spaces'],
    enabled: true,
    env: { TOKEN: '${DOCS_TOKEN}', COMMAND: '!echo fixture' },
    headers: { Authorization: 'Bearer fixture' },
    cwd: './workspace',
    extra: { retained: ['one', 'two'] }
  }
  const draft = createL2McpDraft('local', original)
  assert.deepEqual(draft.env, [
    { key: 'TOKEN', value: '${DOCS_TOKEN}' },
    { key: 'COMMAND', value: '!echo fixture' }
  ])
  assert.deepEqual(buildL2McpDraft(draft, original), { local: original })
  draft.env = [{ key: 'TOKEN', value: ' new value ' }]
  const edited = buildL2McpDraft(draft, original).local
  assert.deepEqual(edited.env, { TOKEN: ' new value ' })
  assert.deepEqual(edited.headers, original.headers)
  assert.deepEqual(edited.extra, original.extra)
  draft.env = []
  assert.deepEqual(buildL2McpDraft(draft, original).local.env, {})
  assert.equal(original.env.TOKEN, '${DOCS_TOKEN}')
})

test('MCP 键值表单拒绝缺名和重复请求头，不悄悄覆盖用户输入', () => {
  const draft = createL2McpDraft('docs', { url: 'https://example.invalid/mcp' })
  draft.headers = [{ key: '', value: 'fixture' }]
  assert.throws(() => buildL2McpDraft(draft), { field: 'headers' })
  draft.headers = [
    { key: 'Authorization', value: 'one' },
    { key: 'authorization', value: 'two' }
  ]
  assert.throws(() => buildL2McpDraft(draft), { field: 'headers' })
  draft.headers = [
    { key: ' X-Token ', value: '' },
    { key: '', value: '' }
  ]
  assert.deepEqual(buildL2McpDraft(draft).docs.headers, { 'X-Token': '' })
  draft.advanced = '{"headers":{"X-Token":"conflict"}}'
  assert.throws(() => buildL2McpDraft(draft), { field: 'advanced' })
})

test('MCP JSON 导入保留服务字段，拒绝丢弃根级设置或空集合', () => {
  const servers = {
    docs: {
      url: 'https://example.invalid/mcp',
      headers: { Authorization: 'Bearer fixture' },
      extra: { retained: true }
    },
    local: { command: 'fixture', args: ['--one'] }
  }
  assert.deepEqual(parseL2McpImport(JSON.stringify({ mcpServers: servers })), servers)
  assert.throws(() => parseL2McpImport('{broken'))
  assert.throws(() =>
    parseL2McpImport(JSON.stringify({ mcpServers: servers, autoEnableCodemode: false }))
  )
  assert.throws(() => parseL2McpImport(JSON.stringify({ mcpServers: {} })))
})

test('设置业务通过统一 POST 和页面 clientId 请求，不自动重载会话', async (t) => {
  const calls: Array<{ path: string; init: RequestInit }> = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const path = String(input)
      calls.push({ path, init })
      const data = path.endsWith('/mcp-settings/get')
        ? { local: {}, inherited: {}, projectTrusted: null, diagnostics: [] }
        : path.endsWith('/mcp-check/get')
          ? { output: 'fixture connected' }
          : {}
      return Response.json({ code: 0, msg: '', data })
    }
  )
  const clientId = 'c3c2c7e2-76ba-4f58-a432-78d265362471'
  const biz = createL2PiSettingsBiz(clientId)
  await biz.getMcp(null)
  await biz.replaceMcp({ cwd: null, servers: { docs: { url: 'https://example.invalid/mcp' } } })
  await biz.deleteMcp(null, 'docs')
  await biz.checkMcp(null, 'docs')
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/mcp-settings/get',
      '/api/mcp-settings/replace',
      '/api/mcp-settings/del',
      '/api/mcp-check/get'
    ]
  )
  for (const call of calls) {
    assert.equal(call.init.method, 'POST')
    assert.equal(new Headers(call.init.headers).get('X-Pi-Desk-Client-Id'), clientId)
  }
})
