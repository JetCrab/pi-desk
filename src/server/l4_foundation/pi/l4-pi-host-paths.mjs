import { statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMatchPath, loadConfig } from 'tsconfig-paths'
import packageRootApi from '../process/l4-package-root.js'

const config = loadConfig(join(packageRootApi.packageRoot, 'tsconfig.json'))
if (config.resultType === 'failed') throw new Error(config.message)
const matchPath = createMatchPath(config.absoluteBaseUrl, config.paths, undefined, false)
const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']

export function resolveHostImport(specifier) {
  let filename
  // tsconfig-paths 的返回值会移除扩展名；保留实际命中的文件供原生 ESM 加载。
  matchPath(
    specifier,
    undefined,
    (candidate) => {
      if (!statSync(candidate, { throwIfNoEntry: false })?.isFile()) return false
      filename = candidate
      return true
    },
    extensions
  )
  return filename
}

export function resolve(specifier, context, nextResolve) {
  const filename = resolveHostImport(specifier)
  return nextResolve(filename ? pathToFileURL(filename).href : specifier, context)
}
