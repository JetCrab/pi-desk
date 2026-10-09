import Module, { register, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolveHostImport } from './l4-pi-host-paths.mjs'
import runtimeApi from './l4-pi-global-runtime.js'

const {
  PI_RUNTIME_EXIT_CODE,
  findGlobalPi,
  resolvePiImport,
  checkPiModules,
  formatPiRuntimeError
} = runtimeApi

try {
  // 别名在 tsx 后方解析，保留 tsx 按原始导入识别 CJS 命名导出的能力。
  register('./l4-pi-host-paths.mjs', import.meta.url)
  const runtime = await findGlobalPi()
  if (!runtime) throw new Error('未安装全局 Pi，Pi Desk 无法启动。')
  // tsx/Jiti 会先调用同步 require.resolve；Node hooks 不拦截这一步预解析。
  const resolveFilename = Module._resolveFilename
  Module._resolveFilename = function (specifier, ...args) {
    const target = resolvePiImport(runtime, specifier)
    if (target) return fileURLToPath(target)
    const filename = resolveFilename.call(this, resolveHostImport(specifier) ?? specifier, ...args)
    const redirected = resolvePiImport(runtime, filename)
    return redirected ? fileURLToPath(redirected) : filename
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = resolvePiImport(runtime, specifier)
      if (target) return { url: target, format: 'module', shortCircuit: true }
      const resolved = nextResolve(specifier, context)
      const redirected = resolvePiImport(runtime, resolved.url)
      return redirected
        ? { ...resolved, url: redirected, format: 'module', shortCircuit: true }
        : resolved
    }
  })
  // 运行目录只在内存环境中传给辅助进程；同一服务生命周期不能混用另一份 SDK。
  process.env.PI_DESK_PI_PACKAGE_DIR = runtime.root
  await checkPiModules(runtime)
  const sharedImports = [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-ai/compat',
    '@earendil-works/pi-ai/oauth',
    '@earendil-works/pi-ai/providers/all',
    '@earendil-works/pi-tui',
    'typebox',
    'typebox/compile',
    'typebox/value'
  ]
  const nativeModules = new Map(
    await Promise.all(
      sharedImports.map(async (name) => {
        const url = resolvePiImport(runtime, name)
        return [url, await import(url)]
      })
    )
  )
  // CJS 消费者直接复用原生命名空间，避免 tsx 再转译出独立的 SDK 状态。
  const loadModule = Module._load
  Module._load = function (specifier, ...args) {
    const native = nativeModules.get(resolvePiImport(runtime, specifier))
    return native ?? loadModule.call(this, specifier, ...args)
  }
  console.info('[Pi Desk][PiRuntime] 使用全局 Pi', { version: runtime.version, path: runtime.root })
} catch (error) {
  console.error(`[Pi Desk][PiRuntime] ${formatPiRuntimeError(error)}`)
  process.exit(PI_RUNTIME_EXIT_CODE)
}
