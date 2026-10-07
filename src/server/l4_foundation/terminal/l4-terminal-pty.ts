import 'server-only'

import { execFile } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, isAbsolute, join, delimiter } from 'node:path'
import { homedir, release } from 'node:os'
import { promisify } from 'node:util'
import type { Socket } from 'node:net'
import type { Worker } from 'node:worker_threads'
import type { IPty } from 'node-pty'

const execFileAsync = promisify(execFile)
const { createRequire } = process.getBuiltinModule('module')
const load = createRequire(join(process.cwd(), 'package.json'))
const MAX_PENDING_INPUT = 64 * 1024

// xterm onBinary 的 X10 鼠标坐标是字节字符；普通键盘和粘贴仍使用 UTF-8。
export function encodeL4TerminalInput(data: string): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  for (const match of data.matchAll(/\x1b\[M[\x00-\xff]{3}/g)) {
    const index = match.index
    if (index > offset) parts.push(Buffer.from(data.slice(offset, index), 'utf8'))
    parts.push(Buffer.from(match[0], 'latin1'))
    offset = index + match[0].length
  }
  if (offset === 0) return Buffer.from(data, 'utf8')
  if (offset < data.length) parts.push(Buffer.from(data.slice(offset), 'utf8'))
  return Buffer.concat(parts)
}

export class L4TerminalError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'L4TerminalError'
  }
}

interface WindowsPty110 extends IPty {
  _isReady: boolean
  _deferreds: unknown[]
  _agent: {
    _useConpty: boolean
    _useConptyDll: boolean
    readonly exitCode: number | undefined
    _inSocket: Socket
    _outSocket: Socket
    _conoutSocketWorker: { dispose(): void; _worker: Worker }
  }
}

interface UnixPty110 extends IPty {
  _writeStream: { _writeQueue: Array<{ buffer: Buffer; offset: number }> }
}

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

export async function resolveL4TerminalStart(cwd?: string): Promise<{
  cwd: string
  file: string
  args: string[]
  shell: string
}> {
  const directory = cwd ?? homedir()
  if (!isAbsolute(directory)) throw new L4TerminalError(400, '终端目录必须是绝对路径')
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new L4TerminalError(400, '终端目录不存在或不是目录')
  }
  let file = '/bin/sh'
  const args: string[] = []
  if (process.platform === 'win32') {
    const candidates = (process.env.PATH ?? '')
      .split(delimiter)
      .map((entry) => join(entry.replace(/^"|"$/g, ''), 'pwsh.exe'))
    candidates.push(join(process.env.ProgramFiles ?? 'C:/Program Files', 'PowerShell/7/pwsh.exe'))
    file = join(
      process.env.SystemRoot ?? 'C:/Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    )
    for (const candidate of candidates) {
      if (isAbsolute(candidate) && (await executable(candidate))) {
        file = candidate
        break
      }
    }
    args.push('-NoLogo', '-NoProfile')
  } else if (
    process.env.SHELL &&
    isAbsolute(process.env.SHELL) &&
    (await executable(process.env.SHELL))
  ) {
    file = process.env.SHELL
  }
  if (!(await executable(file))) throw new L4TerminalError(503, '没有可用的终端 Shell')
  return { cwd: directory, file, args, shell: basename(file) }
}

export class L4TerminalPty {
  readonly pty: IPty
  readonly released: Promise<void>
  private readonly workerExit: Promise<void> | null
  private readonly processExit: Promise<void>
  private stopped: Promise<void> | null = null
  private exited = false
  private earlyInputBytes = 0

  constructor(start: { cwd: string; file: string; args: string[] }, cols: number, rows: number) {
    try {
      const version = (load('node-pty/package.json') as { version: string }).version
      // 队列观测和 Windows 自然退出释放仅按已验证的原生版本适配，升级必须重新核对。
      if (version !== '1.1.0') throw new Error(`不支持的 node-pty 版本：${version}`)
      if (process.platform === 'win32' && Number(release().split('.')[2]) < 18309)
        throw new Error('系统 Windows 版本不支持稳定 ConPTY')
      const native = load('node-pty') as typeof import('node-pty')
      this.pty = native.spawn(start.file, start.args, {
        cwd: start.cwd,
        cols,
        rows,
        name: 'xterm-256color',
        env: { ...process.env, TERM: 'xterm-256color' },
        useConpty: true,
        useConptyDll: false
      })
      if (process.platform === 'win32') {
        const agent = (this.pty as WindowsPty110)._agent
        if (!agent._useConpty || agent._useConptyDll) throw new Error('终端需要系统 ConPTY')
        this.workerExit = new Promise<void>((resolve, reject) => {
          agent._conoutSocketWorker._worker.once('exit', () => resolve())
          agent._conoutSocketWorker._worker.once('error', reject)
        })
        // 原生失败即使先于调用方等待也不制造未处理拒绝。
        void this.workerExit.catch(() => undefined)
      } else {
        this.workerExit = null
      }
      this.processExit = new Promise<void>((resolve) => {
        const subscription = this.pty.onExit(() => {
          this.exited = true
          subscription.dispose()
          resolve()
        })
      })
      // 原生清理由PTY自身的退出监听触发，不依赖上层Runtime是否仍在观察。
      this.released = this.processExit.then(() => this.releaseNative())
      void this.released.catch((error: unknown) =>
        console.error('[Pi Desk][Terminal] 原生资源释放失败', { pid: this.pty.pid, error })
      )
    } catch (error) {
      console.error('[Pi Desk][Terminal] PTY 加载或启动失败', {
        message: error instanceof Error ? error.message : String(error)
      })
      throw new L4TerminalError(503, '终端原生依赖不可用或 Shell 启动失败')
    }
  }

  write(data: string): void {
    if (this.exited) throw new L4TerminalError(409, '终端已经退出')
    const windows = process.platform === 'win32' ? (this.pty as WindowsPty110) : null
    if (windows?._isReady) this.earlyInputBytes = 0
    const pending = windows
      ? windows._agent._inSocket.writableLength + this.earlyInputBytes
      : (this.pty as UnixPty110)._writeStream._writeQueue.reduce(
          (total, item) => total + item.buffer.length - item.offset,
          0
        )
    if (pending + Buffer.byteLength(data) > MAX_PENDING_INPUT)
      throw new L4TerminalError(429, '终端输入缓冲已满')
    this.checkDeferredCapacity()
    if (windows && !windows._isReady) this.earlyInputBytes += Buffer.byteLength(data)
    this.pty.write(encodeL4TerminalInput(data))
  }

  resize(cols: number, rows: number): void {
    this.checkDeferredCapacity()
    this.pty.resize(cols, rows)
  }

  private checkDeferredCapacity(): void {
    if (process.platform === 'win32' && (this.pty as WindowsPty110)._deferreds.length >= 256)
      throw new L4TerminalError(429, '终端初始化操作队列已满')
  }

  stop(): Promise<void> {
    if (!this.stopped) this.stopped = this.stopTree()
    return this.stopped
  }

  private async stopTree(): Promise<void> {
    const startedAt = performance.now()
    if (!this.exited) {
      if (process.platform === 'win32') {
        try {
          await execFileAsync('taskkill.exe', ['/PID', String(this.pty.pid), '/T', '/F'], {
            windowsHide: true,
            timeout: 4000,
            maxBuffer: 64 * 1024
          })
        } catch (error) {
          this.logStopFailure('终止进程树', startedAt, error)
          if (!this.exited) throw error
        }
      } else {
        // 交互 Shell 的作业可能另有进程组；先捕获所属子孙，再从叶到根结束。
        const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='], {
          timeout: 2000,
          maxBuffer: 2 * 1024 * 1024
        })
        const rows = stdout
          .trim()
          .split('\n')
          .map((line) => line.trim().split(/\s+/).map(Number))
        const owned = new Set([this.pty.pid])
        const descendants: number[] = []
        let added = true
        while (added) {
          added = false
          for (const [pid, parent] of rows) {
            if (owned.has(parent) && !owned.has(pid)) {
              owned.add(pid)
              descendants.push(pid)
              added = true
            }
          }
        }
        for (const pid of descendants.reverse()) this.killUnix(pid)
        this.killUnix(-this.pty.pid)
        this.pty.kill('SIGKILL')
      }
    }
    const signaledAt = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.processExit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Shell 退出等待超时')), 4000)
        })
      ])
    } catch (error) {
      this.logStopFailure('等待 Shell 退出', startedAt, error)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
    const exitedAt = performance.now()
    await this.released
    console.info('[Pi Desk][Terminal] 原生终端停止完成', {
      pid: this.pty.pid,
      terminateMs: Math.round(signaledAt - startedAt),
      exitMs: Math.round(exitedAt - signaledAt),
      releaseMs: Math.round(performance.now() - exitedAt),
      totalMs: Math.round(performance.now() - startedAt)
    })
  }

  private logStopFailure(stage: string, startedAt: number, error: unknown): void {
    let processAlive: boolean | null = null
    try {
      process.kill(this.pty.pid, 0)
      processAlive = true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') processAlive = false
    }
    console.error('[Pi Desk][Terminal] 终端停止阶段失败', {
      pid: this.pty.pid,
      stage,
      elapsedMs: Math.round(performance.now() - startedAt),
      processAlive,
      ptyExited: this.exited,
      nativeExitCode:
        process.platform === 'win32' ? ((this.pty as WindowsPty110)._agent.exitCode ?? null) : null,
      error
    })
  }

  private killUnix(pid: number): void {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  private async releaseNative(): Promise<void> {
    if (process.platform !== 'win32') return
    const agent = (this.pty as WindowsPty110)._agent
    // 1.1.0 自然退出只销毁 outSocket，漏掉输入句柄和 Conout worker。
    // 此处不再 kill 已退出 PID，也不调用会 fork console-list agent 的 public kill。
    agent._inSocket.destroy()
    agent._outSocket.destroy()
    agent._conoutSocketWorker.dispose()
    await this.workerExit
  }
}
