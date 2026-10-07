import assert from 'node:assert/strict'
import test from 'node:test'
import {
  L2PluginManagementDetailSchema,
  L2PluginManagementListRequestSchema,
  L2PluginManagementSnapshotSchema,
  L2PluginManagementSourceRequestSchema
} from '../src/common/l2_biz/plugin/l2-plugin-management-contract'
import {
  L3_PLUGIN_HOST_BROWSER_RUNTIME_IMPORT_MAP,
  L3_PLUGIN_HOST_BROWSER_RUNTIME_VERSION,
  L3PluginBrowserEntryDescriptorSchema,
  L3PluginBrowserSocketContracts,
  L3PluginHostBrowserRuntimeVersionSchema
} from '../src/common/l3_modules/plugin-host/l3-plugin-browser-contract'
import {
  L3PiNativeBashExecuteRequestSchema,
  L3PiNativeCommandInfoSchema,
  L3PiNativeSocketContracts
} from '../src/common/l3_modules/plugin-host/l3-plugin-native-pi-contract'
import { L3PluginPushMessageSchema } from '../src/common/l3_modules/plugin-host/l3-plugin-push-contract'

const source = {
  workId: '11111111-1111-4111-8111-111111111111',
  sessionId: 'session-1',
  branchId: 'v1:main'
}

test('Browser Entry Descriptor 只暴露 pluginName 和 opaque Entry URL', () => {
  const descriptor = {
    pluginName: 'task-ssh',
    url: `/api/plugins/browser-resources/${'a'.repeat(32)}/entry.js`
  }
  assert.deepEqual(L3PluginBrowserEntryDescriptorSchema.parse(descriptor), descriptor)
  assert.equal(
    L3PluginBrowserEntryDescriptorSchema.safeParse({ ...descriptor, contributions: [] }).success,
    false
  )
  assert.equal(
    L3PluginBrowserEntryDescriptorSchema.safeParse({
      ...descriptor,
      url: `/api/plugins/browser-resources/${'a'.repeat(32)}/../entry.js`
    }).success,
    false
  )
})

test('Host Browser Runtime 使用固定版本和 allowlist 模块映射', () => {
  assert.equal(L3_PLUGIN_HOST_BROWSER_RUNTIME_VERSION, 'v1')
  assert.equal(L3PluginHostBrowserRuntimeVersionSchema.safeParse('v1').success, true)
  assert.equal(L3PluginHostBrowserRuntimeVersionSchema.safeParse('v2').success, false)
  assert.deepEqual(Object.keys(L3_PLUGIN_HOST_BROWSER_RUNTIME_IMPORT_MAP.imports), [
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'react-dom',
    'react-dom/client',
    '@jetcrab/pi-desk-sdk/react/base',
    '@jetcrab/pi-desk-sdk/react/markdown'
  ])
  assert.match(
    L3_PLUGIN_HOST_BROWSER_RUNTIME_IMPORT_MAP.imports.react,
    /^\/api\/plugins\/host-runtime\/v1\/base\.js$/
  )
})

test('Plugin Push Global 与 Session target 不能混用 Source', () => {
  assert.equal(
    L3PluginPushMessageSchema.safeParse({
      pluginName: 'task-ssh',
      target: { scope: 'global' },
      event: 'state',
      data: {}
    }).success,
    true
  )
  assert.equal(
    L3PluginPushMessageSchema.safeParse({
      pluginName: 'task-ssh',
      target: { scope: 'session', source },
      event: 'state',
      data: {}
    }).success,
    true
  )
  assert.equal(
    L3PluginPushMessageSchema.safeParse({
      pluginName: 'task-ssh',
      target: { scope: 'global', source },
      event: 'state',
      data: {}
    }).success,
    false
  )
})

test('插件管理快照暴露健康状态和严格能力清单', () => {
  assert.equal(
    L2PluginManagementSnapshotSchema.safeParse({
      plugins: [
        {
          source: 'npm:@scope/plugin',
          pluginName: 'fixture-plugin',
          version: '1.2.3',
          updateAvailable: true,
          status: 'failed',
          error: { phase: 'setup', message: 'setup failed' },
          capabilities: {
            error: null,
            extensions: [
              {
                path: 'dist/index.js',
                events: [{ name: 'before_agent_start', count: 1 }],
                commands: [],
                shortcuts: [],
                flags: [],
                messageRenderers: [],
                entryRenderers: []
              }
            ],
            tools: [
              {
                name: 'fixture_tool',
                label: 'Fixture Tool',
                state: 'active',
                description: '测试工具',
                promptSnippet: 'Use fixture_tool',
                promptGuidelineCount: 1,
                promptGuidelinePreview: 'Use fixture_tool only for fixtures.'
              }
            ],
            skills: [],
            prompts: [],
            themes: [],
            providers: [],
            piDesk: {
              methods: [{ pluginName: 'fixture-plugin', method: 'state-get' }],
              browserEntries: [{ pluginName: 'fixture-plugin' }],
              messageDeclarations: []
            }
          }
        }
      ],
      restartRequired: true,
      loadError: null
    }).success,
    true
  )
  assert.equal(
    L2PluginManagementSnapshotSchema.safeParse({
      plugins: [],
      restartRequired: false,
      loadError: null,
      generation: 1
    }).success,
    false
  )
  assert.equal(
    L2PluginManagementSourceRequestSchema.safeParse({ source: 'npm:@scope/plugin', force: true })
      .success,
    false
  )
  assert.equal(
    L2PluginManagementDetailSchema.safeParse({
      source: 'npm:@scope/plugin',
      tools: [
        {
          name: 'fixture_tool',
          label: 'Fixture Tool',
          state: 'active',
          description: '测试工具',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: '查询内容' } },
            required: ['query']
          },
          promptSnippet: 'Use fixture_tool',
          promptGuidelines: ['Use fixture_tool only for fixtures.']
        }
      ],
      skills: [
        {
          name: 'fixture-skill',
          description: 'Fixture Skill',
          path: 'skills/fixture/SKILL.md',
          modelVisible: true,
          content: '# Fixture Skill',
          truncated: false
        }
      ],
      prompts: [
        {
          name: 'fixture-review',
          description: 'Fixture Prompt',
          path: 'prompts/review.md',
          content: 'Review fixture.',
          truncated: false
        }
      ]
    }).success,
    true
  )
  assert.equal(
    L2PluginManagementDetailSchema.safeParse({
      source: 'npm:@scope/plugin',
      tools: [],
      skills: [],
      prompts: [],
      version: 1
    }).success,
    false
  )
  assert.equal(L2PluginManagementListRequestSchema.safeParse({ checkUpdates: true }).success, true)
  assert.equal(
    L2PluginManagementListRequestSchema.safeParse({ checkUpdates: true, refresh: true }).success,
    false
  )
})

test('Native Pi 只冻结 Command、Tool Metadata、Bash 路径', () => {
  assert.deepEqual(
    Object.values(L3PiNativeSocketContracts).map((contract) => contract.path),
    ['pi/commands/list', 'pi/commands/execute', 'pi/tools/list', 'pi/bash/execute', 'pi/bash/abort']
  )
  assert.equal(
    Object.values(L3PiNativeSocketContracts).some(
      (contract) => contract.path === 'pi/tools/execute'
    ),
    false
  )
  assert.equal(
    L3PiNativeBashExecuteRequestSchema.safeParse({
      source,
      command: 'printf ok',
      excludeFromContext: false,
      id: 'not-allowed'
    }).success,
    false
  )
  assert.equal(
    L3PiNativeCommandInfoSchema.safeParse({
      name: 'review',
      description: '审查代码',
      source: 'prompt'
    }).success,
    true
  )
  assert.equal(
    L3PiNativeCommandInfoSchema.safeParse({
      name: 'review',
      description: '审查代码'
    }).success,
    false
  )
  assert.equal(
    L3PiNativeCommandInfoSchema.safeParse({
      name: 'review',
      description: '审查代码',
      source: 'builtin'
    }).success,
    false
  )
  assert.equal(L3PluginBrowserSocketContracts.list.path, 'plugins/browser-entries/list')
})
