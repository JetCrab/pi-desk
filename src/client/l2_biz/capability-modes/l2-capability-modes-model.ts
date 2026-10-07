import type { CapabilityOption, CapabilityRule } from '@jetcrab/pi-desk-sdk/capabilities'
import type {
  L3CapabilityCatalog,
  L3CapabilityMode,
  L3CapabilityModes
} from '@common/l3_modules/capability-modes/l3-capability-modes-contract'

export type L2CapabilityTarget =
  { kind: 'tools' | 'skills' } | { kind: 'plugin'; pluginName: string; group: string }

export interface L2CapabilityGroup {
  key: string
  label: string
  options: CapabilityOption[]
  target: L2CapabilityTarget
}

export function l2CapabilityGroups(
  catalog: L3CapabilityCatalog | null,
  mode: L3CapabilityMode,
  toolsLabel: string
): L2CapabilityGroup[] {
  const groups: L2CapabilityGroup[] = [
    { key: 'tools', label: toolsLabel, options: catalog?.tools ?? [], target: { kind: 'tools' } },
    { key: 'skills', label: 'Skills', options: catalog?.skills ?? [], target: { kind: 'skills' } }
  ]
  const plugins = new Set([
    ...Object.keys(catalog?.plugins ?? {}),
    ...Object.keys(mode.plugins ?? {})
  ])
  for (const pluginName of plugins) {
    const declarations = catalog?.plugins[pluginName] ?? {}
    const keys = new Set([
      ...Object.keys(declarations),
      ...Object.keys(mode.plugins?.[pluginName] ?? {})
    ])
    for (const group of keys) {
      groups.push({
        key: `plugin:${pluginName}:${group}`,
        label: declarations[group]?.label ?? `${pluginName} / ${group}`,
        options: declarations[group]?.options ?? [],
        target: { kind: 'plugin', pluginName, group }
      })
    }
  }
  return groups
}

export function l2CapabilityRule(
  mode: L3CapabilityMode,
  target: L2CapabilityTarget
): CapabilityRule {
  return target.kind === 'plugin'
    ? (mode.plugins?.[target.pluginName]?.[target.group] ?? {})
    : (mode[target.kind] ?? {})
}

export function l2ReplaceCapabilityRule(
  mode: L3CapabilityMode,
  target: L2CapabilityTarget,
  value: CapabilityRule
): L3CapabilityMode {
  const rule: CapabilityRule = {
    ...(value.allow === undefined ? {} : { allow: [...new Set(value.allow)] }),
    ...(value.deny?.length ? { deny: [...new Set(value.deny)] } : {})
  }
  const empty = Object.keys(rule).length === 0
  if (target.kind !== 'plugin') {
    const next = { ...mode }
    if (empty) delete next[target.kind]
    else next[target.kind] = rule
    return next
  }
  const groups = { ...mode.plugins?.[target.pluginName] }
  if (empty) delete groups[target.group]
  else groups[target.group] = rule
  const plugins = { ...mode.plugins }
  if (Object.keys(groups).length) plugins[target.pluginName] = groups
  else delete plugins[target.pluginName]
  const next = { ...mode }
  if (Object.keys(plugins).length) next.plugins = plugins
  else delete next.plugins
  return next
}

export function l2NewCapabilityModeName(modes: L3CapabilityModes, base: string): string {
  const names = new Set(Object.values(modes).map((mode) => mode.name))
  if (!names.has(base)) return base
  let suffix = 2
  while (names.has(`${base} ${suffix}`)) suffix += 1
  return `${base} ${suffix}`
}
