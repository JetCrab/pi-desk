import { posix } from 'node:path'

export const L4_ENVIRONMENT_INSTRUCTION_FILES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
  'SYSTEM.md',
  'APPEND_SYSTEM.md'
] as const
export const L4_ENVIRONMENT_NATIVE_FILES = [
  'settings.json',
  'models.json',
  'auth.json',
  'mcp.json',
  'mcp-auth.json',
  'keybindings.json',
  ...L4_ENVIRONMENT_INSTRUCTION_FILES
] as const
const machineFiles = new Set([
  'models-store.json',
  'trust.json',
  'auth-session-key',
  'credentials.enc',
  'desktop.json',
  'desktop.lock',
  'desktop-environment.pending.json',
  'desktop-environment.transaction.json'
])
const machineDirectories = new Set([
  'node_modules',
  '.git',
  'cache',
  '.cache',
  'runtime',
  '.runtime',
  'temp',
  'logs',
  'environment-operations',
  'registrations',
  'ports'
])

/** 相对归档/配置路径使用 POSIX 表示；源收集与目标应用共用同一保护规则。 */
export function isL4EnvironmentMachinePath(path: string): boolean {
  return path.split('/').some((part) => {
    const key = part.toLowerCase()
    return (
      machineDirectories.has(key) ||
      machineFiles.has(key) ||
      key.endsWith('.lock') ||
      key.endsWith('.tmp')
    )
  })
}

export function isL4EnvironmentSessionStoragePath(path: string): boolean {
  const key = path.toLowerCase()
  return key === 'pi-desk/work-sessions.json' || key === 'sessions' || key.startsWith('sessions/')
}

export function isL4EnvironmentRootConfiguration(path: string): boolean {
  return (
    !path.includes('/') &&
    !isL4EnvironmentMachinePath(path) &&
    L4_ENVIRONMENT_NATIVE_FILES.some((file) => file === path)
  )
}

export function l4EnvironmentConfigTitle(base: string, path: string, cwd: string | null): string {
  return base === 'project' ? `${cwd} / .pi/${path}` : base === 'resource' ? path : `全局 / ${path}`
}

export function l4EnvironmentSessionSuffix(path: string): string | null {
  const parts = path.replaceAll('\\', '/').split('/')
  const index = parts.indexOf('subagents', parts.lastIndexOf('sessions') + 1)
  if (index < 0) return null
  const suffix = parts.slice(index).join('/')
  return suffix.includes('../') || posix.isAbsolute(suffix) ? null : suffix
}
