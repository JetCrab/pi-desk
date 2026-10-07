import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PluginJsonObject,
  PluginJsonValue,
  PluginMessageDeclaration,
  PluginMessageDeclarationInput,
  PluginMessageProjectionResult
} from '@jetcrab/pi-desk-sdk/entry'
import { projectL4PiMessageDeclarationCore as projectL4PiMessageDeclaration } from '../src/server/l4_foundation/pi/l4-pi-message-declaration-core'
import type { L4PiChatMessage } from '../src/server/l4_foundation/pi/l4-pi-chat-projection'

const source = { workId: 'work-1', sessionId: 'session-1', branchId: 'v1:main' }

function toolMessage(
  options: {
    name?: 'read' | 'edit' | 'write'
    arguments?: PluginJsonObject
    result?: PluginJsonValue
    isError?: boolean
  } = {}
): L4PiChatMessage {
  const name = options.name ?? 'read'
  const argumentsValue = options.arguments ?? { path: 'docs/api.md' }
  return {
    type: 'tool',
    name,
    reasoning: '读取协议',
    inputPreview: 'docs/api.md',
    activity: '1-200',
    status: options.isError ? 'error' : 'completed',
    usage: null,
    output: '工具输出',
    declaration: {
      message: {
        kind: 'tool',
        toolName: name,
        toolCallId: 'tool-1',
        arguments: argumentsValue,
        partialResult: null,
        result: options.result ?? { output: '工具输出' },
        isError: options.isError ?? false
      },
      raw: { secretRawField: '不得进入 Browser' }
    }
  }
}

function assistantMessage(text: string): L4PiChatMessage {
  return {
    type: 'assistant',
    text,
    thinking: '规范思考',
    status: 'completed',
    errorMessage: null,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0.001 },
    declaration: {
      message: { kind: 'assistant', text, thinking: '规范思考', stopReason: 'stop' },
      raw: { secretRawField: '不得进入Browser' }
    }
  }
}

function registration(
  pluginName: string,
  declarationName: string,
  declaration: PluginMessageDeclaration
) {
  return { pluginName, declarationName, declaration }
}

const imageDimensionNote =
  '[Image: original 1156x2560, displayed at 903x2000. Multiply coordinates by 1.28 to map to original image.]'
const userImage = { mimeType: 'image/png', width: 903, height: 2000 } as const

test('默认用户展示在实时和历史阶段隐藏附件缩放说明，保留正文和图片', () => {
  const stages: PluginMessageDeclarationInput['stage'][] = [
    'temporary',
    'update',
    'final',
    'durable'
  ]
  const cases = [
    {
      text: `看看怎么调整\n\n${imageDimensionNote}`,
      expected: '看看怎么调整',
      images: [userImage]
    },
    { text: `\n\n${imageDimensionNote}`, expected: '', images: [userImage] },
    {
      text: `保留正文的换行\n\n\n${imageDimensionNote}\n${imageDimensionNote}`,
      expected: '保留正文的换行\n',
      images: [userImage, userImage]
    }
  ]

  for (const stage of stages) {
    for (const item of cases) {
      const message: L4PiChatMessage = { type: 'user', text: item.text, images: item.images }
      const result = projectL4PiMessageDeclaration({ source, stage, message, declarations: [] })
      assert.equal(result.viewKey, 'pi-desk/user')
      assert.equal(result.summary.text, item.expected)
      assert.deepEqual(result.summary.images, item.images)
      assert.equal(message.text, item.text)
    }
  }
})

test('默认用户展示保留引用、普通图片提示和不匹配附件的尺寸说明', () => {
  const cases = [
    { text: `解释这段文字\n\n${imageDimensionNote}`, images: [] },
    { text: `解释这段文字\n\n${imageDimensionNote}`, images: [{ ...userImage, width: 900 }] },
    { text: `这段说明是什么意思：${imageDimensionNote}`, images: [userImage] },
    { text: `解释这段文字\n\n> ${imageDimensionNote}`, images: [userImage] },
    { text: `\`\`\`text\n${imageDimensionNote}\n\`\`\``, images: [userImage] },
    { text: `${imageDimensionNote}\n\n这是我引用的文字`, images: [userImage] },
    { text: '保留正文\n\n[Image: 手工图片说明]', images: [userImage] },
    { text: '普通正文\n\n', images: [userImage] },
    {
      text: `保留正文\n\n${imageDimensionNote}\n${imageDimensionNote}`,
      images: [userImage]
    }
  ]

  for (const item of cases) {
    const result = projectL4PiMessageDeclaration({
      source,
      stage: 'durable',
      message: { type: 'user', text: item.text, images: item.images },
      declarations: []
    })
    assert.equal(result.summary.text, item.text)
  }

  const assistant = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message: assistantMessage(imageDimensionNote),
    declarations: []
  })
  assert.equal(assistant.summary.text, imageDimensionNote)
})

test('隐藏缩放说明不修改原始 Pi 消息，插件仍可自行投影完整原文', () => {
  const text = `看看怎么调整\n\n${imageDimensionNote}`
  const raw = {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', mimeType: 'image/png', data: '原始图片数据' }
    ],
    timestamp: 1
  }
  const message: L4PiChatMessage = {
    type: 'user',
    text,
    images: [userImage],
    declaration: { message: { kind: 'user', text, images: [userImage] }, raw }
  }
  const original = JSON.stringify(message)
  const result = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message,
    declarations: [
      registration('custom-user', 'user', {
        priority: 100,
        match: (input) => input.message.kind === 'user',
        project(input) {
          assert.equal(input.message.kind, 'user')
          if (input.message.kind !== 'user') throw new Error('测试必须接收用户消息')
          assert.equal(input.message.text, text)
          assert.equal(input.raw, raw)
          assert.equal(input.defaultProjection.summary.text, '看看怎么调整')
          return {
            viewKey: 'custom-user/user',
            summary: { text: input.message.text },
            detail: null
          }
        }
      })
    ]
  })

  assert.equal(result.viewKey, 'custom-user/user')
  assert.equal(result.summary.text, text)
  assert.equal(JSON.stringify(message), original)
})

test('Host 压缩视图不接受插件 Declaration 覆盖', () => {
  let matched = false
  const result = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message: { type: 'compaction', summary: '## Goal\n\n继续当前工作。' },
    declarations: [
      registration('custom-catch-all', 'custom', {
        priority: 100,
        match: () => {
          matched = true
          return true
        },
        project: () => ({ viewKey: 'custom-catch-all/card', summary: {}, detail: null })
      })
    ]
  })

  assert.equal(matched, false)
  assert.deepEqual(result, {
    viewKey: 'pi-desk/compaction',
    summary: {},
    detail: { text: '## Goal\n\n继续当前工作。' }
  })
})

test('插件 Declaration 高优先级覆盖内置 Read，修复后历史可恢复默认投影', () => {
  const custom = registration('rich-read', 'read-card', {
    priority: 100,
    match: (input) => input.message.kind === 'tool' && input.message.toolName === 'read',
    project: (input) => ({
      viewKey: 'rich-read/card',
      summary: {
        title: 'Rich Read',
        path: input.message.kind === 'tool' ? input.message.arguments.path : null
      },
      detail: { output: '自定义详情' }
    })
  })
  assert.deepEqual(
    projectL4PiMessageDeclaration({
      source,
      stage: 'durable',
      message: toolMessage(),
      declarations: [custom]
    }),
    {
      viewKey: 'rich-read/card',
      summary: { title: 'Rich Read', path: 'docs/api.md' },
      detail: { output: '自定义详情' }
    }
  )

  const recovered = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message: toolMessage(),
    declarations: []
  })
  assert.equal(recovered.viewKey, 'pi-desk/read')
  assert.deepEqual(recovered.summary, {
    name: 'read',
    reasoning: '读取协议',
    inputPreview: 'docs/api.md',
    activity: '1-200',
    path: 'docs/api.md'
  })
  assert.deepEqual(recovered.detail, { content: '工具输出' })
})

test('内置文件工具按各自 viewKey 投影 Detail，图片 Read 不生成文本 Detail', () => {
  const readImage = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message: toolMessage({
      result: {
        content: [
          { type: 'text', text: 'Read image file [image/png]' },
          { type: 'image', data: 'base64', mimeType: 'image/png' }
        ]
      }
    }),
    declarations: []
  })
  assert.equal(readImage.viewKey, 'pi-desk/read')
  assert.equal(readImage.detail, null)

  const edit = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message: toolMessage({
      name: 'edit',
      result: {
        content: [{ type: 'text', text: 'Successfully replaced 1 block.' }],
        details: { diff: '-10 old\n+10 new' }
      }
    }),
    declarations: []
  })
  assert.equal(edit.viewKey, 'pi-desk/edit')
  assert.deepEqual(edit.detail, { kind: 'diff', content: '-10 old\n+10 new' })

  const write = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message: toolMessage({
      name: 'write',
      arguments: { path: 'src/new.ts', content: 'export const value = 1\n' },
      result: { content: [{ type: 'text', text: 'Successfully wrote file.' }] }
    }),
    declarations: []
  })
  assert.equal(write.viewKey, 'pi-desk/write')
  assert.equal(write.summary.path, 'src/new.ts')
  assert.deepEqual(write.detail, {
    kind: 'content',
    content: 'export const value = 1\n'
  })
})

test('默认 Projection 保留绝对预览路径并拒绝非规范相对路径', () => {
  const reuseDefault = registration('reuse-default', 'read', {
    priority: 100,
    match: () => true,
    project: (input) => input.defaultProjection
  })
  const absolute = 'C:\\Users\\test-user\\.pi\\agent\\sessions\\session.jsonl'
  const absoluteResult = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message: toolMessage({ arguments: { path: absolute } }),
    declarations: [reuseDefault]
  })
  const invalidResult = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message: toolMessage({ arguments: { path: '../outside.txt' } }),
    declarations: [reuseDefault]
  })

  assert.equal(absoluteResult.viewKey, 'pi-desk/read')
  assert.equal(absoluteResult.summary.path, absolute)
  assert.deepEqual(absoluteResult.detail, { content: '工具输出' })
  assert.equal(invalidResult.summary.path, null)
})

test('同最高 priority 多匹配生成 conflict，不尝试低优先级', () => {
  let lowProjected = false
  const result = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message: assistantMessage('规范正文'),
    declarations: [
      registration('first', 'read', {
        priority: 100,
        match: () => true,
        project: (input) => input.defaultProjection
      }),
      registration('second', 'read', {
        priority: 100,
        match: () => true,
        project: (input) => input.defaultProjection
      }),
      registration('low', 'read', {
        priority: 10,
        match: () => true,
        project: (input) => {
          lowProjected = true
          return input.defaultProjection
        }
      })
    ]
  })

  assert.equal(result.viewKey, 'pi-desk/message-declaration-error')
  assert.equal(result.summary.phase, 'conflict')
  assert.equal(result.summary.text, '规范正文')
  assert.equal(lowProjected, false)
  assert.equal(JSON.stringify(result).includes('secretRawField'), false)
})

test('match、project、validate 失败生成对应 Error Projection', () => {
  const cases: Array<{
    phase: 'match' | 'project' | 'validate'
    declaration: PluginMessageDeclaration
  }> = [
    {
      phase: 'match',
      declaration: {
        priority: 100,
        match() {
          throw new Error('match failed')
        },
        project: (input) => input.defaultProjection
      }
    },
    {
      phase: 'project',
      declaration: {
        priority: 100,
        match: () => true,
        project() {
          throw new Error('project failed')
        }
      }
    },
    {
      phase: 'validate',
      declaration: {
        priority: 100,
        match: () => true,
        project: () => ({
          viewKey: 'Invalid View Key',
          summary: {},
          detail: null
        })
      }
    }
  ]

  for (const item of cases) {
    const result = projectL4PiMessageDeclaration({
      source,
      stage: 'durable',
      message: toolMessage(),
      declarations: [registration('broken', item.phase, item.declaration)]
    })
    assert.equal(result.viewKey, 'pi-desk/message-declaration-error')
    assert.equal(result.summary.phase, item.phase)
  }
})

test('Declaration 不限制 Summary 和 Detail 字节数', () => {
  const summaryText = 'x'.repeat(70 * 1024)
  const detailOutput = 'x'.repeat(2 * 1024 * 1024)
  const result = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message: toolMessage(),
    declarations: [
      registration('large-message', 'project', {
        priority: 100,
        match: () => true,
        project: () => ({
          viewKey: 'fixture/large',
          summary: { text: summaryText },
          detail: { output: detailOutput }
        })
      })
    ]
  })

  assert.equal(result.viewKey, 'fixture/large')
  assert.equal(result.summary.text, summaryText)
  assert.equal(result.detail?.output, detailOutput)
})

test('Host 保留 viewKey 在 validate 阶段失败', () => {
  const projection: PluginMessageProjectionResult = {
    viewKey: 'pi-desk/message-declaration-error',
    summary: {},
    detail: null
  }
  const result = projectL4PiMessageDeclaration({
    source,
    stage: 'durable',
    message: toolMessage(),
    declarations: [
      registration('broken', 'validate', {
        priority: 100,
        match: () => true,
        project: () => projection
      })
    ]
  })

  assert.equal(result.viewKey, 'pi-desk/message-declaration-error')
  assert.equal(result.summary.phase, 'validate')
})
