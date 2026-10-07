import 'server-only'

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { L4ErrorTranslation } from '@common/l4_foundation/locale/l4-error-translation'

export interface L4PiPackageRootConsistencyError {
  message: string
  englishMessage: string
  i18n: L4ErrorTranslation
}

export interface L4PiConfiguredPackageLocation {
  source: string
  installedPath?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function npmPackageName(source: string): string | null {
  if (!source.startsWith('npm:')) return null
  const spec = source.slice('npm:'.length).trim()
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)
  return match?.[1] ?? (spec || null)
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function readL4PiPackageRootConsistencyError(input: {
  agentDir: string
  configured: readonly L4PiConfiguredPackageLocation[]
}): Promise<L4PiPackageRootConsistencyError | null> {
  const npmPackages = input.configured.flatMap((item) => {
    const name = npmPackageName(item.source)
    return name ? [{ name, item }] : []
  })
  const packageJsonPath = join(input.agentDir, 'npm', 'package.json')
  let dependencies: Record<string, unknown> = {}

  try {
    const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies?: unknown
    }
    if (manifest.dependencies && typeof manifest.dependencies === 'object') {
      dependencies = manifest.dependencies as Record<string, unknown>
    }
  } catch (error) {
    if (npmPackages.length === 0) return null
    const detail = errorMessage(error)
    return {
      message: `Pi Package npm 根不可用：${detail}`,
      englishMessage: `Pi Package npm root is unavailable: ${detail}`,
      i18n: { key: 'errors:pluginNpmRootUnavailable', params: { detail: detail.slice(0, 1000) } }
    }
  }

  const expected = new Set(npmPackages.map((item) => item.name))
  const actual = new Set(Object.keys(dependencies))
  const missing = [...expected].filter((name) => !actual.has(name))
  const missingDirectories: string[] = []
  for (const { name, item } of npmPackages) {
    if (!item.installedPath || !(await directoryExists(item.installedPath))) {
      missingDirectories.push(name)
    }
  }

  if (missing.length === 0 && missingDirectories.length === 0) return null
  const details = [
    missing.length > 0 ? `缺少声明：${missing.join('、')}` : null,
    missingDirectories.length > 0 ? `缺少目录：${missingDirectories.join('、')}` : null
  ].filter((item): item is string => item !== null)
  const englishDetails = [
    missing.length > 0 ? `missing declarations: ${missing.join(', ')}` : null,
    missingDirectories.length > 0 ? `missing folders: ${missingDirectories.join(', ')}` : null
  ].filter((item): item is string => item !== null)
  const key =
    missing.length > 0
      ? missingDirectories.length > 0
        ? 'errors:pluginNpmRootMissingBoth'
        : 'errors:pluginNpmRootMissingDeclarations'
      : 'errors:pluginNpmRootMissingFolders'
  return {
    message: `Pi Package 配置与 npm 根不一致（${details.join('；')}）`,
    englishMessage: `Pi Package configuration does not match the npm root (${englishDetails.join('; ')})`,
    i18n: {
      key,
      params: {
        declarations: missing.join(', ').slice(0, 1000),
        folders: missingDirectories.join(', ').slice(0, 1000)
      }
    }
  }
}
