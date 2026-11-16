import 'server-only'

import enhancedResolve from 'enhanced-resolve'
import * as fs from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute } from 'node:path'

export const L4_PI_PLUGIN_RESOLVER = 'pi-desk:plugin-module-resolver'

export function createL4PiPluginModuleResolver(virtualModules: Record<string, unknown>): {
  resolve: (request: string, filename: string) => string
  wrapRequire: (original: NodeJS.Require, filename: string) => NodeJS.Require
} {
  // 不使用 CachedInputFileSystem：npm 原地替换 package.json 后必须立即读取新 exports。
  const resolvers = ['require', 'import'].map((condition) =>
    enhancedResolve.ResolverFactory.createResolver({
      fileSystem: fs,
      useSyncFileSystemCalls: true,
      conditionNames: ['node', condition],
      extensions: ['.js', '.json', '.node', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],
      mainFields: ['main'],
      exportsFields: ['exports'],
      importsFields: ['imports']
    })
  )

  function resolve(request: string, filename: string): string {
    if (
      isBuiltin(request) ||
      request in virtualModules ||
      request.startsWith('.') ||
      isAbsolute(request) ||
      request.includes(':')
    ) {
      return request
    }
    let failure: unknown
    for (const resolver of resolvers) {
      try {
        const path = resolver.resolveSync({}, dirname(filename), request)
        if (path) return path
      } catch (error) {
        failure = error
      }
    }
    // 明确拒绝未导出/不存在的子入口，不退回会读取旧清单的 Node/Jiti resolver。
    throw failure ?? new Error(`插件依赖入口不存在：${request}`)
  }

  function wrapRequire(original: NodeJS.Require, filename: string): NodeJS.Require {
    const wrapped = Object.assign(
      (request: string): unknown => original(resolve(request, filename)),
      original
    )
    wrapped.resolve = Object.assign(
      (request: string, options?: { paths?: string[] }): string =>
        original.resolve(resolve(request, filename), options),
      original.resolve
    )
    return wrapped
  }

  return { resolve, wrapRequire }
}
