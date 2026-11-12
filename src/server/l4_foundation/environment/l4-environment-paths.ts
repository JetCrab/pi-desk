import { posix, win32 } from 'node:path'

export type EnvironmentPlatform = 'win32' | 'posix'
export type EnvironmentTargetSemantics = EnvironmentPlatform | 'darwin'

export function currentEnvironmentTargetSemantics(
  platform: EnvironmentPlatform
): EnvironmentTargetSemantics {
  return platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'posix'
}

/** 仅生成比较键，不改写路径；darwin保守拒绝大小写或规范等价名称。 */
export function environmentTargetNameKey(
  value: string,
  semantics: EnvironmentTargetSemantics
): string {
  if (semantics === 'darwin')
    return value.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD')
  return semantics === 'win32' ? value.toLowerCase() : value
}

export function environmentTargetPathKey(
  path: string,
  platform: EnvironmentPlatform,
  semantics = currentEnvironmentTargetSemantics(platform)
): string {
  return environmentTargetNameKey(normalizeEnvironmentPath(path, platform), semantics)
}
export interface EnvironmentPathMapping {
  source: string
  target: string
}

function pathApi(platform: EnvironmentPlatform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** 不使用宿主 resolve；源路径必须有自己的绝对根目录，拒绝 Windows 盘符相对路径。 */
export function normalizeEnvironmentPath(path: string, platform: EnvironmentPlatform): string {
  const api = pathApi(platform)
  if (
    path.includes('\0') ||
    !api.isAbsolute(path) ||
    (platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(path)) ||
    (platform === 'win32' && /^[\\/]{2}[?.][\\/]/.test(path))
  ) {
    throw new Error('环境路径必须是源平台的普通绝对路径')
  }
  const normalized = api.normalize(path)
  const root = api.parse(normalized).root
  return normalized.length > root.length && normalized.endsWith(api.sep)
    ? normalized.slice(0, -1)
    : normalized
}

export function environmentPathKey(path: string, platform: EnvironmentPlatform): string {
  const normalized = normalizeEnvironmentPath(path, platform)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 最长目录前缀映射；相对路径保持相对原基准，不在另一平台上解析。未匹配返回 null。 */
export function mapEnvironmentPath(
  path: string,
  mappings: readonly EnvironmentPathMapping[],
  sourcePlatform: EnvironmentPlatform,
  targetPlatform: EnvironmentPlatform
): string | null {
  const sourceApi = pathApi(sourcePlatform)
  if (!sourceApi.isAbsolute(path)) {
    if (sourcePlatform === 'win32' && /^(?:[a-z]:|[\\/])/i.test(path)) {
      throw new Error('不支持隐式盘符或根目录的 Windows 路径')
    }
    const parts = sourceApi.normalize(path).split(sourceApi.sep)
    for (const part of parts) {
      if (part !== '.' && part !== '..') assertTargetName(part, targetPlatform)
    }
    return pathApi(targetPlatform).join(...parts)
  }
  const normalized = normalizeEnvironmentPath(path, sourcePlatform)
  const key = environmentPathKey(normalized, sourcePlatform)
  const sorted = mappings
    .map((mapping) => ({
      ...mapping,
      key: environmentPathKey(mapping.source, sourcePlatform)
    }))
    .sort((left, right) => right.key.length - left.key.length)
  for (const mapping of sorted) {
    const prefix = mapping.key.endsWith(sourceApi.sep) ? mapping.key : mapping.key + sourceApi.sep
    if (key !== mapping.key && !key.startsWith(prefix)) continue
    const suffix = normalized.slice(mapping.key.length).split(sourceApi.sep).filter(Boolean)
    for (const part of suffix) assertTargetName(part, targetPlatform)
    const target = pathApi(targetPlatform).join(
      normalizeEnvironmentPath(mapping.target, targetPlatform),
      ...suffix
    )
    if (targetPlatform === 'win32') {
      const root = win32.parse(target).root
      for (const part of target.slice(root.length).split('\\').filter(Boolean)) {
        assertTargetName(part, targetPlatform)
      }
    }
    return target
  }
  return null
}

/** 归档名称使用唯一 POSIX 相对表示，禁止归一化后再接受穿越或别名。 */
export function assertEnvironmentEntryPath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('归档包含不安全的相对路径')
  }
}

function assertTargetName(name: string, platform: EnvironmentPlatform): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[\x00/]/.test(name) ||
    (platform === 'win32' &&
      (/[<>:"\\|?*\x00-\x1f]/.test(name) ||
        /[. ]$/.test(name) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)))
  ) {
    throw new Error('路径包含目标平台不支持的文件名')
  }
}

/** 检查全部路径及隐式父目录，防止 A/x 与 a/y、文件与目录冲突。 */
export function assertEnvironmentTargetPaths(
  paths: Iterable<string>,
  platform: EnvironmentPlatform,
  semantics: EnvironmentTargetSemantics = platform
): void {
  const seen = new Map<string, { spelling: string; file: boolean }>()
  for (const path of paths) {
    assertEnvironmentEntryPath(path)
    const parts = path.split('/')
    for (let index = 0; index < parts.length; index += 1) {
      assertTargetName(parts[index]!, platform)
      const spelling = parts.slice(0, index + 1).join('/')
      const key = environmentTargetNameKey(spelling, semantics)
      const file = index === parts.length - 1
      const previous = seen.get(key)
      if (previous && (previous.spelling !== spelling || previous.file || file)) {
        throw new Error('目标路径存在重复、大小写、Unicode规范等价或文件目录冲突')
      }
      seen.set(key, { spelling, file })
    }
  }
}
