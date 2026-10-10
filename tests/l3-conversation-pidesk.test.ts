import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readL3ConversationPiDeskCommand,
  readL3ConversationPiDeskOutput
} from '../src/common/l3_modules/conversation/l3-conversation-pidesk'
import { L3_CONVERSATION_LOCALE_MESSAGES } from '../src/common/l3_modules/conversation/l3-conversation-locale-messages'
import { buildL3ConversationTurns } from '../src/client/l3_modules/conversation/l3-conversation-display'
import type { L3ConversationDurableMessageSnapshot } from '../src/common/l3_modules/conversation/l3-conversation-contract'
import { projectL4PiMessageDeclarationCore } from '../src/server/l4_foundation/pi/l4-pi-message-declaration-core'
import type { L4PiChatMessage } from '../src/server/l4_foundation/pi/l4-pi-chat-projection'

const source = { workId: 'work-pidesk', sessionId: 'session-pidesk', branchId: 'v1:main' }
const plugin = {
  name: '@example/plugin',
  source: 'npm:@example/plugin',
  kind: 'package',
  version: null,
  status: 'ready'
}

function message(input: Record<string, string[]>, output: string): L4PiChatMessage {
  return {
    type: 'tool',
    name: 'pidesk',
    reasoning: null,
    inputPreview: null,
    activity: null,
    status: 'completed',
    usage: null,
    output,
    declaration: {
      message: {
        kind: 'tool',
        toolName: 'pidesk',
        toolCallId: 'pidesk-call',
        arguments: input,
        result: { content: [{ type: 'text', text: output }] },
        partialResult: null,
        isError: false
      },
      raw: { privateRuntime: '不应进入展示协议' }
    }
  }
}

test('已知 pidesk 命令和完整参数组合可以翻译，未知组合保留原始调用', () => {
  const cases = [
    { args: [], label: 'pideskHelp', title: '查看命令帮助' },
    { args: ['--help'], label: 'pideskHelp', title: '查看命令帮助' },
    { args: ['plugins', 'list', '--help'], label: 'pideskHelp', title: '查看命令帮助' },
    { args: ['--version'], label: 'pideskVersion', title: '查看 Pi Desk 版本' },
    { args: ['info'], label: 'pideskInfo', title: '查看运行环境' },
    { args: ['session', 'reload'], label: 'pideskReload', title: '重载当前会话配置' },
    { args: ['plugins', 'list'], label: 'pideskListPlugins', title: '查看插件列表' },
    {
      args: ['plugins', 'list', '--scope', 'global'],
      label: 'pideskListPlugins',
      title: '查看插件列表'
    },
    {
      args: ['plugins', 'show', '@example/plugin', '--scope', 'global'],
      label: 'pideskShowPlugin',
      title: '查看插件'
    },
    {
      args: ['plugins', 'install', '--scope', 'global', '@example/plugin', '--version', '1.2.3'],
      label: 'pideskInstallPlugin',
      title: '安装插件'
    },
    {
      args: ['plugins', 'remove', '@example/plugin', '--scope', 'global'],
      label: 'pideskRemovePlugin',
      title: '卸载插件'
    }
  ] as const
  for (const item of cases) {
    const command = readL3ConversationPiDeskCommand({ args: [...item.args] })
    assert.equal(command.label, item.label)
    assert.equal(L3_CONVERSATION_LOCALE_MESSAGES['zh-CN'][command.label!], item.title)
  }
  for (const args of [
    ['info', '--new-option'],
    ['session reload'],
    ['plugins list'],
    ['--help', 'unknown-option'],
    ['plugins', 'inspect', '@example/plugin'],
    ['plugins', 'list', '--scope', 'project'],
    ['plugins', 'list', '--scope', 'global', '--scope', 'global'],
    ['plugins', 'list', '--filter', 'ready'],
    ['plugins', 'show', '@example/plugin'],
    ['plugins', 'install', '@example/plugin', '--scope', 'global', '--version', 'latest'],
    ['plugins', 'remove', '../plugin', '--scope', 'global'],
    ['plugins', 'unknown', '--help']
  ]) {
    const command = readL3ConversationPiDeskCommand({ args })
    assert.equal(command.label, null)
    assert.ok(command.command.startsWith('pidesk '))
    assert.equal(command.command.includes(args[0]!), true)
  }
})

test('命令详情保留空格、引号、空参数、换行及全部长参数，缺失参数不反推命令', () => {
  const args = ['unknown', 'two words', 'a"b', '', 'line\nbreak', 'x'.repeat(2048)]
  const command = readL3ConversationPiDeskCommand({ args })
  assert.equal(
    command.command,
    `pidesk unknown "two words" "a\\"b" "" "line\\nbreak" ${'x'.repeat(2048)}`
  )
  assert.deepEqual(readL3ConversationPiDeskCommand({}), {
    command: 'pidesk',
    label: null,
    name: null,
    version: null
  })
  const invalid = readL3ConversationPiDeskCommand({ args: ['info'], newOption: true })
  assert.equal(invalid.label, null)
  assert.equal(invalid.command, 'pidesk {"args":["info"],"newOption":true}')
  assert.equal(readL3ConversationPiDeskCommand({ args: 'info' }).label, null)
})

function projectedOutput(output: string): unknown {
  return projectL4PiMessageDeclarationCore({
    source,
    stage: 'durable',
    message: message({ args: ['info'] }, output)
  }).detail?.output
}

test('只解包当前返回结构，未来字段、普通文本和截断 JSON 无损保留', () => {
  assert.equal(projectedOutput('{"mode":"sync","message":"line 1\\nline 2"}'), 'line 1\nline 2')
  assert.equal(projectedOutput('{"mode":"async","message":"已接纳"}'), '已接纳')
  for (const text of [
    '',
    '普通返回\n保留换行',
    '{"mode":"sync","message":42}',
    '{"mode":"future","message":"value"}',
    '{"mode":"sync","message":"value","newField":1}',
    '{"plugins":[\n…结果过长，已截断。'
  ]) {
    assert.equal(projectedOutput(text), text)
  }
})

test('已知结果兼容旧空字段，保留未知版本、零插件及异常；未知字段回退原文', () => {
  const input = JSON.stringify({ plugins: [plugin], restartRequired: false })
  const parsed = readL3ConversationPiDeskOutput('pideskListPlugins', input)
  assert.equal(parsed?.kind, 'plugins')
  if (parsed?.kind === 'plugins') assert.equal(parsed.data.plugins[0]?.version, null)
  assert.equal(
    readL3ConversationPiDeskOutput('pideskListPlugins', '{"plugins":[],"restartRequired":false}')
      ?.kind,
    'plugins'
  )
  const legacy = { ...plugin, scope: 'global', error: null, operation: null }
  assert.equal(
    readL3ConversationPiDeskOutput(
      'pideskListPlugins',
      JSON.stringify({ plugins: [legacy], restartRequired: true, loadError: '需要重启' })
    )?.kind,
    'plugins'
  )
  for (const data of [
    { plugins: [plugin], restartRequired: false, newField: 1 },
    { plugins: [{ ...plugin, newField: 1 }], restartRequired: false },
    { plugins: [{ ...plugin, status: 'new-status' }], restartRequired: false }
  ]) {
    assert.equal(readL3ConversationPiDeskOutput('pideskListPlugins', JSON.stringify(data)), null)
  }
  assert.equal(readL3ConversationPiDeskOutput(null, input), null)
  assert.equal(readL3ConversationPiDeskOutput('pideskListPlugins', '插件不存在'), null)
  assert.equal(readL3ConversationPiDeskOutput('pideskListPlugins', '{"plugins":['), null)
  const environment = {
    version: '1.0.0',
    environment: 'development',
    mode: 'normal',
    cwd: 'C:/project',
    agentDir: 'C:/agent',
    docsDirectory: 'C:/host/docs/pi-desk'
  }
  assert.equal(
    readL3ConversationPiDeskOutput('pideskInfo', JSON.stringify(environment))?.kind,
    'info'
  )
  assert.equal(
    readL3ConversationPiDeskOutput(
      'pideskInfo',
      JSON.stringify({ ...environment, newField: true })
    ),
    null
  )
  assert.equal(
    readL3ConversationPiDeskOutput(
      'pideskInfo',
      JSON.stringify({
        ...environment,
        docsDirectory: undefined,
        skillDirectory: 'C:/legacy-skills'
      })
    ),
    null,
    '旧信息保留原文，不伪造当前文档目录'
  )
})

test('客户端按专属 viewKey 应用参数及按需返回正文，不按工具名称猜测视图', () => {
  const input = { args: ['plugins', 'list', '--scope', 'global'] }
  const snapshot: L3ConversationDurableMessageSnapshot = {
    location: { index: 0, entryId: 'pidesk01' },
    fixed: {
      timestampMs: 1,
      type: 'tool',
      viewKey: 'pi-desk/pidesk',
      status: 'completed',
      hasDetail: true,
      usage: null
    },
    summary: { input }
  }
  const unopened = buildL3ConversationTurns({ messages: [snapshot], temporaryMessages: [] })[0]!
    .processItems[0]!.message
  assert.equal(unopened.summary.type, 'tool')
  if (unopened.summary.type === 'tool' && unopened.summary.kind === 'pidesk') {
    assert.deepEqual(unopened.summary.input, input)
  } else {
    assert.fail('应按 pi-desk/pidesk 生成专属展示')
  }
  assert.equal(unopened.detail, undefined)
  const opened = buildL3ConversationTurns({
    messages: [{ ...snapshot, detail: { output: '返回正文' } }],
    temporaryMessages: []
  })[0]!.processItems[0]!.message
  assert.deepEqual(opened.detail, { type: 'tool', kind: 'pidesk', output: '返回正文' })
  const overridden = buildL3ConversationTurns({
    messages: [{ ...snapshot, fixed: { ...snapshot.fixed, viewKey: 'custom-pidesk/command' } }],
    temporaryMessages: []
  })[0]!.processItems[0]!.message
  assert.equal(overridden.summary.type === 'tool' && overridden.summary.kind === 'generic', true)
})

test('专属投影只保存参数和正文，旧消息与第三方 Declaration 仍可正常展示', () => {
  const input = { args: ['plugins', 'list', '--scope', 'global'] }
  const output = JSON.stringify({ mode: 'sync', message: '{"plugins":[],"restartRequired":false}' })
  const projected = projectL4PiMessageDeclarationCore({
    source,
    stage: 'durable',
    message: message(input, output)
  })
  assert.deepEqual(projected, {
    viewKey: 'pi-desk/pidesk',
    summary: { input },
    detail: { output: '{"plugins":[],"restartRequired":false}' }
  })
  const oldMessage = message(input, '旧版返回正文')
  delete oldMessage.declaration
  assert.deepEqual(
    projectL4PiMessageDeclarationCore({ source, stage: 'durable', message: oldMessage }).summary,
    { input: {} }
  )
  assert.deepEqual(
    projectL4PiMessageDeclarationCore({ source, stage: 'durable', message: oldMessage }).detail,
    { output: '旧版返回正文' }
  )
  const custom = projectL4PiMessageDeclarationCore({
    source,
    stage: 'durable',
    message: message(input, output),
    declarations: [
      {
        pluginName: 'custom-pidesk',
        declarationName: 'command',
        declaration: {
          priority: 100,
          match: (value) => value.message.kind === 'tool' && value.message.toolName === 'pidesk',
          project: () => ({
            viewKey: 'custom-pidesk/command',
            summary: { title: '自定义操作' },
            detail: null
          })
        }
      }
    ]
  })
  assert.equal(custom.viewKey, 'custom-pidesk/command')
})
