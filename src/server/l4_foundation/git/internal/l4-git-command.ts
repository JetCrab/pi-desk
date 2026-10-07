import 'server-only'
import { execFile } from 'node:child_process'

export interface GitTextResult {
  code: number | null
  stdout: string
  stderr: string
}
export interface GitBufferResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

const READ_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }

export function executeGitText(
  repository: string,
  args: readonly string[],
  options: { timeout?: number; readOnly?: boolean } = {}
): Promise<GitTextResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repository, ...args],
      {
        encoding: 'utf8',
        timeout: options.timeout ?? 15_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', ...(options.readOnly === false ? {} : READ_ENV) }
      },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === 'number' ? error.code : error ? null : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr || (error instanceof Error ? error.message : ''))
        })
      }
    )
  })
}

export function executeGitBuffer(
  repository: string,
  args: readonly string[]
): Promise<GitBufferResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repository, ...args],
      {
        encoding: 'buffer',
        timeout: 15_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', ...READ_ENV }
      },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === 'number' ? error.code : error ? null : 0,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
          stderr:
            (Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')) ||
            (error instanceof Error ? error.message : '')
        })
      }
    )
  })
}
