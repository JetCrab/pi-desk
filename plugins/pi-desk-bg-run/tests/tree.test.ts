import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { BackgroundTaskRuntime, type BackgroundTaskChild } from '../src/background-runtime.js'
import backgroundRunExtension from '../src/index.js'

class FakeChild extends EventEmitter {
  readonly pid = 2147483647
  kills = 0
  canKill = true

  kill(): boolean {
    this.kills += 1
    return this.canKill
  }

  close(): void {
    this.emit('close', null, 'SIGTERM')
  }
}

async function fixture() {
  const base = fileURLToPath(new URL('../../../temp/tests/bg-run-tree/', import.meta.url))
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'tree-tasks-'))
  const reports: unknown[] = []
  const messages: unknown[] = []
  const notices: string[] = []
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>()
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): () => void {
      assert.equal(handlers.has(name), false)
      handlers.set(name, handler)
      return () => undefined
    },
    registerTool(): void {},
    events: {
      emit(_channel: string, payload: unknown): void {
        reports.push(payload)
      }
    },
    sendMessage(message: unknown): void {
      messages.push(message)
    }
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => 'same-jsonl' },
    ui: {
      notify(message: string): void {
        notices.push(message)
      }
    }
  } as unknown as ExtensionContext
  return { root, pi, ctx, reports, messages, handlers, notices }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('后台树导航等待退出，取消后仍能启动原分支任务；已取消不发停止', async () => {
  const f = await fixture()
  const children: FakeChild[] = []
  const runtime = new BackgroundTaskRuntime(f.pi, () => {
    const child = new FakeChild()
    children.push(child)
    return child
  })
  try {
    runtime.startSession(f.ctx)
    const task = await runtime.startTask(f.ctx, { name: '活任务', command: 'fixture' })
    const cancelled = new AbortController()
    cancelled.abort()
    assert.deepEqual(await runtime.beforeTree(cancelled.signal), { cancel: true })
    assert.equal(children[0]!.kills, 0)
    const controller = new AbortController()
    let finished = false
    const stopping = runtime.beforeTree(controller.signal).then((result) => {
      finished = true
      return result
    })
    await tick()
    assert.equal(finished, false)
    assert.equal(runtime.listTasks(f.ctx, task.taskId)[0]?.status, 'running')
    controller.abort()
    children[0]!.close()
    assert.deepEqual(await stopping, { cancel: true })
    assert.equal(runtime.listTasks(f.ctx, task.taskId)[0]?.status, 'interrupted')
    assert.equal(f.messages.length, 0)
    const next = await runtime.startTask(f.ctx, { name: '继续当前分支', command: 'fixture' })
    children[1]!.close()
    await tick()
    assert.equal(runtime.listTasks(f.ctx, next.taskId)[0]?.status, 'completed')
  } finally {
    for (const child of children) child.close()
    await runtime.shutdown()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('后台停止失败保留运行任务及控制权，不伪造退出', async () => {
  const f = await fixture()
  const child = new FakeChild()
  const runtime = new BackgroundTaskRuntime(f.pi, () => child)
  try {
    runtime.startSession(f.ctx)
    const task = await runtime.startTask(f.ctx, { name: '拒绝停止', command: 'fixture' })
    child.canKill = false
    await assert.rejects(runtime.beforeTree(new AbortController().signal), /无法终止/)
    assert.equal(runtime.listTasks(f.ctx, task.taskId)[0]?.status, 'running')
    assert.equal(runtime.listTasks(f.ctx, task.taskId)[0]?.endedAt, null)
    assert.equal(f.messages.length, 0)
    child.canKill = true
    const stopping = runtime.stopTaskById(f.ctx, task.taskId)
    await tick()
    child.close()
    assert.equal((await stopping).status, 'interrupted')
    assert.equal(child.kills, 2)
  } finally {
    child.close()
    await runtime.shutdown()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('迟到启动不产生进程；同一 JSONL 重绑定后迟到完成不上报新任务视图', async () => {
  const f = await fixture()
  const children: FakeChild[] = []
  const runtime = new BackgroundTaskRuntime(f.pi, () => {
    const child = new FakeChild()
    children.push(child)
    return child
  })
  try {
    runtime.startSession(f.ctx)
    const creating = runtime.startTask(f.ctx, { name: '迟到启动', command: 'fixture' })
    const rejected = assert.rejects(creating, /后台任务未启动/)
    await runtime.beforeTree(new AbortController().signal)
    runtime.startSession(f.ctx)
    await rejected
    assert.equal(children.length, 0)
    assert.deepEqual(runtime.listTasks(f.ctx), [])
    const old = await runtime.startTask(f.ctx, { name: '旧分支', command: 'fixture' })
    const settled = (
      runtime as unknown as {
        tasks: Map<string, { settled: Promise<void> }>
      }
    ).tasks.get(old.taskId)!.settled
    children[0]!.close()
    // closeStream 尚未结束：模拟已经开始收尾的旧任务回调迟到。
    runtime.startSession(f.ctx)
    const count = f.reports.length
    await settled
    assert.equal(f.reports.length, count)
    assert.equal(f.messages.length, 0)
    assert.deepEqual(runtime.listTasks(f.ctx), [])
  } finally {
    for (const child of children) child.close()
    await runtime.shutdown()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('官方树事件失败返回 cancel 并通知，不重复注册长期工具或方法', async () => {
  const f = await fixture()
  const original = BackgroundTaskRuntime.prototype.beforeTree
  try {
    backgroundRunExtension(f.pi)
    const names = [...f.handlers.keys()]
    await f.handlers.get('session_start')!({}, f.ctx)
    BackgroundTaskRuntime.prototype.beforeTree = async () => {
      throw new Error('停止失败')
    }
    const result = await f.handlers.get('session_before_tree')!(
      { signal: new AbortController().signal },
      f.ctx
    )
    assert.deepEqual(result, { cancel: true })
    assert.match(f.notices[0]!, /停止失败/)
    await f.handlers.get('session_tree')!({}, f.ctx)
    await f.handlers.get('session_tree')!({}, f.ctx)
    assert.deepEqual([...f.handlers.keys()], names)
    await f.handlers.get('session_shutdown')!({}, f.ctx)
  } finally {
    BackgroundTaskRuntime.prototype.beforeTree = original
    await rm(f.root, { recursive: true, force: true })
  }
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待测试进程状态超时')
}

test('真实隔离进程树在 before_tree 完成前全部退出，日志保留且新分支无旧任务', async () => {
  const f = await fixture()
  const pids: number[] = []
  const runtime = new BackgroundTaskRuntime(f.pi, (command, args, options) => {
    const child = spawn(command, args, options)
    if (child.pid) pids.push(child.pid)
    return child as BackgroundTaskChild
  })
  try {
    await writeFile(
      join(f.root, 'tree-fixture.cjs'),
      `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`,
      'utf8'
    )
    runtime.startSession(f.ctx)
    const task = await runtime.startTask(f.ctx, {
      name: '进程树',
      command: 'node tree-fixture.cjs'
    })
    await waitFor(async () => {
      try {
        const descendants: number[] = JSON.parse(await readFile(join(f.root, 'pids.json'), 'utf8'))
        if (!descendants.every(alive)) return false
        pids.push(...descendants)
        return true
      } catch {
        return false
      }
    })
    assert.equal(await runtime.beforeTree(new AbortController().signal), undefined)
    await waitFor(() => pids.every((pid) => !alive(pid)))
    assert.equal(runtime.listTasks(f.ctx, task.taskId)[0]?.status, 'interrupted')
    assert.match(await readFile(join(f.root, task.outputPath), 'utf8'), /tree-fixture/)
    runtime.startSession(f.ctx)
    assert.deepEqual(runtime.listTasks(f.ctx), [])
    assert.equal(f.messages.length, 0)
  } finally {
    for (const pid of pids) killTree(pid)
    await runtime.shutdown()
    await waitFor(() => pids.every((pid) => !alive(pid)))
    await rm(f.root, { recursive: true, force: true })
  }
})
