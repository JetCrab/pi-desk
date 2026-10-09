import { readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type { UsageFileDescriptor } from './usage-scan.js'

const DIRECTORY_CONCURRENCY = 4

export function pathKey(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function nestedParentSessionId(filePath: string): string | null {
  const parts = resolve(filePath).split(/[\\/]+/)
  const index = parts.lastIndexOf('subagents')
  return index >= 0 ? (parts[index + 1] ?? null) : null
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0

  async function run(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index]!)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()))
  return results
}

export async function descriptor(
  path: string,
  nestedSubagent: boolean
): Promise<UsageFileDescriptor | null> {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile()) return null
    return {
      path: resolve(path),
      size: metadata.size,
      modifiedAt: metadata.mtime.getTime(),
      nestedSubagent
    }
  } catch {
    return null
  }
}

function isSessionJsonlFile(name: string): boolean {
  return name.endsWith('.jsonl') && !name.includes('.jsonl.')
}

export async function listSessionCandidates(
  root: string,
  cwd: string,
  sessionId: string
): Promise<UsageFileDescriptor[]> {
  const directoryName = `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`
  const suffix = `_${sessionId}.jsonl`.toLowerCase()
  const files: UsageFileDescriptor[] = []
  for (const directory of [join(root, directoryName), root]) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(suffix)) continue
      const file = await descriptor(join(directory, entry.name), false)
      if (file) files.push(file)
    }
  }
  return files
}

async function nestedSessionFiles(directory: string): Promise<UsageFileDescriptor[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files: UsageFileDescriptor[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await nestedSessionFiles(path)))
    } else if (entry.isFile() && isSessionJsonlFile(entry.name)) {
      const file = await descriptor(path, true)
      if (file) files.push(file)
    }
  }
  return files
}

async function projectSessionFiles(directory: string): Promise<UsageFileDescriptor[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const directFiles = await mapWithConcurrency(
    entries.filter((entry) => entry.isFile() && isSessionJsonlFile(entry.name)),
    DIRECTORY_CONCURRENCY,
    (entry) => descriptor(join(directory, entry.name), false)
  )
  const subagentDirectory = entries.find(
    (entry) => entry.isDirectory() && entry.name === 'subagents'
  )
  const nested = subagentDirectory
    ? await nestedSessionFiles(join(directory, subagentDirectory.name))
    : []
  return [...directFiles.filter((file): file is UsageFileDescriptor => file !== null), ...nested]
}

export async function listStandardSessionFiles(root: string): Promise<UsageFileDescriptor[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const rootFiles = await mapWithConcurrency(
    entries.filter((entry) => entry.isFile() && isSessionJsonlFile(entry.name)),
    DIRECTORY_CONCURRENCY,
    (entry) => descriptor(join(root, entry.name), false)
  )
  const directories = entries.filter((entry) => entry.isDirectory())
  const nested = await mapWithConcurrency(directories, DIRECTORY_CONCURRENCY, (entry) =>
    projectSessionFiles(join(root, entry.name))
  )
  return [
    ...rootFiles.filter((file): file is UsageFileDescriptor => file !== null),
    ...nested.flat()
  ]
}
