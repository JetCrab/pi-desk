import 'server-only'

import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import type { L4PiPluginSource, L4PiPluginSourceSnapshot } from './l4-pi-plugin-sources'

const FILE_TYPES = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.css',
  '.yaml',
  '.yml',
  '.toml',
  '.wasm',
  '.node'
])
const SKIP_DIRECTORIES = new Set(['node_modules', 'temp', 'logs', 'coverage'])

export class L4PiPluginSourceNotFoundError extends Error {
  constructor(readonly source: string) {
    super(`插件来源不存在：${source}`)
    this.name = 'L4PiPluginSourceNotFoundError'
  }
}

export interface L4PiPluginSourceChange {
  source: string
  previous: L4PiPluginSource | null
  current: L4PiPluginSource | null
  fingerprint: string | null
}

async function fingerprint(source: L4PiPluginSource): Promise<string> {
  const hash = createHash('sha256').update(
    JSON.stringify({
      path: source.path,
      enabled: source.enabled,
      nativePaths: [...source.nativePaths].sort(),
      piDeskRoot: source.piDeskRoot,
      hasPiResources: source.hasPiResources
    })
  )
  if (!source.path || source.error || !source.enabled)
    return hash.update(source.error ?? '').digest('hex')
  const root = await realpath(source.path)
  let bytes = 0
  let entries = 0
  const visit = async (path: string, name: string, ancestors: Set<string>): Promise<void> => {
    if (++entries > 8192) throw new Error('源码目录条目超过8192项，请使用独立插件目录')
    const actual = await realpath(path)
    const fromRoot = relative(root, actual)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) return
    const metadata = await stat(actual)
    if (metadata.isDirectory()) {
      if (ancestors.has(actual)) throw new Error('源码目录存在符号链接循环')
      const next = new Set(ancestors).add(actual)
      for (const entry of (await readdir(actual, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      )) {
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue
        await visit(join(actual, entry.name), `${name}/${entry.name}`, next)
      }
    } else if (metadata.isFile() && (name === '' || FILE_TYPES.has(extname(name)))) {
      if (metadata.size > 16 * 1024 * 1024 || bytes + metadata.size > 64 * 1024 * 1024) {
        throw new Error('源码指纹内容超过容量上限')
      }
      const data = await readFile(actual)
      const after = await stat(actual)
      if (
        after.size !== metadata.size ||
        after.mtimeMs !== metadata.mtimeMs ||
        data.length !== metadata.size
      ) {
        throw new Error('插件源码正在变化，请保存或构建完成后重新加载')
      }
      bytes += data.length
      hash.update(name).update('\0').update(data).update('\0')
    }
  }
  await visit(root, '', new Set())
  return hash.digest('hex')
}

async function describe(
  source: L4PiPluginSource
): Promise<{ source: L4PiPluginSource; fingerprint: string }> {
  try {
    return { source, fingerprint: await fingerprint(source) }
  } catch (error) {
    const failed = { ...source, error: error instanceof Error ? error.message : String(error) }
    return { source: failed, fingerprint: `failed:${failed.error}` }
  }
}

export class L4PiPluginSourceChanges {
  private readonly applied = new Map<string, { source: L4PiPluginSource; fingerprint: string }>()

  async initialize(snapshot: L4PiPluginSourceSnapshot): Promise<void> {
    this.applied.clear()
    for (const source of snapshot.sources) this.applied.set(source.source, await describe(source))
  }

  async scan(
    snapshot: L4PiPluginSourceSnapshot,
    requested?: readonly string[]
  ): Promise<L4PiPluginSourceChange[]> {
    const current = new Map(snapshot.sources.map((source) => [source.source, source]))
    const names = requested
      ? [...new Set(requested)]
      : [...new Set([...this.applied.keys(), ...current.keys()])]
    const changes: L4PiPluginSourceChange[] = []
    for (const source of names) {
      const previous = this.applied.get(source)
      const item = current.get(source)
      if (!previous && !item) throw new L4PiPluginSourceNotFoundError(source)
      // 部分发现失败不等于已删除，不能批量卸载暂时不可见的正常插件。
      if (!item && snapshot.errors.length > 0) {
        if (requested) throw new Error(`来源发现不完整，不能确认已删除：${source}`)
        continue
      }
      const next = item ? await describe(item) : null
      if (!requested && previous?.fingerprint === next?.fingerprint) continue
      changes.push({
        source,
        previous: previous?.source ?? null,
        current: next?.source ?? null,
        fingerprint: next?.fingerprint ?? null
      })
    }
    return changes
  }

  commit(change: L4PiPluginSourceChange): void {
    if (change.current && change.fingerprint !== null) {
      this.applied.set(change.source, { source: change.current, fingerprint: change.fingerprint })
    } else this.applied.delete(change.source)
  }
}
