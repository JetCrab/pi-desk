import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  defaultSettings,
  storedSchema,
  type TiboRecord,
  type TiboStored
} from './l4-tibo-protocol.js'

const MAX_STORE_BYTES = 64 * 1024 * 1024

export function retainRecords(records: readonly TiboRecord[], count: number): TiboRecord[] {
  const unique = new Map<string, TiboRecord>()
  for (const record of records) if (!unique.has(record.id)) unique.set(record.id, record)
  return [...unique.values()].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, count)
}

async function assertFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Tibo 数据文件必须为普通文件')
    if (info.size > MAX_STORE_BYTES) throw new Error('Tibo 数据文件超过容量限制')
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

export async function readStore(path: string): Promise<TiboStored> {
  if (!(await assertFile(path))) return { settings: defaultSettings(), records: [] }
  const value = storedSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  return {
    settings: value.settings,
    ...(value.analysisRegion ? { analysisRegion: value.analysisRegion } : {}),
    records: retainRecords(value.records, value.settings.retentionCount)
  }
}

export async function writeStore(path: string, value: TiboStored): Promise<void> {
  const stored = storedSchema.parse({
    settings: value.settings,
    ...(value.analysisRegion ? { analysisRegion: value.analysisRegion } : {}),
    records: retainRecords(value.records, value.settings.retentionCount)
  })
  const content = `${JSON.stringify(stored)}\n`
  if (Buffer.byteLength(content) > MAX_STORE_BYTES) throw new Error('Tibo 数据超过容量限制')
  await mkdir(dirname(path), { recursive: true })
  await assertFile(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
