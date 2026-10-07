import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import backgroundRunExtension from '../src/index.js'
import {
  pruneTaskArtifacts,
  shellInvocation,
  type BackgroundTaskSnapshot
} from '../src/background-runtime.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

type ToolResult = {
  content: Array<{ type: string; text: string }>
  details: Record<string, unknown>
}

type CapturedTool = {
  name: string
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext
  ): Promise<ToolResult>
}

function taskFromResult(result: ToolResult): BackgroundTaskSnapshot {
  const task = result.details.task
  assert.equal(typeof task, 'object')
  return task as BackgroundTaskSnapshot
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error(`等待条件超时：${timeoutMs}ms`)
}

test('Windows Shell 使用 Bash 并优先调用包管理器 cmd shim', () => {
  const invocation = shellInvocation('pnpm dev', 'win32', { NODE_ENV: 'test' })
  assert.equal(invocation.shell, 'bash.exe')
  assert.equal(invocation.args[0], '-c')
  assert.match(invocation.args[1]!, /pnpm\.cmd/)
  assert.match(invocation.args[1]!, />\/dev\/null/)
})

test('日志目录超过上限时删除最早且未受保护的任务', async (context) => {
  const root = join(projectRoot, 'temp', 'pi', 'pi-desk-bg-run-prune-test', String(process.pid))
  context.after(() => rm(root, { recursive: true, force: true }))

  for (const [index, taskId] of ['task-1', 'task-2', 'task-3'].entries()) {
    const taskDir = join(root, 'session', taskId)
    const outputPath = join(taskDir, 'output.log')
    await mkdir(taskDir, { recursive: true })
    await writeFile(outputPath, taskId, 'utf8')
    const timestamp = new Date(1000 + index * 1000)
    await utimes(outputPath, timestamp, timestamp)
  }

  await pruneTaskArtifacts(root, new Set(), 2)

  assert.equal(existsSync(join(root, 'session', 'task-1')), false)
  assert.equal(existsSync(join(root, 'session', 'task-2', 'output.log')), true)
  assert.equal(existsSync(join(root, 'session', 'task-3', 'output.log')), true)
})

test('bg_run、bg_status、bg_kill 与 Session Task 生命周期形成闭环', async (context) => {
  const root = join(projectRoot, 'temp', 'pi', 'pi-desk-bg-run-runtime-test', String(process.pid))
  const projectDir = join(root, 'project')
  await mkdir(projectDir, { recursive: true })

  const handlers = new Map<
    string,
    Array<(event: unknown, extensionContext: ExtensionContext) => unknown>
  >()
  const tools = new Map<string, CapturedTool>()
  const taskEvents: Array<{ channel: string; payload: unknown }> = []
  const messages: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = []
  const pi = {
    on(event: string, handler: (event: unknown, extensionContext: ExtensionContext) => unknown) {
      const values = handlers.get(event) ?? []
      values.push(handler)
      handlers.set(event, values)
    },
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool)
    },
    sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
      messages.push({ message, options })
    },
    events: {
      emit(channel: string, payload: unknown) {
        taskEvents.push({ channel, payload })
      }
    }
  } as unknown as ExtensionAPI
  const extensionContext = {
    cwd: projectDir,
    sessionManager: {
      getSessionId: () => 'parent-session'
    }
  } as unknown as ExtensionContext

  backgroundRunExtension(pi)
  for (const handler of handlers.get('session_start') ?? []) {
    await handler({}, extensionContext)
  }
  context.after(async () => {
    for (const handler of handlers.get('session_shutdown') ?? []) {
      await handler({}, extensionContext)
    }
    await rm(root, { recursive: true, force: true })
  })

  assert.deepEqual([...tools.keys()], ['bg_run', 'bg_status', 'bg_kill'])

  const completedStart = await tools.get('bg_run')!.execute(
    'run-completed',
    {
      name: '输出测试',
      command: 'node -e "console.log(\'bg-ok\')"'
    },
    undefined,
    undefined,
    extensionContext
  )
  const completedTask = taskFromResult(completedStart)

  await waitUntil(async () => {
    const status = await tools
      .get('bg_status')!
      .execute(
        'status-completed',
        { taskId: completedTask.taskId },
        undefined,
        undefined,
        extensionContext
      )
    const tasks = status.details.tasks as BackgroundTaskSnapshot[]
    return tasks[0]?.status === 'completed'
  })
  await waitUntil(() =>
    messages.some(
      ({ message }) =>
        message.customType === 'pi-desk-bg-run:completion:v1' &&
        JSON.stringify(message.details).includes(completedTask.taskId)
    )
  )
  assert.equal(
    messages.find(({ message }) => JSON.stringify(message.details).includes(completedTask.taskId))
      ?.options.deliverAs,
    'steer'
  )

  const completedLog = await readFile(join(projectDir, completedTask.outputPath), 'utf8')
  assert.match(completedLog, /\[Command\]/)
  assert.match(completedLog, /\[Output\]/)
  assert.match(completedLog, /bg-ok/)
  assert.equal(
    taskEvents.some(
      (event) =>
        event.channel === 'pi-desk:task-report:v1' &&
        JSON.stringify(event.payload).includes(completedTask.taskId) &&
        JSON.stringify(event.payload).includes('completed')
    ),
    true
  )

  const timeoutStart = await tools.get('bg_run')!.execute(
    'run-timeout',
    {
      name: '超时测试',
      command: 'node -e "setInterval(() => {}, 1000)"',
      timeoutSeconds: 1
    },
    undefined,
    undefined,
    extensionContext
  )
  const timeoutTask = taskFromResult(timeoutStart)
  let timeoutSnapshot: BackgroundTaskSnapshot | undefined
  await waitUntil(async () => {
    const status = await tools
      .get('bg_status')!
      .execute(
        'status-timeout',
        { taskId: timeoutTask.taskId },
        undefined,
        undefined,
        extensionContext
      )
    timeoutSnapshot = (status.details.tasks as BackgroundTaskSnapshot[])[0]
    return timeoutSnapshot?.status === 'failed'
  })
  assert.match(timeoutSnapshot?.error ?? '', /1s/)
  await waitUntil(() =>
    messages.some(
      ({ message }) =>
        message.customType === 'pi-desk-bg-run:completion:v1' &&
        JSON.stringify(message.details).includes(timeoutTask.taskId)
    )
  )
  assert.equal(
    messages.find(({ message }) => JSON.stringify(message.details).includes(timeoutTask.taskId))
      ?.options.deliverAs,
    'steer'
  )

  const stoppedStart = await tools.get('bg_run')!.execute(
    'run-stopped',
    {
      name: '停止测试',
      command: 'node -e "setInterval(() => {}, 1000)"'
    },
    undefined,
    undefined,
    extensionContext
  )
  const stoppedTask = taskFromResult(stoppedStart)
  const [stoppedResult, duplicateStopResult] = await Promise.all([
    tools
      .get('bg_kill')!
      .execute(
        'kill-stopped',
        { taskId: stoppedTask.taskId.slice(0, 6) },
        undefined,
        undefined,
        extensionContext
      ),
    tools
      .get('bg_kill')!
      .execute(
        'kill-stopped-duplicate',
        { taskId: stoppedTask.taskId },
        undefined,
        undefined,
        extensionContext
      )
  ])
  assert.equal(taskFromResult(stoppedResult).status, 'stopped')
  assert.equal(taskFromResult(duplicateStopResult).status, 'stopped')

  const interruptedStart = await tools.get('bg_run')!.execute(
    'run-interrupted',
    {
      name: '关闭测试',
      command: 'node -e "setInterval(() => {}, 1000)"'
    },
    undefined,
    undefined,
    extensionContext
  )
  const interruptedTask = taskFromResult(interruptedStart)
  for (const handler of handlers.get('session_shutdown') ?? []) {
    await handler({}, extensionContext)
  }
  assert.equal(
    taskEvents.some(
      (event) =>
        event.channel === 'pi-desk:task-report:v1' &&
        JSON.stringify(event.payload).includes(interruptedTask.taskId) &&
        JSON.stringify(event.payload).includes('interrupted')
    ),
    true
  )
  assert.equal(
    messages.some(({ message }) => JSON.stringify(message.details).includes(stoppedTask.taskId)),
    false
  )
  assert.equal(
    messages.some(({ message }) =>
      JSON.stringify(message.details).includes(interruptedTask.taskId)
    ),
    false
  )
})
