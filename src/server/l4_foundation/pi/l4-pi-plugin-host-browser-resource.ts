import 'server-only'

import { createReadStream, realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'

const HOST_RUNTIME_RELATIVE_PATH = join(
  'node_modules',
  '@jetcrab',
  'pi-desk-sdk',
  'dist',
  'host-runtime'
)
let resolvedHostRuntimeRoot: string | null = null

export interface L4PiPluginHostBrowserResource {
  stream: ReadableStream<Uint8Array>
  size: number
  etag: string
}

export class L4PiPluginHostBrowserResourceNotFoundError extends Error {
  constructor(resourcePath: string) {
    super(`Pi Desk Host Browser resource was not found: ${resourcePath}`)
    this.name = 'L4PiPluginHostBrowserResourceNotFoundError'
  }
}

export class L4PiPluginHostBrowserRuntimeUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `Pi Desk Host Browser Runtime is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`
    )
    this.name = 'L4PiPluginHostBrowserRuntimeUnavailableError'
  }
}

function canonicalResourcePath(resourcePath: string): readonly string[] | null {
  if (
    !resourcePath ||
    resourcePath.length > 4096 ||
    resourcePath.startsWith('/') ||
    resourcePath.includes('\\') ||
    resourcePath.includes('\0') ||
    !resourcePath.endsWith('.js')
  ) {
    return null
  }
  const segments = resourcePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments
}

function isInsideRoot(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function hostRuntimeRoot(): string {
  if (resolvedHostRuntimeRoot) return resolvedHostRuntimeRoot

  const entryPath = process.argv[1]?.trim()
  const startDirectories = [entryPath ? dirname(resolve(entryPath)) : null, process.cwd()].filter(
    (item): item is string => item !== null
  )
  const visited = new Set<string>()

  for (const startDirectory of startDirectories) {
    let current = startDirectory
    while (!visited.has(current)) {
      visited.add(current)
      try {
        resolvedHostRuntimeRoot = realpathSync(join(current, HOST_RUNTIME_RELATIVE_PATH))
        return resolvedHostRuntimeRoot
      } catch {
        const parent = dirname(current)
        if (parent === current) break
        current = parent
      }
    }
  }

  throw new L4PiPluginHostBrowserRuntimeUnavailableError(
    new Error('Cannot locate @jetcrab/pi-desk-sdk Host Runtime directory')
  )
}

export async function readL4PiPluginHostBrowserResource(
  resourcePath: string
): Promise<L4PiPluginHostBrowserResource> {
  const segments = canonicalResourcePath(resourcePath)
  if (!segments) throw new L4PiPluginHostBrowserResourceNotFoundError(resourcePath)

  const rootPath = hostRuntimeRoot()
  const requestedPath = resolve(rootPath, ...segments)
  if (!isInsideRoot(rootPath, requestedPath)) {
    throw new L4PiPluginHostBrowserResourceNotFoundError(resourcePath)
  }

  let realRoot: string
  let realTarget: string
  try {
    ;[realRoot, realTarget] = await Promise.all([realpath(rootPath), realpath(requestedPath)])
  } catch (error) {
    console.warn('[Pi Desk][PluginHostRuntime] 公共资源路径解析失败', {
      resourcePath,
      rootPath,
      requestedPath,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error)
    })
    throw new L4PiPluginHostBrowserResourceNotFoundError(resourcePath)
  }
  if (!isInsideRoot(realRoot, realTarget)) {
    throw new L4PiPluginHostBrowserResourceNotFoundError(resourcePath)
  }

  let metadata
  try {
    metadata = await stat(realTarget)
  } catch {
    throw new L4PiPluginHostBrowserResourceNotFoundError(resourcePath)
  }
  if (!metadata.isFile()) {
    throw new L4PiPluginHostBrowserResourceNotFoundError(resourcePath)
  }

  const etag = `W/"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}"`
  const stream = Readable.toWeb(createReadStream(realTarget)) as ReadableStream<Uint8Array>
  return { stream, size: metadata.size, etag }
}
