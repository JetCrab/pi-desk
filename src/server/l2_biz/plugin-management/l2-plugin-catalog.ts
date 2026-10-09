import 'server-only'

import type {
  L2PluginCatalogDetail,
  L2PluginCatalogGetRequest,
  L2PluginCatalogItem,
  L2PluginCatalogSearchRequest,
  L2PluginCatalogSearchResult,
  L2PluginCatalogSettings,
  L2PluginDownloadSource
} from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import { readL4PluginDescription } from '@common/l4_foundation/plugin/l4-plugin-package'
import {
  getL4PluginCatalogDetail,
  getL4PluginCatalogPackage,
  getL4PluginRecommendedRegistry,
  L4_PLUGIN_OFFICIAL_NAMES,
  L4PluginRegistryError,
  searchL4PluginCatalog,
  resolveL4PluginInstall,
  type L4RegistryPackage
} from '@server/l4_foundation/pi/l4-pi-plugin-registry'
import {
  L4_PLUGIN_DOMESTIC_REGISTRY,
  L4_PLUGIN_OFFICIAL_REGISTRY,
  readL4PiPluginPreferences,
  setL4PiPluginDownloadSource
} from '@server/l4_foundation/pi/l4-pi-plugin-preferences'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function packageKind(manifest: Record<string, unknown>): L2PluginCatalogItem['kind'] {
  const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : []
  const sdk = [
    manifest.dependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies
  ].some((value) => typeof object(value)['@jetcrab/pi-desk-sdk'] === 'string')
  if (
    keywords.includes('pi-desk-plugin') ||
    typeof (object(manifest.piDesk).entry ?? object(manifest.piDesk).global) === 'string' ||
    sdk
  )
    return 'desk'
  if (keywords.includes('pi-package') || Object.keys(object(manifest.pi)).length) return 'pi'
  return 'unknown'
}

function itemFromPackage(item: L4RegistryPackage): L2PluginCatalogItem {
  const manifest = item.manifest
  const translations = object(object(manifest.piDesk).i18n)
  const translatedDefault = Object.values(translations)
    .map((value) => text(object(value).description))
    .find(Boolean)
  const description = readL4PluginDescription(
    manifest.description ? manifest : { ...manifest, description: translatedDefault }
  )
  const publisher =
    text(object(manifest._npmUser).name) ??
    text(object(manifest.publisher).username) ??
    text(object(manifest.author).name) ??
    text(manifest.author)
  return {
    name: manifest.name as string,
    version: manifest.version as string,
    description,
    publisher,
    kind: packageKind(manifest),
    official:
      [L4_PLUGIN_OFFICIAL_REGISTRY, L4_PLUGIN_DOMESTIC_REGISTRY].includes(item.registry) &&
      L4_PLUGIN_OFFICIAL_NAMES.some((name) => name === manifest.name),
    registry: item.registry
  }
}

function matches(item: L2PluginCatalogItem, query: string): boolean {
  const description =
    typeof item.description === 'string'
      ? item.description
      : item.description
        ? [item.description.default, ...Object.values(item.description.translations)].join(' ')
        : ''
  const searchable = `${item.name} ${description}`.toLocaleLowerCase()
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => searchable.includes(word))
}

async function optionalPackage(name: string, registry: string): Promise<L4RegistryPackage | null> {
  try {
    return await getL4PluginCatalogPackage(name, registry)
  } catch (error) {
    if (error instanceof L4PluginRegistryError && error.reason === 'missing') return null
    throw error
  }
}

function compatibility(
  manifest: Record<string, unknown>
): Pick<L2PluginCatalogDetail, 'compatible' | 'compatibilityNote'> {
  const entry = object(manifest.piDesk).entry ?? object(manifest.piDesk).global
  const resources = object(manifest.pi)
  const known = ['extensions', 'skills', 'prompts', 'themes'].some(
    (key) =>
      Array.isArray(resources[key]) &&
      (resources[key] as unknown[]).some((path) => typeof path === 'string' && path.length > 0)
  )
  if (entry !== undefined && (typeof entry !== 'string' || !entry))
    return { compatible: false, compatibilityNote: '插件未声明有效的 Pi Desk 入口' }
  if ((typeof entry === 'string' && entry.length > 0) || known || packageKind(manifest) === 'desk')
    return {
      compatible: null,
      compatibilityNote: '将在安装前检查插件资源、依赖版本和运行环境要求'
    }
  return { compatible: null, compatibilityNote: '尚未确认此包包含可用的 Pi 或 Pi Desk 资源' }
}

export class L2PluginCatalog {
  async search(request: L2PluginCatalogSearchRequest): Promise<L2PluginCatalogSearchResult> {
    const registry = new URL(request.registry ?? L4_PLUGIN_OFFICIAL_REGISTRY).href.replace(
      /\/+$/,
      ''
    )
    const exactName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/i.test(request.query)
      ? request.query
      : null
    if (exactName) {
      const direct = await optionalPackage(exactName, registry)
      if (direct && (exactName.startsWith('@') || packageKind(direct.manifest) !== 'unknown')) {
        const item = itemFromPackage(direct)
        return {
          items:
            request.page === 1 && (request.kind === 'all' || item.kind === request.kind)
              ? [item]
              : [],
          hasMore: false
        }
      }
      if (exactName.startsWith('@')) return { items: [], hasMore: false }
    }
    const curated =
      request.page === 1 &&
      [L4_PLUGIN_OFFICIAL_REGISTRY, L4_PLUGIN_DOMESTIC_REGISTRY].includes(registry)
        ? (
            await Promise.all(
              L4_PLUGIN_OFFICIAL_NAMES.map((name) => optionalPackage(name, registry))
            )
          )
            .flatMap((item) => (item ? [itemFromPackage(item)] : []))
            .filter((item) => matches(item, request.query))
        : []
    const result = await searchL4PluginCatalog(
      request.query,
      registry,
      undefined,
      request.page,
      request.kind
    )
    const merged = new Map<string, L2PluginCatalogItem>()
    for (const item of [...curated, ...result.packages.map(itemFromPackage)]) {
      if (!merged.has(item.name)) merged.set(item.name, item)
    }
    const kindOrder = { desk: 0, pi: 1, unknown: 2 }
    const items = [...merged.values()]
      .filter((item) => request.kind === 'all' || item.kind === request.kind)
      .sort(
        (left, right) =>
          Number(right.official) - Number(left.official) ||
          kindOrder[left.kind] - kindOrder[right.kind]
      )
    return { items, hasMore: result.hasMore }
  }

  async get(request: L2PluginCatalogGetRequest): Promise<L2PluginCatalogDetail> {
    const resolved = request.registry
      ? null
      : await resolveL4PluginInstall(
          `npm:${request.name}${request.version ? `@${request.version}` : ''}`
        )
    const detail = await getL4PluginCatalogDetail(
      request.name,
      resolved ? resolved.source.slice(resolved.source.lastIndexOf('@') + 1) : request.version,
      request.registry ?? resolved?.registry
    )
    const manifest = detail.manifest
    return {
      ...itemFromPackage(detail),
      versions: detail.versions,
      readme: detail.readme,
      homepage:
        text(manifest.homepage) ??
        ([L4_PLUGIN_OFFICIAL_REGISTRY, L4_PLUGIN_DOMESTIC_REGISTRY].includes(detail.registry)
          ? `https://www.npmjs.com/package/${encodeURIComponent(request.name)}/v/${encodeURIComponent(manifest.version as string)}`
          : `${detail.registry}/${encodeURIComponent(request.name)}/${encodeURIComponent(manifest.version as string)}`),
      repository:
        (text(manifest.repository) ?? text(object(manifest.repository).url))?.replace(
          /^git\+/,
          ''
        ) ?? null,
      ...compatibility(manifest)
    }
  }

  async getSettings(): Promise<L2PluginCatalogSettings> {
    return {
      downloadSource: readL4PiPluginPreferences().downloadSource,
      recommendedRegistry: await getL4PluginRecommendedRegistry()
    }
  }

  replaceSettings(downloadSource: L2PluginDownloadSource): void {
    setL4PiPluginDownloadSource(downloadSource)
  }
}

const catalog = new L2PluginCatalog()

export function getL2PluginCatalog(): L2PluginCatalog {
  return catalog
}
