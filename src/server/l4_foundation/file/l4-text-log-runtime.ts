import 'server-only'

import { watch, type FSWatcher } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { getL4FileSystemKey as pathKey } from './l4-file-path'

export interface L4TextLogSnapshot {
  text: string
  truncated: boolean
}

export type L4TextLogEvent =
  | { type: 'text_append'; text: string }
  | { type: 'snapshot'; snapshot: L4TextLogSnapshot }
  | { type: 'unavailable' }

export interface L4TextLogObservation {
  snapshot: L4TextLogSnapshot
  readSnapshot(): L4TextLogSnapshot
  release(): void
}

type L4TextLogListener = (event: L4TextLogEvent) => void

interface L4TextLogSharedRuntime {
  runtime: L4TextLogRuntime
  references: number
}

const TEXT_MAX_BYTES = 128 * 1024
const TEXT_MAX_LINES = 1000
const FILE_REFRESH_INTERVAL_MS = 500
const FILE_WATCH_DEBOUNCE_MS = 40
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g

function normalizedAbsolutePath(path: string): string {
  const value = path.trim()
  if (!value || value.length > 32_768 || !isAbsolute(value)) {
    throw new Error('Text log path must be an absolute path')
  }
  return resolve(value)
}

function cloneSnapshot(snapshot: L4TextLogSnapshot): L4TextLogSnapshot {
  return { ...snapshot }
}

function publishSafely(
  listeners: Iterable<L4TextLogListener>,
  event: L4TextLogEvent,
  path: string
): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (error) {
      console.error('[Pi Desk][TextLogRuntime] 日志监听器执行失败', {
        path,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
    }
  }
}

async function readTextTail(path: string): Promise<L4TextLogSnapshot> {
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', truncated: false }
    throw error
  }
  if (!fileStat.isFile()) throw new Error(`Text log source is not a file: ${path}`)

  const start = Math.max(0, fileStat.size - TEXT_MAX_BYTES)
  const length = fileStat.size - start
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    if (length > 0) await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8').replace(ANSI_PATTERN, '')
    let truncated = start > 0
    if (start > 0) {
      const firstLine = text.indexOf('\n')
      if (firstLine >= 0) text = text.slice(firstLine + 1)
    }
    const lines = text.split('\n')
    if (lines.length > TEXT_MAX_LINES) {
      text = lines.slice(lines.length - TEXT_MAX_LINES).join('\n')
      truncated = true
    }
    return { text, truncated }
  } finally {
    await handle.close()
  }
}

class L4TextLogRuntime {
  private readonly listeners = new Set<L4TextLogListener>()
  private watcher: FSWatcher | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private refreshPromise: Promise<void> | null = null
  private current: L4TextLogSnapshot
  private disposed = false

  private constructor(
    private readonly path: string,
    initial: L4TextLogSnapshot
  ) {
    this.current = initial
  }

  static async create(path: string): Promise<L4TextLogRuntime> {
    const runtime = new L4TextLogRuntime(path, await readTextTail(path))
    runtime.startWatching()
    return runtime
  }

  snapshot(): L4TextLogSnapshot {
    return cloneSnapshot(this.current)
  }

  subscribe(listener: L4TextLogListener): () => void {
    if (this.disposed) throw new Error('Text log runtime has been disposed')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.watcher?.close()
    if (this.interval) clearInterval(this.interval)
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.watcher = null
    this.interval = null
    this.refreshTimer = null
    this.listeners.clear()
  }

  private startWatching(): void {
    try {
      this.watcher = watch(this.path, () => this.scheduleRefresh())
      this.watcher.on('error', () => this.scheduleRefresh())
    } catch {
      this.watcher = null
    }
    this.interval = setInterval(() => this.scheduleRefresh(), FILE_REFRESH_INTERVAL_MS)
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refresh()
    }, FILE_WATCH_DEBOUNCE_MS)
  }

  private refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      try {
        const next = await readTextTail(this.path)
        if (
          this.disposed ||
          (next.text === this.current.text && next.truncated === this.current.truncated)
        ) {
          return
        }
        const previous = this.current
        this.current = next
        const appended = next.text.startsWith(previous.text)
          ? next.text.slice(previous.text.length)
          : ''
        if (appended && next.truncated === previous.truncated) {
          publishSafely(this.listeners, { type: 'text_append', text: appended }, this.path)
        } else {
          publishSafely(
            this.listeners,
            { type: 'snapshot', snapshot: cloneSnapshot(next) },
            this.path
          )
        }
      } catch (error) {
        console.warn('[Pi Desk][TextLogRuntime] 刷新日志失败', {
          path: this.path,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
        publishSafely(this.listeners, { type: 'unavailable' }, this.path)
      }
    })().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }
}

export class L4TextLogPool {
  private readonly sharedByPath = new Map<string, L4TextLogSharedRuntime>()
  private readonly pendingByPath = new Map<string, Promise<L4TextLogSharedRuntime>>()
  private disposed = false

  async observe(pathInput: string, listener: L4TextLogListener): Promise<L4TextLogObservation> {
    if (this.disposed) throw new Error('Text log pool has been disposed')
    const path = normalizedAbsolutePath(pathInput)
    const key = pathKey(path)
    let shared = this.sharedByPath.get(key)
    if (!shared) {
      let pending = this.pendingByPath.get(key)
      if (!pending) {
        pending = L4TextLogRuntime.create(path)
          .then((runtime) => {
            if (this.disposed) {
              runtime.dispose()
              throw new Error('Text log pool was disposed during initialization')
            }
            const created = { runtime, references: 0 }
            this.sharedByPath.set(key, created)
            return created
          })
          .finally(() => {
            this.pendingByPath.delete(key)
          })
        this.pendingByPath.set(key, pending)
      }
      shared = await pending
    }

    shared.references += 1
    const unsubscribe = shared.runtime.subscribe(listener)
    let released = false
    return {
      snapshot: shared.runtime.snapshot(),
      readSnapshot: () => shared!.runtime.snapshot(),
      release: () => {
        if (released) return
        released = true
        unsubscribe()
        shared!.references -= 1
        if (shared!.references > 0) return
        if (this.sharedByPath.get(key) === shared) this.sharedByPath.delete(key)
        shared!.runtime.dispose()
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const shared of this.sharedByPath.values()) shared.runtime.dispose()
    this.sharedByPath.clear()
    this.pendingByPath.clear()
  }
}

const sharedTextLogPool = new L4TextLogPool()

export function getL4TextLogPool(): L4TextLogPool {
  return sharedTextLogPool
}
