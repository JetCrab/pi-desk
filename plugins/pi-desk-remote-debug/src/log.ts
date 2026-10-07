import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const MAX_RUN_LOG_BYTES = 20 * 1024 * 1024
export const MAX_RUN_ARTIFACTS = 100

const TRUNCATED_MARKER = '\n[system] 日志达到 20MB 上限，后续输出不再记录。\n'

export class RunLogger {
  readonly path: string
  private readonly stream: WriteStream
  private bytesWritten: number
  private truncated = false
  private closed = false

  private constructor(path: string, stream: WriteStream, bytesWritten: number) {
    this.path = path
    this.stream = stream
    this.bytesWritten = bytesWritten
    this.stream.on('error', (error) => {
      console.error(`[pi-desk-remote-debug] 写入运行日志失败：${error.message}`)
    })
  }

  static async create(path: string, command: string): Promise<RunLogger> {
    await mkdir(dirname(path), { recursive: true })
    const header = `[Remote Debug]\ncommand=${command}\nstartedAt=${new Date().toISOString()}\n\n`
    await writeFile(path, header, 'utf8')
    return new RunLogger(path, createWriteStream(path, { flags: 'a' }), Buffer.byteLength(header))
  }

  line(channel: string, content: string): void {
    const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    for (const line of lines) {
      if (!line) continue
      this.write(`[${new Date().toISOString()}] [${channel}] ${line}\n`)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.stream.closed || this.stream.destroyed) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      this.stream.once('close', finish)
      this.stream.once('error', finish)
      this.stream.end(finish)
    })
  }

  private write(content: string): void {
    if (this.closed || this.truncated || this.stream.destroyed) return
    const buffer = Buffer.from(content)
    const marker = Buffer.from(TRUNCATED_MARKER)
    const contentLimit = MAX_RUN_LOG_BYTES - marker.length
    const remaining = contentLimit - this.bytesWritten
    if (buffer.length <= remaining) {
      this.stream.write(buffer)
      this.bytesWritten += buffer.length
      return
    }

    if (remaining > 0) {
      const partial = buffer.subarray(0, remaining)
      this.stream.write(partial)
      this.bytesWritten += partial.length
    }
    this.stream.write(marker)
    this.bytesWritten += marker.length
    this.truncated = true
  }
}

interface ArtifactEntry {
  directory: string
  mtimeMs: number
}

export async function pruneRunArtifacts(
  root: string,
  protectedDirectories: ReadonlySet<string>,
  maxArtifacts = MAX_RUN_ARTIFACTS
): Promise<void> {
  if (!existsSync(root)) return
  const directories = await readdir(root, { withFileTypes: true })
  const entries: ArtifactEntry[] = []
  for (const entry of directories) {
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name)
    const logPath = join(directory, 'run.log')
    const metadata = await stat(existsSync(logPath) ? logPath : directory).catch(() => undefined)
    if (metadata) entries.push({ directory, mtimeMs: metadata.mtimeMs })
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs)
  let remaining = entries.length
  for (const entry of entries) {
    if (remaining <= maxArtifacts) break
    if (protectedDirectories.has(entry.directory)) continue
    await rm(entry.directory, { recursive: true, force: true })
    remaining -= 1
  }
}
