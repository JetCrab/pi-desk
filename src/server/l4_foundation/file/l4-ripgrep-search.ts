import 'server-only'

import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import type { L4ProjectSearchInput } from '@common/l4_foundation/file/l4-project-file-contract'

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024

export class L4ProjectSearchError extends Error {
  constructor(
    readonly kind: 'invalid-pattern' | 'unavailable' | 'timeout' | 'read-failed',
    message: string
  ) {
    super(message)
    this.name = 'L4ProjectSearchError'
  }
}

export interface RipgrepMatch {
  path: { text?: string; bytes?: string }
  lines: { text?: string; bytes?: string }
  line_number: number
  submatches: Array<{ start: number; end: number }>
}

export interface RipgrepBudget {
  deadline: number
  outputBytes: number
}

export function checkSearchActive(signal: AbortSignal | undefined, budget: RipgrepBudget): void {
  signal?.throwIfAborted()
  if (Date.now() >= budget.deadline) {
    throw new L4ProjectSearchError('timeout', '项目搜索超时，请缩小搜索范围')
  }
}

export function ripgrepPatternArgs(input: L4ProjectSearchInput): string[] {
  return [
    '--no-config',
    '--json',
    input.caseSensitive ? '--case-sensitive' : '--ignore-case',
    ...(input.regex ? [] : ['--fixed-strings']),
    ...(input.wholeWord ? ['--word-regexp'] : []),
    '-e',
    input.query
  ]
}

async function resolveRipgrep(): Promise<string> {
  try {
    // ESM 导入让 Next 保留外部依赖；require 会导致开发编译器继续解析平台二进制。
    return (await import('@vscode/ripgrep')).rgPath
  } catch {
    throw new L4ProjectSearchError('unavailable', '项目搜索引擎不可用，请重新安装完整运行依赖')
  }
}

export async function runRipgrep(
  cwd: string,
  args: string[],
  budget: RipgrepBudget,
  signal: AbortSignal | undefined,
  onMatch: (match: RipgrepMatch) => boolean,
  stdin?: Iterable<string>
): Promise<boolean> {
  checkSearchActive(signal, budget)
  const executable = await resolveRipgrep()
  checkSearchActive(signal, budget)
  return new Promise<boolean>((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: 'pipe' })
    let pending = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let truncated = false
    let failure: unknown
    let stopped = false
    const source = stdin ? Readable.from(stdin) : null

    const stop = (): void => {
      stopped = true
      source?.unpipe(child.stdin)
      source?.destroy()
      child.stdin.destroy()
      child.kill()
    }
    const abort = (): void => {
      failure = signal?.reason ?? new DOMException('搜索已取消', 'AbortError')
      stop()
    }
    const timer = setTimeout(
      () => {
        failure = new L4ProjectSearchError('timeout', '项目搜索超时，请缩小搜索范围')
        stop()
      },
      Math.max(1, budget.deadline - Date.now())
    )

    const consume = (line: Buffer): void => {
      if (line.length === 0) return
      try {
        const event = JSON.parse(line.toString('utf8')) as { type: string; data: RipgrepMatch }
        if (event.type === 'match' && !onMatch(event.data)) {
          truncated = true
          stop()
        }
      } catch (error) {
        failure =
          error instanceof L4ProjectSearchError
            ? error
            : new L4ProjectSearchError('read-failed', '无法解析项目搜索结果')
        stop()
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return
      const remaining = MAX_OUTPUT_BYTES - budget.outputBytes
      budget.outputBytes += chunk.length
      const accepted = chunk.subarray(0, Math.max(0, remaining))
      pending = Buffer.concat([pending, accepted])
      let end: number
      while (!stopped && (end = pending.indexOf(10)) >= 0) {
        if (end > MAX_RECORD_BYTES) {
          budget.outputBytes = MAX_OUTPUT_BYTES + 1
          truncated = true
          stop()
          break
        }
        consume(pending.subarray(0, end))
        pending = pending.subarray(end + 1)
      }
      if (
        !stopped &&
        (pending.length > MAX_RECORD_BYTES || budget.outputBytes > MAX_OUTPUT_BYTES)
      ) {
        budget.outputBytes = MAX_OUTPUT_BYTES + 1
        truncated = true
        stop()
      }
      if (stopped) pending = Buffer.alloc(0)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = MAX_STDERR_BYTES - stderr.length
      if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)])
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // rg 可因非法正则先关闭 stdin，真实原因由 close 的退出码与 stderr 决定。
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED' && !stopped) {
        failure = new L4ProjectSearchError('read-failed', '无法向项目搜索引擎传递文件列表')
        stop()
      }
    })
    child.once('error', () => {
      failure = new L4ProjectSearchError('unavailable', '项目搜索引擎无法启动，请检查运行依赖')
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      source?.unpipe(child.stdin)
      source?.destroy()
      child.stdin.destroy()
      if (!stopped && pending.length > 0) consume(pending)
      pending = Buffer.alloc(0)
      const diagnostic = stderr.toString('utf8')
      stderr = Buffer.alloc(0)
      if (failure) rejectRun(failure)
      else if (truncated || code === 0 || code === 1) resolveRun(truncated)
      else if (
        /regex parse error|regex syntax error|error parsing.*regex|compiled regex exceeds size limit/i.test(
          diagnostic
        )
      ) {
        rejectRun(new L4ProjectSearchError('invalid-pattern', '正则表达式无效或包含不支持的语法'))
      } else
        rejectRun(
          new L4ProjectSearchError(
            'read-failed',
            `项目搜索读取失败：${diagnostic.trim() || `退出码 ${code}`}`
          )
        )
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    else if (source) source.pipe(child.stdin)
    else child.stdin.end()
  })
}

export function ripgrepText(value: { text?: string; bytes?: string }): string {
  return value.text ?? Buffer.from(value.bytes ?? '', 'base64').toString('utf8')
}
