import 'server-only'

import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, win32 } from 'node:path'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import type { L4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { fetchRegistryBytes, L4PluginRegistryError } from './l4-pi-plugin-registry-network'

const unzip = promisify(gunzip)
const TEXT_LIMIT = 64 * 1024

export function registryObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readmePaths(manifest: Record<string, unknown>): [string, string][] {
  const i18n = registryObject(registryObject(manifest.piDesk).i18n)
  return Object.entries(i18n)
    .slice(0, 16)
    .flatMap(([locale, translation]) => {
      const path = registryObject(translation).readme
      return locale.length > 0 &&
        locale.length <= 35 &&
        typeof path === 'string' &&
        path.length <= 1024
        ? [[locale, path] as [string, string]]
        : []
    })
}

function safePath(path: string): string | null {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  if (
    !normalized ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '..')
  )
    return null
  return normalized
}

function localized(
  defaultText: string | null,
  translations: Record<string, string>
): L4LocalizedText | null {
  if (defaultText === null && !Object.keys(translations).length) return null
  const text = defaultText ?? Object.values(translations)[0]!
  return Object.keys(translations).length ? { default: text, translations } : text
}

async function readLocal(root: string, path: string): Promise<string | null> {
  if (!safePath(path)) return null
  try {
    const actual = await realpath(resolve(root, path))
    const inside = relative(root, actual)
    if (
      isAbsolute(inside) ||
      inside === '..' ||
      inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    )
      return null
    const file = await open(actual, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > TEXT_LIMIT) return null
      const bytes = Buffer.alloc(TEXT_LIMIT + 1)
      let size = 0
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size)
        if (!bytesRead) break
        size += bytesRead
      }
      return size <= TEXT_LIMIT ? bytes.subarray(0, size).toString('utf8') : null
    } finally {
      await file.close()
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
}

export async function readL4PluginReadme(root: string): Promise<L4LocalizedText | null> {
  const actualRoot = await realpath(root)
  const packageText = await readLocal(actualRoot, 'package.json')
  const manifest = packageText ? registryObject(JSON.parse(packageText)) : {}
  const translations: Record<string, string> = {}
  for (const [locale, path] of readmePaths(manifest)) {
    const text = await readLocal(actualRoot, path)
    if (text !== null) translations[locale] = text
  }
  return localized(await readLocal(actualRoot, 'README.md'), translations)
}

function tarString(header: Buffer, start: number, size: number): string {
  return header
    .subarray(start, start + size)
    .toString('utf8')
    .split('\0')[0]!
}

function tarNumber(header: Buffer, start: number, length: number): number {
  const text = tarString(header, start, length).trim()
  if (!/^[0-7]+$/.test(text)) throw new L4PluginRegistryError('插件说明压缩包头部无效')
  return parseInt(text, 8)
}

function paxPath(body: Buffer): string | undefined {
  let offset = 0
  let path: string | undefined
  while (offset < body.length) {
    const space = body.indexOf(32, offset)
    if (space < 0) throw new L4PluginRegistryError('插件说明压缩包 PAX 记录无效')
    const lengthText = body.subarray(offset, space).toString('ascii')
    const length = Number(lengthText)
    if (!/^\d+$/.test(lengthText) || length <= space - offset + 1 || offset + length > body.length)
      throw new L4PluginRegistryError('插件说明压缩包 PAX 记录无效')
    const field = body.subarray(space + 1, offset + length - 1).toString('utf8')
    if (field.startsWith('path=')) path = field.slice(5)
    offset += length
  }
  return path
}

function tarReadmes(tar: Buffer, manifest: Record<string, unknown>): L4LocalizedText | null {
  const paths = readmePaths(manifest)
  const wanted = new Set(paths.flatMap(([, path]) => (safePath(path) ? [safePath(path)!] : [])))
  const texts = new Map<string, string>()
  let defaultText: string | null = null
  let pendingPath: string | undefined
  let offset = 0
  let count = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    if (++count > 4096) throw new L4PluginRegistryError('插件说明压缩包文件数量超过限制')
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0
    )
    if (checksum !== tarNumber(header, 148, 8))
      throw new L4PluginRegistryError('插件说明压缩包校验失败')
    const size = tarNumber(header, 124, 12)
    const start = offset + 512
    if (start + size > tar.length) throw new L4PluginRegistryError('插件说明压缩包内容不完整')
    const body = tar.subarray(start, start + size)
    const type = header[156]
    const prefix = tarString(header, 345, 155)
    const name = tarString(header, 0, 100)
    const path = pendingPath ?? `${prefix ? `${prefix}/` : ''}${name}`
    pendingPath = undefined
    if (type === 120 || type === 76) {
      if (size > 16 * 1024) throw new L4PluginRegistryError('插件说明压缩包路径超过限制')
      pendingPath = type === 120 ? paxPath(body) : body.toString('utf8').split('\0')[0]
    } else if (type === 0 || type === 48) {
      const safe = safePath(path)
      const local = safe?.startsWith('package/') ? safe.slice(8) : null
      if (local && size <= TEXT_LIMIT) {
        if (local.toLowerCase() === 'readme.md') defaultText = body.toString('utf8')
        if (wanted.has(local)) texts.set(local, body.toString('utf8'))
      }
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  const translations: Record<string, string> = {}
  for (const [locale, path] of paths) {
    const text = texts.get(safePath(path) ?? '')
    if (text !== undefined) translations[locale] = text
  }
  return localized(defaultText, translations)
}

function verifyArchive(bytes: Buffer, dist: Record<string, unknown>): void {
  if (typeof dist.integrity === 'string') {
    const hashes = dist.integrity.split(/\s+/).flatMap((value) => {
      const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)(?:\?.*)?$/.exec(value)
      return match ? [{ algorithm: match[1]!, value: match[2]! }] : []
    })
    const strongest = ['sha512', 'sha384', 'sha256', 'sha1'].find((algorithm) =>
      hashes.some((hash) => hash.algorithm === algorithm)
    )
    if (
      !strongest ||
      !hashes.some(
        (hash) =>
          hash.algorithm === strongest &&
          createHash(strongest).update(bytes).digest('base64') === hash.value
      )
    )
      throw new L4PluginRegistryError('插件说明压缩包完整性校验失败')
  } else if (
    typeof dist.shasum === 'string' &&
    createHash('sha1').update(bytes).digest('hex') !== dist.shasum
  ) {
    throw new L4PluginRegistryError('插件说明压缩包完整性校验失败')
  }
}

export async function readRegistryTarballReadme(
  manifest: Record<string, unknown>,
  signal?: AbortSignal
): Promise<L4LocalizedText | null> {
  const dist = registryObject(manifest.dist)
  if (typeof dist.tarball !== 'string')
    return typeof manifest.readme === 'string' && Buffer.byteLength(manifest.readme) <= TEXT_LIMIT
      ? manifest.readme
      : null
  const url = new URL(dist.tarball)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new L4PluginRegistryError('插件说明压缩包地址无效')
  const bytes = await fetchRegistryBytes(url, { limit: 8 * 1024 * 1024, signal, cache: false })
  verifyArchive(bytes, dist)
  const tar = await unzip(bytes, { maxOutputLength: 32 * 1024 * 1024 })
  return tarReadmes(tar, manifest)
}
