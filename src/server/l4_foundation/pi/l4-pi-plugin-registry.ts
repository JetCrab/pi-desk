import 'server-only'

import {
  L4PluginRegistrySchema,
  type L4PluginDownloadSource
} from '@common/l4_foundation/plugin/l4-plugin-package'
import type { L4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import {
  L4_PLUGIN_DOMESTIC_REGISTRY,
  L4_PLUGIN_OFFICIAL_REGISTRY,
  readL4PiPluginPreferences
} from './l4-pi-plugin-preferences'
import { readRegistryNpmConfig } from './l4-pi-plugin-registry-config'
import {
  fetchRegistryBytes,
  fetchRegistryJson,
  L4PluginRegistryError
} from './l4-pi-plugin-registry-network'
import { readRegistryTarballReadme, registryObject } from './l4-pi-plugin-registry-readme'

export { readL4PluginReadme } from './l4-pi-plugin-registry-readme'
export { L4PluginRegistryError } from './l4-pi-plugin-registry-network'

export const L4_PLUGIN_OFFICIAL_NAMES = [
  '@jetcrab/pi-desk-bg-run',
  '@jetcrab/pi-desk-subagent',
  '@jetcrab/pi-desk-deliverables',
  '@jetcrab/pi-desk-usage',
  '@jetcrab/pi-desk-ctx',
  '@jetcrab/pi-desk-quota-viewer',
  '@jetcrab/pi-desk-tibo-monitor',
  '@jetcrab/pi-desk-tool-reason',
  '@jetcrab/pi-desk-remote-debug'
] as const

export interface L4RegistryPackage {
  manifest: Record<string, unknown>
  registry: string
}
export interface L4RegistryDetail extends L4RegistryPackage {
  versions: string[]
  readme: L4LocalizedText | null
}
export interface L4RegistrySearch {
  packages: L4RegistryPackage[]
  hasMore: boolean
}

let recommended: { expires: number; value: Promise<string> } | undefined

export function getL4PluginRecommendedRegistry(): Promise<string> {
  if (!recommended || recommended.expires <= Date.now()) {
    const value: Promise<string> = (async (): Promise<string> => {
      try {
        const response = await fetchRegistryBytes(
          new URL('https://ipwho.is/?fields=success,country_code'),
          { limit: 1024, timeout: 3000, cache: false, auth: false }
        )
        const country = registryObject(JSON.parse(response.toString('utf8')))
        if (country.success !== true) throw new Error('出口地区检测失败')
        return country.country_code === 'CN'
          ? L4_PLUGIN_DOMESTIC_REGISTRY
          : L4_PLUGIN_OFFICIAL_REGISTRY
      } catch {
        if (recommended) recommended.expires = Date.now() + 60_000
        return L4_PLUGIN_OFFICIAL_REGISTRY
      }
    })()
    recommended = { expires: Date.now() + 30 * 60_000, value }
  }
  return recommended.value
}

function normalizeRegistry(registry: string): string {
  return new URL(L4PluginRegistrySchema.parse(registry)).href.replace(/\/+$/, '')
}

function packageUrl(registry: string, name: string, version?: string): URL {
  return new URL(
    `${normalizeRegistry(registry)}/${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ''}`
  )
}

function packageName(name: string): void {
  if (name.length > 214 || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/i.test(name))
    throw new L4PluginRegistryError('npm 插件包名无效', 400)
}

function chooseVersion(metadata: Record<string, unknown>, selector: string): string {
  const versions = registryObject(metadata.versions)
  const tags = registryObject(metadata['dist-tags'])
  const selected =
    typeof tags[selector] === 'string' ? tags[selector] : selector.replace(/^v(?=\d+\.)/, '')
  if (typeof selected !== 'string' || !Object.hasOwn(versions, selected))
    throw new L4PluginRegistryError('插件源不存在指定版本或标签', 404, 'missing')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(selected))
    throw new L4PluginRegistryError('插件源返回的版本无效')
  return selected
}

async function installRegistry(
  name: string,
  options: { downloadSource?: L4PluginDownloadSource; registry?: string; agentDir?: string }
): Promise<{ registry: string; fallback: boolean }> {
  if (options.registry) {
    const registry = normalizeRegistry(options.registry)
    if (![L4_PLUGIN_OFFICIAL_REGISTRY, L4_PLUGIN_DOMESTIC_REGISTRY].includes(registry))
      return { registry, fallback: false }
  }
  const preferences = readL4PiPluginPreferences(options.agentDir)
  const saved = preferences.registries[`npm:${name}`]
  if (saved) return { registry: normalizeRegistry(saved), fallback: false }
  if (name.startsWith('@')) {
    const config = await readRegistryNpmConfig()
    const scoped = config[`${name.split('/')[0]}:registry`]
    if (scoped) {
      const registry = normalizeRegistry(scoped)
      if (![L4_PLUGIN_OFFICIAL_REGISTRY, L4_PLUGIN_DOMESTIC_REGISTRY].includes(registry))
        return { registry, fallback: false }
    }
  }
  const source = options.downloadSource ?? preferences.downloadSource
  if (source.mode === 'custom')
    return { registry: normalizeRegistry(source.registry), fallback: false }
  if (source.mode === 'official') return { registry: L4_PLUGIN_OFFICIAL_REGISTRY, fallback: false }
  if (source.mode === 'domestic') return { registry: L4_PLUGIN_DOMESTIC_REGISTRY, fallback: false }
  return { registry: await getL4PluginRecommendedRegistry(), fallback: true }
}

export async function resolveL4PluginInstall(
  source: string,
  options: {
    downloadSource?: L4PluginDownloadSource
    registry?: string
    agentDir?: string
    signal?: AbortSignal
  } = {}
): Promise<{ source: string; registry?: string }> {
  if (!source.startsWith('npm:')) return { source }
  const match = /^npm:((?:@[^/]+\/)?[^@]+)(?:@([^@]+))?$/.exec(source)
  if (!match) throw new L4PluginRegistryError('npm 插件来源无效', 400)
  const name = match[1]!
  packageName(name)
  const selector = match[2] ?? 'latest'
  if (selector.length > 128 || !/^[a-zA-Z0-9._+-]+$/.test(selector))
    throw new L4PluginRegistryError('npm 插件版本或标签无效', 400)
  const selected = await installRegistry(name, options)
  let registry = selected.registry
  let target = selector
  let version: string
  try {
    const metadata = await fetchRegistryJson(packageUrl(registry, name), options.signal)
    const taggedVersion = registryObject(metadata['dist-tags'])[selector]
    if (typeof taggedVersion === 'string') target = taggedVersion
    version = chooseVersion(metadata, target)
    validManifest(registryObject(metadata.versions)[version], name, version)
  } catch (error) {
    if (
      !selected.fallback ||
      registry === L4_PLUGIN_OFFICIAL_REGISTRY ||
      !(error instanceof L4PluginRegistryError) ||
      !['network', 'missing'].includes(error.reason)
    )
      throw error
    console.warn('[Pi Desk][PluginRegistry] 自动下载源不可用，回退 npm 官方源', {
      name,
      reason: error.reason
    })
    registry = L4_PLUGIN_OFFICIAL_REGISTRY
    const metadata = await fetchRegistryJson(packageUrl(registry, name), options.signal)
    version = chooseVersion(metadata, target)
    validManifest(registryObject(metadata.versions)[version], name, version)
  }
  return { source: `npm:${name}@${version}`, registry }
}

function validManifest(value: unknown, name: string, version?: string): Record<string, unknown> {
  const manifest = registryObject(value)
  if (
    manifest.name !== name ||
    typeof manifest.version !== 'string' ||
    (version && manifest.version !== version)
  )
    throw new L4PluginRegistryError('插件源返回的包名或版本不匹配')
  return manifest
}

async function readPackage(
  name: string,
  registry: string,
  version?: string,
  signal?: AbortSignal
): Promise<{ manifest: Record<string, unknown>; metadata: Record<string, unknown> }> {
  packageName(name)
  const metadata = await fetchRegistryJson(packageUrl(registry, name), signal)
  const selected = chooseVersion(metadata, version ?? 'latest')
  const manifest = validManifest(
    await fetchRegistryJson(packageUrl(registry, name, selected), signal),
    name,
    selected
  )
  return { manifest, metadata }
}

export async function getL4PluginCatalogPackage(
  name: string,
  registry = L4_PLUGIN_OFFICIAL_REGISTRY,
  signal?: AbortSignal
): Promise<L4RegistryPackage> {
  const normalized = normalizeRegistry(registry)
  packageName(name)
  const manifest = validManifest(
    await fetchRegistryJson(packageUrl(normalized, name, 'latest'), signal),
    name
  )
  return { manifest, registry: normalized }
}

export async function getL4PluginCatalogDetail(
  name: string,
  version?: string,
  registry = L4_PLUGIN_OFFICIAL_REGISTRY,
  signal?: AbortSignal
): Promise<L4RegistryDetail> {
  const normalized = normalizeRegistry(registry)
  const { manifest, metadata } = await readPackage(name, normalized, version, signal)
  let readme: L4LocalizedText | null = null
  try {
    readme = await readRegistryTarballReadme(manifest, signal)
    if (readme === null) {
      console.info('[Pi Desk][PluginRegistry] 指定版本未提供可读取的插件说明', {
        name,
        version: manifest.version
      })
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    console.warn('[Pi Desk][PluginRegistry] 插件说明读取失败', {
      name,
      version: manifest.version,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      reason: error instanceof L4PluginRegistryError ? error.reason : 'archive'
    })
  }
  const versions = Object.keys(registryObject(metadata.versions))
    .sort((a, b) => {
      const times = registryObject(metadata.time)
      const left = typeof times[a] === 'string' ? Date.parse(times[a] as string) : 0
      const right = typeof times[b] === 'string' ? Date.parse(times[b] as string) : 0
      return (
        (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0) ||
        b.localeCompare(a, 'en', { numeric: true })
      )
    })
    .slice(0, 100)
  if (!versions.includes(manifest.version as string))
    versions.splice(99, 1, manifest.version as string)
  return { manifest, registry: normalized, versions, readme }
}

export async function searchL4PluginCatalog(
  query: string,
  registry = L4_PLUGIN_OFFICIAL_REGISTRY,
  signal?: AbortSignal,
  page = 1,
  kind: 'all' | 'desk' | 'pi' = 'all'
): Promise<L4RegistrySearch> {
  const normalized = normalizeRegistry(registry)
  const keywords =
    kind === 'all'
      ? ['pi-desk-plugin', 'pi-package']
      : [kind === 'desk' ? 'pi-desk-plugin' : 'pi-package']
  const size = kind === 'all' ? 10 : 20
  const from = (page - 1) * size
  const packages = new Map<string, L4RegistryPackage>()
  let hasMore = false
  for (const keyword of keywords) {
    const url = new URL(`${normalized}/-/v1/search`)
    url.searchParams.set('text', `keywords:${keyword}${query ? ` ${query}` : ''}`)
    url.searchParams.set('size', String(size))
    url.searchParams.set('from', String(from))
    const result = await fetchRegistryJson(url, signal)
    if (!Array.isArray(result.objects) || typeof result.total !== 'number')
      throw new L4PluginRegistryError('插件源搜索响应格式无效')
    hasMore ||= from + result.objects.length < result.total
    for (const object of result.objects.slice(0, size)) {
      const candidate = registryObject(registryObject(object).package)
      if (typeof candidate.name !== 'string' || typeof candidate.version !== 'string') continue
      // 搜索索引的关键词匹配只用于候选分类，不代表兼容性确认。
      const manifest = {
        ...candidate,
        keywords: [...(Array.isArray(candidate.keywords) ? candidate.keywords : []), keyword]
      }
      if (!packages.has(candidate.name))
        packages.set(candidate.name, { manifest, registry: normalized })
    }
  }
  return { packages: [...packages.values()], hasMore }
}
