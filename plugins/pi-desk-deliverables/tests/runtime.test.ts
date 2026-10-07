import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  SESSION_PLUGIN_METHOD_EVENT,
  SESSION_PLUGIN_PUSH_EVENT,
  type SessionPluginMethodEvent,
  type SessionPluginPushEvent
} from '@jetcrab/pi-desk-sdk/session'
import extension from '../src/index.js'

const root = resolve('temp', 'pi', 'deliverables-runtime-test', String(process.pid), 'agent')

type Handler = (event: unknown, context: ExtensionContext) => unknown

interface CapturedTool {
  parameters: {
    properties?: {
      items?: {
        items?: {
          properties?: {
            path?: {
              description?: string
            }
          }
        }
      }
    }
  }
  promptGuidelines: readonly string[]
  execute(
    toolCallId: string,
    input: { items: Array<{ path: string; title: string }> },
    signal: AbortSignal,
    onUpdate: undefined,
    context: ExtensionContext
  ): Promise<{ details?: unknown }>
}

function entry(entryId: string, items: Array<{ path: string; title: string }>): SessionEntry {
  return {
    type: 'message',
    id: entryId,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: 'toolResult',
      toolCallId: `tool-${entryId}`,
      toolName: 'deliverable',
      content: [{ type: 'text', text: 'ok' }],
      details: { items },
      isError: false,
      timestamp: Date.now()
    }
  } as unknown as SessionEntry
}

function context(cwd: string, branch: SessionEntry[]): ExtensionContext {
  return {
    cwd,
    sessionManager: { getBranch: () => branch }
  } as unknown as ExtensionContext
}

test('Tool 原子校验多个文件，历史恢复后按批次倒序分页并 Push 新增项', async (contextTest) => {
  await mkdir(join(root, 'artifacts'), { recursive: true })
  await Promise.all([
    writeFile(join(root, 'artifacts', 'desktop.png'), 'desktop', 'utf8'),
    writeFile(join(root, 'artifacts', 'mobile.png'), 'mobile', 'utf8')
  ])
  contextTest.after(() => rm(root, { recursive: true, force: true }))

  const handlers = new Map<string, Handler[]>()
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const captured: { tool?: CapturedTool } = {}
  const pi = {
    registerTool(definition: CapturedTool) {
      captured.tool = definition
    },
    on(name: string, handler: Handler) {
      const values = handlers.get(name) ?? []
      values.push(handler)
      handlers.set(name, values)
    },
    events: {
      emit(channel: string, payload: unknown) {
        emitted.push({ channel, payload })
      }
    }
  } as unknown as ExtensionAPI

  extension(pi)
  const tool = captured.tool
  assert.ok(tool)
  assert.equal(
    tool.parameters.properties?.items?.items?.properties?.path?.description,
    '当前项目 cwd 下已存在、可在 Pi Desk 中预览的完成文件相对路径，使用 / 分隔'
  )
  assert.deepEqual(tool.promptGuidelines, [
    'Use deliverable only for important completed results or acceptance evidence that can be previewed in Pi Desk, such as images, code files that are themselves a requested deliverable, and HTML. Do not register ordinary source edits, intermediate files, or files that cannot be previewed.'
  ])
  const result = await tool.execute(
    'tool-1',
    {
      items: [
        { path: 'artifacts/desktop.png', title: '桌面端验收' },
        { path: 'artifacts/mobile.png', title: '移动端验收' }
      ]
    },
    new AbortController().signal,
    undefined,
    context(root, [])
  )
  assert.deepEqual(result.details, {
    items: [
      { path: 'artifacts/desktop.png', title: '桌面端验收' },
      { path: 'artifacts/mobile.png', title: '移动端验收' }
    ]
  })
  await assert.rejects(
    tool.execute(
      'tool-2',
      {
        items: [
          { path: 'artifacts/desktop.png', title: '有效文件' },
          { path: 'artifacts/missing.png', title: '缺失文件' }
        ]
      },
      new AbortController().signal,
      undefined,
      context(root, [])
    ),
    /文件不存在/
  )

  const first = entry('entry-1', [{ path: 'artifacts/desktop.png', title: '桌面端验收' }])
  const branch = [first]
  const extensionContext = context(root, branch)
  await handlers.get('session_start')?.[0]?.({}, extensionContext)

  const methodEvent = emitted
    .filter((item) => item.channel === SESSION_PLUGIN_METHOD_EVENT)
    .map((item) => item.payload as SessionPluginMethodEvent)
    .find((item) => item.type === 'register')
  assert.ok(methodEvent?.registration)
  assert.deepEqual(
    await methodEvent!.registration.execute(
      { limit: 20 },
      {
        source: { workId: 'work-1', sessionId: 'session-1', branchId: 'v1:main' },
        extensionContext
      }
    ),
    {
      deliveries: [
        {
          entryId: 'entry-1',
          items: [{ path: 'artifacts/desktop.png', title: '桌面端验收' }]
        }
      ],
      hasMore: false
    }
  )

  branch.push(entry('entry-2', [{ path: 'artifacts/mobile.png', title: '移动端验收' }]))
  await handlers.get('turn_end')?.[0]?.({}, extensionContext)
  const push = emitted.filter((item) => item.channel === SESSION_PLUGIN_PUSH_EVENT).at(-1)
    ?.payload as SessionPluginPushEvent | undefined
  assert.deepEqual(push, {
    pluginName: 'deliverables',
    event: 'added',
    data: {
      entryId: 'entry-2',
      items: [{ path: 'artifacts/mobile.png', title: '移动端验收' }]
    }
  })

  assert.deepEqual(
    await methodEvent!.registration.execute(
      { limit: 1 },
      {
        source: { workId: 'work-1', sessionId: 'session-1', branchId: 'v1:main' },
        extensionContext
      }
    ),
    {
      deliveries: [
        {
          entryId: 'entry-2',
          items: [{ path: 'artifacts/mobile.png', title: '移动端验收' }]
        }
      ],
      hasMore: true
    }
  )
})

test('树导航切换交付物与清空旧批次，不重注册或推送 added，shutdown 仍清理', async () => {
  const handlers = new Map<string, Handler[]>()
  const emitted: Array<{ channel: string; payload: unknown }> = []
  let toolRegistrationCount = 0
  const pi = {
    registerTool() {
      toolRegistrationCount += 1
    },
    on(name: string, handler: Handler) {
      const values = handlers.get(name) ?? []
      values.push(handler)
      handlers.set(name, values)
    },
    events: {
      emit(channel: string, payload: unknown) {
        emitted.push({ channel, payload })
      }
    }
  } as unknown as ExtensionAPI
  extension(pi)
  const branch = [entry('old-entry', [{ path: 'old.png', title: '旧分支' }])]
  const extensionContext = context(root, branch)
  await handlers.get('session_start')?.[0]?.({ type: 'session_start' }, extensionContext)
  const methodEvent = emitted
    .filter((item) => item.channel === SESSION_PLUGIN_METHOD_EVENT)
    .map((item) => item.payload as SessionPluginMethodEvent)
    .find((item) => item.type === 'register')
  assert.ok(methodEvent?.registration)
  const list = (input = {}) =>
    methodEvent.registration.execute(input, {
      source: { workId: 'work-1', sessionId: 'session-1', branchId: 'v1:main' },
      extensionContext
    })
  assert.deepEqual(await list(), {
    deliveries: [{ entryId: 'old-entry', items: [{ path: 'old.png', title: '旧分支' }] }],
    hasMore: false
  })

  const sessionTree = handlers.get('session_tree')?.[0]
  assert.equal(typeof sessionTree, 'function')
  assert.ok(sessionTree)
  branch.splice(
    0,
    branch.length,
    entry('target-entry', [{ path: 'target.png', title: '目标分支' }])
  )
  await sessionTree({ type: 'session_tree' }, extensionContext)
  assert.deepEqual(await list(), {
    deliveries: [{ entryId: 'target-entry', items: [{ path: 'target.png', title: '目标分支' }] }],
    hasMore: false
  })
  await assert.rejects(list({ beforeEntryId: 'old-entry' }), /不属于当前会话分支/)

  branch.splice(0)
  await sessionTree({ type: 'session_tree' }, extensionContext)
  assert.deepEqual(await list(), { deliveries: [], hasMore: false })
  assert.equal(toolRegistrationCount, 1)
  assert.equal(emitted.filter((item) => item.channel === SESSION_PLUGIN_METHOD_EVENT).length, 1)
  assert.equal(emitted.filter((item) => item.channel === SESSION_PLUGIN_PUSH_EVENT).length, 0)

  branch.push(entry('new-entry', [{ path: 'new.png', title: '新交付物' }]))
  await handlers.get('turn_end')?.[0]?.({ type: 'turn_end' }, extensionContext)
  const pushes = emitted.filter((item) => item.channel === SESSION_PLUGIN_PUSH_EVENT)
  assert.deepEqual(
    pushes.map((item) => item.payload),
    [
      {
        pluginName: 'deliverables',
        event: 'added',
        data: { entryId: 'new-entry', items: [{ path: 'new.png', title: '新交付物' }] }
      }
    ]
  )
  await handlers.get('session_shutdown')?.[0]?.({ type: 'session_shutdown' }, extensionContext)
  assert.deepEqual(await list(), { deliveries: [], hasMore: false })
})
