import { posix, win32 } from 'node:path'
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser'
import { parseDocument } from 'yaml'
import { L4EnvironmentValidationError } from './l4-environment-error'
import { isSecretReference } from '@jetcrab/pi-desk-sdk/secrets'
import {
  mapEnvironmentPath,
  type EnvironmentPathMapping,
  type EnvironmentPlatform
} from './l4-environment-paths'
import type { L4EnvironmentFile } from './l4-environment-manifest'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function visitPointer(
  value: unknown,
  parts: string[],
  visit: (parent: Record<string, unknown>, key: string) => void
): void {
  if (!record(value) || parts.length === 0) return
  const [part, ...rest] = parts
  const keys =
    part === '*'
      ? Array.isArray(value) && rest.length === 0
        ? Object.keys(value).reverse()
        : Object.keys(value)
      : [part!]
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue
    if (rest.length === 0) visit(value, key)
    else visitPointer(value[key], rest, visit)
  }
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/')) throw new Error('环境字段声明必须使用非根 JSON Pointer')
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

export function readL4EnvironmentStructured(content: Buffer, format: 'json' | 'yaml'): unknown {
  if (format === 'yaml') {
    const document = parseDocument(content.toString('utf8'), { uniqueKeys: true })
    if (document.errors.length > 0) throw new Error('环境 YAML 配置无法解析')
    return document.toJS() as unknown
  }
  const errors: ParseError[] = []
  const value: unknown = parse(content.toString('utf8'), errors, { allowTrailingComma: true })
  if (errors.length > 0) throw new Error('环境 JSON 配置无法解析')
  return value
}

/** 仅明确敏感字段解释完整 secret:// 引用；原生 Pi 凭据及普通字符串不参与。 */
export function collectL4EnvironmentSecretReferences(
  value: unknown,
  pointers: readonly string[]
): string[] {
  const references = new Set<string>()
  for (const pointer of pointers)
    visitPointer(value, pointerParts(pointer), (parent, key) => {
      if (isSecretReference(parent[key])) references.add(parent[key])
    })
  return [...references]
}

export function localPathsL4EnvironmentConfig(
  content: Buffer,
  file: Pick<L4EnvironmentFile, 'format' | 'localPaths'> & { path?: string },
  platform: EnvironmentPlatform
): string[] {
  if (file.format === 'binary') return []
  const value = readL4EnvironmentStructured(content, file.format)
  const paths = new Set<string>()
  const api = platform === 'win32' ? win32 : posix
  for (const pointer of file.localPaths)
    visitPointer(value, pointerParts(pointer), (parent, key) => {
      if (typeof parent[key] === 'string') {
        const local =
          file.path === 'settings.json' ? parent[key].replace(/^[!+-]/, '') : parent[key]
        if (!api.isAbsolute(local)) return
        const wildcard = local.search(/[*?\[\]{}]/)
        if (wildcard >= 0) {
          const head = local.slice(0, wildcard)
          paths.add(api.dirname(/[\\/]$/.test(head) ? `${head}entry` : head))
        } else paths.add(local)
      }
    })
  return [...paths]
}

export function transformL4EnvironmentConfig(input: {
  content: Buffer
  file: Pick<L4EnvironmentFile, 'format' | 'localPaths' | 'omitPaths'> & {
    secretPaths?: readonly string[]
    path?: string
  }
  mappings?: readonly EnvironmentPathMapping[]
  sourcePlatform?: EnvironmentPlatform
  targetPlatform?: EnvironmentPlatform
  references?: Readonly<Record<string, string>>
  requireSecretReferences?: boolean
}): Buffer {
  if (input.file.format === 'binary') return input.content
  const originalText = input.content.toString('utf8')
  const value = readL4EnvironmentStructured(input.content, input.file.format)
  const before: unknown = JSON.parse(JSON.stringify(value))
  for (const pointer of input.file.omitPaths) {
    visitPointer(value, pointerParts(pointer), (parent, key) => {
      if (Array.isArray(parent)) parent.splice(Number(key), 1)
      else delete parent[key]
    })
  }
  if (input.mappings) {
    for (const pointer of input.file.localPaths) {
      visitPointer(value, pointerParts(pointer), (parent, key) => {
        if (typeof parent[key] !== 'string') {
          if (parent[key] === null || input.file.path === 'settings.json') return
          throw new Error('声明的本地路径字段不是字符串')
        }
        const marker =
          input.file.path === 'settings.json' && /^[!+-]/.test(parent[key]) ? parent[key][0]! : ''
        const local = marker ? parent[key].slice(1) : parent[key]
        const api = input.sourcePlatform === 'win32' ? win32 : posix
        // 项目相对路径保留原字节及基准；不得转换分隔符或猜测远端参数。
        if (!api.isAbsolute(local)) return
        const wildcard = local.search(/[*?\[\]{}]/)
        let source = local
        let suffix = ''
        if (wildcard >= 0) {
          const head = source.slice(0, wildcard)
          const directory = api.dirname(/[\\/]$/.test(head) ? `${head}entry` : head)
          suffix = source.slice(directory.length).replace(/^[\\/]+/, '')
          source = directory
        }
        const mapped = mapEnvironmentPath(
          source,
          input.mappings!,
          input.sourcePlatform!,
          input.targetPlatform!
        )
        if (mapped === null) throw new Error('选中配置的本地路径缺少映射')
        parent[key] =
          marker +
          (suffix
            ? (input.targetPlatform === 'win32' ? win32 : posix).join(
                mapped,
                ...suffix.split(api.sep)
              )
            : mapped)
      })
    }
  }
  if (input.requireSecretReferences) {
    for (const pointer of input.file.secretPaths ?? [])
      visitPointer(value, pointerParts(pointer), (parent, key) => {
        const current = parent[key]
        if (current !== null && current !== '' && !isSecretReference(current))
          throw new L4EnvironmentValidationError(
            '声明敏感字段必须为凭据引用或允许空值，不自动转换明文，也未修改源配置'
          )
      })
  }
  if (input.references) {
    for (const pointer of input.file.secretPaths ?? [])
      visitPointer(value, pointerParts(pointer), (parent, key) => {
        const current = parent[key]
        if (!isSecretReference(current)) return
        const reference = input.references![current]
        if (!reference) throw new Error('选中配置的凭据引用缺少值')
        parent[key] = reference
      })
  }
  if (JSON.stringify(before) === JSON.stringify(value)) return input.content
  if (input.file.format === 'yaml') {
    const document = parseDocument(originalText)
    function patch(previous: unknown, next: unknown, path: string[]): void {
      if (JSON.stringify(previous) === JSON.stringify(next)) return
      if (record(previous) && record(next) && !Array.isArray(previous) && !Array.isArray(next)) {
        for (const key of Object.keys(previous))
          if (!Object.hasOwn(next, key)) document.deleteIn([...path, key])
        for (const [key, child] of Object.entries(next)) patch(previous[key], child, [...path, key])
      } else document.setIn(path, next)
    }
    patch(before, value, [])
    return Buffer.from(document.toString())
  }
  let text = originalText
  function patch(previous: unknown, next: unknown, path: (string | number)[]): void {
    if (JSON.stringify(previous) === JSON.stringify(next)) return
    if (record(previous) && record(next) && !Array.isArray(previous) && !Array.isArray(next)) {
      for (const key of Object.keys(previous))
        if (!Object.hasOwn(next, key))
          text = applyEdits(text, modify(text, [...path, key], undefined, {}))
      for (const [key, child] of Object.entries(next)) patch(previous[key], child, [...path, key])
    } else text = applyEdits(text, modify(text, path, next, {}))
  }
  patch(before, value, [])
  return Buffer.from(text)
}
