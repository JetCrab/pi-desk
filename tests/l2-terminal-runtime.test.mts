import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import type { IPty } from 'node-pty'
import type { L2TerminalEvent } from '../src/common/l2_biz/terminal/l2-terminal-contract'
import { L2TerminalManage } from '../src/server/l2_biz/terminal/l2-terminal-manage'
import type { L4TerminalRuntime as TerminalRuntime } from '../src/server/l4_foundation/terminal/l4-terminal-runtime'
import type { L4TerminalPty as TerminalPty } from '../src/server/l4_foundation/terminal/l4-terminal-pty'

const { createRequire } = process.getBuiltinModule('module')
const { L4TerminalRuntime } = createRequire(import.meta.url)(
  '../src/server/l4_foundation/terminal/l4-terminal-runtime.ts'
) as typeof import('../src/server/l4_foundation/terminal/l4-terminal-runtime')
const { L4TerminalPty } = createRequire(import.meta.url)(
  '../src/server/l4_foundation/terminal/l4-terminal-pty.ts'
) as typeof import('../src/server/l4_foundation/terminal/l4-terminal-pty')

interface WindowsPtyResources extends IPty {
  _agent: {
    _inSocket: Socket
    _outSocket: Socket
    _conoutSocketWorker: { dispose(): void; _worker: Worker }
  }
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(description)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function printMarker(left: string, right: string): string {
  return process.platform === 'win32'
    ? `Write-Output ('${left}' + '${right}')\r`
    : `printf '\\n${left}%s\\n' '${right}'\r`
}

function outputText(events: readonly L2TerminalEvent[]): string {
  return events
    .map((event) =>
      event.type === 'output' ? event.data : event.type === 'snapshot' ? event.snapshot.data : ''
    )
    .join('')
}

async function assertPortFree(port: number): Promise<void> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test(
  '关闭失败后迟到的PTY退出仍回收原生管道与线程',
  { skip: process.platform !== 'win32', timeout: 25_000 },
  async (context) => {
    const failure = new Error('模拟进程树终止命令失败')
    let target: IPty | undefined
    context.mock.method(
      L4TerminalPty.prototype,
      'stop',
      function (this: TerminalPty): Promise<void> {
        target = this.pty
        return Promise.reject(failure)
      }
    )
    const runtime = new L4TerminalRuntime(
      'late-exit-cleanup',
      {
        cwd: process.cwd(),
        file: process.execPath,
        args: ['-e', 'console.log("LATE_EXIT_READY");setInterval(()=>{},1000)']
      },
      () => {},
      () => {}
    )
    let output = ''
    const observation = await runtime.watch((event) => {
      if (event.type === 'output') output += event.data
    })
    try {
      await waitFor(() => output.includes('LATE_EXIT_READY'), '真实PTY未就绪')
      await assert.rejects(runtime.dispose(), (error: unknown) => error === failure)
      assert.ok(target)
      const pty = target as WindowsPtyResources
      assert.equal(processAlive(pty.pid), true, '失败后不应伪造进程已经退出')
      process.kill(pty.pid, 'SIGKILL')
      await waitFor(
        () => pty._agent._conoutSocketWorker._worker.threadId === -1,
        '上层撤销监听后，PTY退出没有回收输出线程'
      )
      assert.equal(pty._agent._inSocket.destroyed, true)
      assert.equal(pty._agent._outSocket.destroyed, true)
      assert.equal(processAlive(pty.pid), false)
      await assert.rejects(runtime.dispose(), (error: unknown) => error === failure)
    } finally {
      observation.dispose()
      await runtime.dispose().catch(() => undefined)
      if (target) {
        const pty = target as WindowsPtyResources
        if (processAlive(pty.pid)) process.kill(pty.pid, 'SIGKILL')
        await waitFor(() => !processAlive(pty.pid), '回归测试进程未释放')
        // 即使回归失败，也只能清理本用例拥有的原生资源。
        pty._agent._inSocket.destroy()
        pty._agent._outSocket.destroy()
        pty._agent._conoutSocketWorker.dispose()
        await waitFor(
          () => pty._agent._conoutSocketWorker._worker.threadId === -1,
          '回归测试线程未释放'
        )
      }
    }
  }
)

test('关闭先广播并允许新增，服务退出仍等待已移除终端清理', { timeout: 40_000 }, async (context) => {
  const manage = new L2TerminalManage()
  const release = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const dispose = L4TerminalRuntime.prototype.dispose
  let blockedId = ''
  let released = false
  context.mock.method(
    L4TerminalRuntime.prototype,
    'dispose',
    async function (this: TerminalRuntime): Promise<void> {
      if (this.terminalId === blockedId) {
        started.resolve()
        await release.promise
      }
      await dispose.call(this)
      if (this.terminalId === blockedId) released = true
    }
  )
  const snapshots: string[][] = []
  const unsubscribe = manage.subscribeList((terminals) => {
    snapshots.push(terminals.map((terminal) => terminal.terminalId))
  })
  try {
    const terminal = await manage.create(process.cwd())
    blockedId = terminal.terminalId
    let accepted = false
    const removing = manage.remove(blockedId).then(() => {
      accepted = true
    })
    await started.promise
    await waitFor(() => accepted, '关闭接纳仍在等待资源清理')
    await removing
    assert.deepEqual(snapshots.at(-1), [])
    assert.equal(released, false)
    assert.throws(() => manage.input(blockedId, 'echo stale\r'), /终端不存在/)
    const next = await manage.create(process.cwd())
    assert.deepEqual(
      manage.list().map((item) => item.terminalId),
      [next.terminalId]
    )
    let disposed = false
    const closing = manage.dispose().then(() => {
      disposed = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(disposed, false, '服务退出不能漏掉已移除的终端')
    release.resolve()
    await closing
    assert.equal(released, true)
  } finally {
    release.resolve()
    unsubscribe()
    await manage.dispose()
  }
})

test('已接纳关闭的清理失败会记录且由服务退出报告', { timeout: 30_000 }, async (context) => {
  const manage = new L2TerminalManage()
  const dispose = L4TerminalRuntime.prototype.dispose
  const failure = new Error('测试清理失败')
  const errors = context.mock.method(console, 'error', console.error)
  let failedId = ''
  context.mock.method(
    L4TerminalRuntime.prototype,
    'dispose',
    async function (this: TerminalRuntime): Promise<void> {
      await dispose.call(this)
      if (this.terminalId === failedId) throw failure
    }
  )
  try {
    const terminal = await manage.create(process.cwd())
    failedId = terminal.terminalId
    await manage.input(failedId, 'exit\r')
    await waitFor(
      () => manage.list().find((item) => item.terminalId === failedId)?.status === 'exited',
      '失败追踪用例的Shell未自然退出'
    )
    await manage.remove(failedId)
    await waitFor(() => errors.mock.calls.length > 0, '后台清理失败未记录')
    assert.deepEqual(manage.list(), [])
    await assert.rejects(manage.dispose(), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.ok(error.errors.includes(failure))
      return true
    })
  } finally {
    await manage.dispose().catch(() => undefined)
  }
})

for (const action of ['remove', 'dispose'] as const) {
  test(`终端${action}回收普通孙进程及其监听端口`, { timeout: 40_000 }, async () => {
    const root = join(process.cwd(), 'temp/run/terminal')
    await mkdir(root, { recursive: true })
    const cwd = await mkdtemp(join(root, `tree-${action}-`))
    const fixture = join(cwd, 'tree.cjs')
    await writeFile(
      fixture,
      `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));"],{stdio:['ignore','ignore','inherit','ipc']});
child.on('message',({port})=>console.log('TERM_TREE_READY:'+JSON.stringify({parent:process.pid,child:child.pid,port})));
setInterval(()=>{},1000);\n`
    )
    const manage = new L2TerminalManage()
    let disposeWatch: (() => void) | undefined
    let passed = false
    try {
      const terminal = await manage.create(cwd)
      const events: L2TerminalEvent[] = []
      const watch = await manage.watch(terminal.terminalId, (event: L2TerminalEvent) =>
        events.push(event)
      )
      disposeWatch = watch.dispose
      const quote = (text: string): string =>
        `'${text.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
      await manage.input(
        terminal.terminalId,
        `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(fixture)}\r`
      )
      await waitFor(
        () => /TERM_TREE_READY:(\{[^\r\n]*\})/.test(outputText(events)),
        '终端内测试进程未启动'
      )
      const found = /TERM_TREE_READY:(\{[^\r\n]*\})/.exec(outputText(events))
      assert.ok(found)
      const owned = JSON.parse(found[1]) as { parent: number; child: number; port: number }
      assert.equal(processAlive(owned.parent), true)
      assert.equal(processAlive(owned.child), true)
      if (action === 'remove') await manage.remove(terminal.terminalId)
      else await manage.dispose()
      await waitFor(
        () => !processAlive(owned.parent) && !processAlive(owned.child),
        '终端所属子进程仍然存活'
      )
      await assertPortFree(owned.port)
      passed = true
    } finally {
      disposeWatch?.()
      await manage.dispose()
      if (passed) await rm(cwd, { recursive: true, force: true })
      else console.error('终端进程树现场保留：', cwd)
    }
  })
}

test('终端共享、晚加入、尺寸驱动和结束不依赖WorkSession', { timeout: 60_000 }, async () => {
  const root = join(process.cwd(), 'temp/run/terminal')
  await mkdir(root, { recursive: true })
  const cwd = await mkdtemp(join(root, 'runtime-sharing-'))
  const manage = new L2TerminalManage()
  const disposers: Array<() => void> = []
  let passed = false
  try {
    const first = await manage.create(cwd)
    const second = await manage.create(cwd)
    assert.notEqual(first.terminalId, second.terminalId)
    assert.equal(manage.list().length, 2)
    assert.equal(
      first.cwd.replaceAll('\\', '/').toLowerCase(),
      cwd.replaceAll('\\', '/').toLowerCase()
    )
    const a: L2TerminalEvent[] = []
    const b: L2TerminalEvent[] = []
    const watchA = await manage.watch(first.terminalId, (event: L2TerminalEvent) => a.push(event))
    disposers.push(watchA.dispose)
    assert.ok(watchA.snapshot.cols > 0)
    await manage.input(first.terminalId, printMarker('SHARED_', 'READY'))
    await waitFor(() => outputText(a).includes('SHARED_READY'), '首个观察者未收到真实Shell输出')
    const watchB = await manage.watch(first.terminalId, (event: L2TerminalEvent) => b.push(event))
    disposers.push(watchB.dispose)
    assert.ok(watchB.snapshot.data.includes('SHARED_READY'), '晚加入应包含此前真实输出')
    const titles: string[] = []
    disposers.push(
      manage.subscribeList((terminals) => {
        const current = terminals.find((item) => item.terminalId === first.terminalId)
        if (current) titles.push(current.title)
      })
    )
    const setTitle = (title: string): string =>
      process.platform === 'win32'
        ? `[Console]::Write([char]27 + ']2;' + '${title}' + [char]7)\r`
        : `printf '\\033]2;${title}\\007'\r`
    await manage.input(first.terminalId, setTitle('π - SuperPI'))
    await waitFor(() => titles.includes('π - SuperPI'), '程序标题未通过列表更新')
    assert.equal(
      manage.list().find((item) => item.terminalId === first.terminalId)?.title,
      'π - SuperPI'
    )
    const titleStack = (escape: string): string =>
      process.platform === 'win32'
        ? `[Console]::Write([char]27 + '${escape}')\r`
        : `printf '\\033${escape}'\r`
    await manage.input(first.terminalId, titleStack('[22;0t'))
    await manage.input(first.terminalId, setTitle('Temporary Program'))
    await waitFor(() => titles.at(-1) === 'Temporary Program', '临时程序标题未生效')
    await manage.input(first.terminalId, titleStack('[23;0t'))
    await waitFor(() => titles.at(-1) === 'π - SuperPI', '程序恢复窗口标题未生效')
    await manage.input(first.terminalId, setTitle(''))
    await waitFor(() => titles.at(-1) === '', '清空程序标题后应允许Shell名回退')
    await manage.activate(first.terminalId, 'connection-a', 100, 28)
    await manage.activate(first.terminalId, 'connection-b', 45, 18)
    await manage.resize(first.terminalId, 'connection-a', 120, 40)
    const probe = await manage.watch(first.terminalId, () => {})
    assert.equal(probe.snapshot.cols, 45, '旧操作页不能覆盖新操作页尺寸')
    assert.equal(probe.snapshot.rows, 18)
    probe.dispose()
    watchA.dispose()
    manage.releaseOwner('connection-a')
    await manage.input(first.terminalId, printMarker('STILL_', 'RUNNING'))
    await waitFor(() => outputText(b).includes('STILL_RUNNING'), '解除一个观察者不能停止Shell')
    await manage.input(first.terminalId, 'exit\r')
    await waitFor(
      () => manage.list().find((item) => item.terminalId === first.terminalId)?.status === 'exited',
      '自然退出未收敛'
    )
    await manage.remove(first.terminalId)
    assert.equal(manage.list().length, 1)
    await manage.remove(second.terminalId)
    assert.deepEqual(manage.list(), [])
    await assert.rejects(() => manage.create(join(cwd, 'missing-directory')))
    passed = true
  } finally {
    for (const dispose of disposers) dispose()
    await manage.dispose()
    if (passed) await rm(cwd, { recursive: true, force: true })
    else console.error('终端测试现场保留：', cwd)
  }
})
