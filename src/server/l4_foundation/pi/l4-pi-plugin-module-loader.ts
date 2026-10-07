import 'server-only'

import { createJiti, type TransformOptions, type TransformResult } from 'jiti'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

type L4PiDeskPluginModule = {
  default?: unknown
}

type L4PiNativeModule = Record<string, unknown>
type L4PiPluginModuleLoader = ReturnType<typeof createJiti>

// 托管入口将 cwd 固定为当前安装根；import.meta.url 经打包会指向构建机源码。
const moduleBase = join(process.cwd(), 'package.json')
const { createRequire } = process.getBuiltinModule('module')
// 由Jiti自身的原生import入口解析import-only核心包，不能在VM中用Function拼接import。
const nativeImports = createJiti(
  join(process.env.PI_DESK_PI_PACKAGE_DIR ?? process.cwd(), 'package.json')
)
const importNativePiModule = (specifier: string): Promise<L4PiNativeModule> =>
  nativeImports.import<L4PiNativeModule>(specifier)

let pluginModuleLoaderPromise: Promise<L4PiPluginModuleLoader> | undefined

interface CachedPluginCode {
  source: string
  transforms: Map<boolean, TransformResult>
  bytes: number
}

const MAX_CODE_CACHE_BYTES = 32 * 1024 * 1024
const MAX_CODE_CACHE_FILES = 512
const codeCache = new Map<string, CachedPluginCode>()
let codeCacheBytes = 0

function cachedCode(filename: string): CachedPluginCode | undefined {
  const cached = codeCache.get(filename)
  if (cached) {
    codeCache.delete(filename)
    codeCache.set(filename, cached)
  }
  return cached
}

function storeCode(filename: string, code: CachedPluginCode): void {
  const previous = codeCache.get(filename)
  if (previous) {
    codeCache.delete(filename)
    codeCacheBytes -= previous.bytes
  }
  if (code.bytes > MAX_CODE_CACHE_BYTES) return
  while (
    codeCache.size >= MAX_CODE_CACHE_FILES ||
    codeCacheBytes + code.bytes > MAX_CODE_CACHE_BYTES
  ) {
    const oldest = codeCache.entries().next().value!
    codeCache.delete(oldest[0])
    codeCacheBytes -= oldest[1].bytes
  }
  codeCache.set(filename, code)
  codeCacheBytes += code.bytes
}

function readPluginSource(filename: string): string {
  const source = readFileSync(filename, 'utf8')
  if (cachedCode(filename)?.source !== source) {
    storeCode(filename, { source, transforms: new Map(), bytes: Buffer.byteLength(source) })
  }
  return source
}

function transformPluginCode(
  options: TransformOptions,
  transform: NonNullable<L4PiPluginModuleLoader['options']['transform']>
): TransformResult {
  if (!options.filename) return transform(options)
  const filename = resolve(options.filename)
  const previous = cachedCode(filename)
  // 相对依赖由 Jiti 读取；入口与依赖都只能复用相同源码的转译结果。
  const cached = previous?.source === options.source ? previous : undefined
  const async = options.async === true
  const result = cached?.transforms.get(async)
  if (result) return result
  const source = options.source
  const transformed = transform(options)
  if (!transformed.error && !transformed.code.includes('__JITI_ERROR__')) {
    storeCode(filename, {
      source,
      transforms: new Map(cached?.transforms).set(async, transformed),
      bytes: (cached?.bytes ?? Buffer.byteLength(source)) + Buffer.byteLength(transformed.code)
    })
  }
  return transformed
}

/** 只释放代码结果；已运行会话的模块对象和工厂闭包不受影响。 */
export function clearL4PiPluginCodeCache(): void {
  if (codeCache.size > 0) {
    console.info('[Pi Desk][PluginResources] 已清除插件代码缓存', {
      fileCount: codeCache.size,
      bytes: codeCacheBytes
    })
  }
  codeCache.clear()
  codeCacheBytes = 0
}

async function createPluginModuleLoader(): Promise<L4PiPluginModuleLoader> {
  const [
    piCodingAgent,
    piAgentCore,
    piTui,
    piAiCompat,
    piAiOauth,
    piAiProviders,
    typebox,
    typeboxCompile,
    typeboxValue
  ] = await Promise.all([
    importNativePiModule('@earendil-works/pi-coding-agent'),
    importNativePiModule('@earendil-works/pi-agent-core'),
    importNativePiModule('@earendil-works/pi-tui'),
    importNativePiModule('@earendil-works/pi-ai/compat'),
    importNativePiModule('@earendil-works/pi-ai/oauth'),
    importNativePiModule('@earendil-works/pi-ai/providers/all'),
    importNativePiModule('typebox'),
    importNativePiModule('typebox/compile'),
    importNativePiModule('typebox/value')
  ])

  const loader = createJiti(moduleBase, {
    moduleCache: false,
    fsCache: false,
    tryNative: false,
    virtualModules: {
      '@earendil-works/pi-coding-agent': piCodingAgent,
      '@earendil-works/pi-agent-core': piAgentCore,
      '@earendil-works/pi-tui': piTui,
      '@earendil-works/pi-ai/providers/all': piAiProviders,
      '@earendil-works/pi-ai/compat': piAiCompat,
      '@earendil-works/pi-ai/oauth': piAiOauth,
      '@earendil-works/pi-ai': piAiCompat,
      '@mariozechner/pi-coding-agent': piCodingAgent,
      '@mariozechner/pi-agent-core': piAgentCore,
      '@mariozechner/pi-tui': piTui,
      '@mariozechner/pi-ai/providers/all': piAiProviders,
      '@mariozechner/pi-ai/compat': piAiCompat,
      '@mariozechner/pi-ai/oauth': piAiOauth,
      '@mariozechner/pi-ai': piAiCompat,
      typebox,
      'typebox/compile': typeboxCompile,
      'typebox/value': typeboxValue,
      '@sinclair/typebox': typebox,
      '@sinclair/typebox/compile': typeboxCompile,
      '@sinclair/typebox/value': typeboxValue
    }
  })
  const transform = loader.options.transform!
  // 同一转译结果可重复执行；不能缓存带模块顶层状态的 exports。
  loader.options.transform = (options) => transformPluginCode(options, transform)
  return loader
}

function pluginModuleLoader(): Promise<L4PiPluginModuleLoader> {
  pluginModuleLoaderPromise ??= createPluginModuleLoader()
  return pluginModuleLoaderPromise
}

export async function loadL4PiDeskPluginEntry(
  entryPath: string,
  packageRoot = dirname(entryPath)
): Promise<L4PiDeskPluginModule> {
  const loader = await pluginModuleLoader()
  // Jiti 对无ESM语法的.cjs仍走原生require；仅撤销目标来源自有代码，不冲刷共享依赖。
  const cache = createRequire(moduleBase).cache
  const root = resolve(packageRoot)
  for (const path of Object.keys(cache)) {
    const local = relative(root, path)
    if (
      !local.startsWith('..') &&
      !isAbsolute(local) &&
      !local.split(/[\\/]/).includes('node_modules')
    ) {
      delete cache[path]
    }
  }
  // 同步执行让.mjs及其相对依赖绕过原生ESM缓存；每次加载仍创建独立模块。
  try {
    const filename = resolve(entryPath)
    const loaded = loader.evalModule(readPluginSource(filename), {
      filename,
      async: false
    }) as L4PiDeskPluginModule | undefined
    return { default: loaded?.default ?? loaded }
  } catch (error) {
    clearL4PiPluginCodeCache()
    if (
      error instanceof Error &&
      /await is only valid|top.level await|ERR_REQUIRE_ASYNC_MODULE/i.test(error.message)
    ) {
      throw new Error('Pi Desk Node Entry 不支持模块顶层 await，请将异步初始化放入 async setup()', {
        cause: error
      })
    }
    throw error
  }
}
