import type { PluginJsonObject, PluginJsonValue } from './shared.js'

export interface ConfigValueLocation {
  parent: PluginJsonObject | PluginJsonValue[]
  key: string
  parts: string[]
}

export function configValueLocations(
  conf: PluginJsonObject,
  paths: readonly string[]
): ConfigValueLocation[] {
  const found = new Map<string, ConfigValueLocation>()
  for (const path of paths) {
    if (typeof path !== 'string' || !path.startsWith('/') || /~(?![01])/u.test(path)) {
      throw new Error('配置路径必须是非根 JSON Pointer，可用 * 匹配当前层所有成员')
    }
    const parts = path
      .slice(1)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    function visit(value: PluginJsonValue, index: number, prefix: string[]): void {
      if (value === null || typeof value !== 'object') return
      const part = parts[index]!
      for (const key of part === '*' ? Object.keys(value) : [part]) {
        if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue
        const location = [...prefix, key]
        if (index === parts.length - 1) {
          found.set(JSON.stringify(location), { parent: value, key, parts: location })
        } else {
          const child = Array.isArray(value) ? value[Number(key)]! : value[key]!
          visit(child, index + 1, location)
        }
      }
    }
    visit(conf, 0, [])
  }
  const locations = [...found.values()]
  for (const current of locations) {
    for (let length = 1; length < current.parts.length; length += 1) {
      if (found.has(JSON.stringify(current.parts.slice(0, length)))) {
        throw new Error('配置加解密路径不能同时包含父节点和子节点')
      }
    }
  }
  return locations
}

export function getConfigLocation(location: ConfigValueLocation): PluginJsonValue {
  return Array.isArray(location.parent)
    ? location.parent[Number(location.key)]!
    : location.parent[location.key]!
}

export function setConfigLocation(location: ConfigValueLocation, value: PluginJsonValue): void {
  if (Array.isArray(location.parent)) location.parent[Number(location.key)] = value
  else location.parent[location.key] = value
}
