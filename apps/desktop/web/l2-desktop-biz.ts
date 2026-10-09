import {
  desktopCommand,
  getTargetSettings,
  type DownloadSource,
  type EnvironmentComponent,
  type ReleaseChannel,
  type StartupPreferences,
  type TargetConfig,
  type UpdatePolicy
} from './l4-desktop-ipc'

export type DesktopAction =
  | 'open'
  | 'stop'
  | 'restart'
  | 'delete'
  | 'check-update'
  | 'update'
  | 'cancel-update'
  | 'start-tunnel'
  | 'stop-tunnel'
  | 'check-environment'
  | 'cancel-environment'

const commands: Record<DesktopAction, string> = {
  open: 'open_target_command',
  stop: 'stop_server_command',
  restart: 'restart_server_command',
  delete: 'delete_target_command',
  'check-update': 'check_package_update_command',
  update: 'update_package_command',
  'cancel-update': 'cancel_package_update_command',
  'start-tunnel': 'start_tunnel_command',
  'stop-tunnel': 'stop_tunnel_command',
  'check-environment': 'check_environment_command',
  'cancel-environment': 'cancel_environment_command'
}

export async function runDesktopAction(action: DesktopAction, url?: string): Promise<void> {
  await desktopCommand(commands[action], url ? { url } : undefined)
}

export async function saveStartupPreference(preferences: StartupPreferences): Promise<void> {
  await desktopCommand('set_startup_preference_command', preferences)
}

export async function prepareEnvironment(
  url: string,
  downloadSource: DownloadSource
): Promise<void> {
  await desktopCommand('prepare_environment_command', { url, downloadSource })
}

export function piInstallCommand(downloadSource: DownloadSource): string {
  const registry =
    downloadSource === 'npmmirror'
      ? 'https://mirrors.cloud.tencent.com/npm'
      : 'https://registry.npmjs.org'
  return `npm install -g --ignore-scripts --registry ${registry} @earendil-works/pi-coding-agent`
}

export async function selectEnvironment(
  component: EnvironmentComponent['name'],
  archive = false
): Promise<void> {
  await desktopCommand('select_environment_command', { component, archive })
}

export async function openInstallHelp(component: EnvironmentComponent['name']): Promise<void> {
  await desktopCommand('open_install_help_command', { component })
}

export function normalizeDesktopAddress(value: string): string {
  const input = value.trim()
  if (!input) throw new Error('请输入网页地址')
  // 无协议的本机或局域网地址使用 HTTP，其余地址默认使用 HTTPS。
  const isLocal =
    /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])(?=[:/]|$)/iu.test(
      input
    )
  const address = /^[a-z][a-z\d+.-]*:\/\//iu.test(input)
    ? input
    : `${isLocal ? 'http' : 'https'}://${input}`
  let parsed: URL
  try {
    parsed = new URL(address)
  } catch {
    throw new Error('请输入有效的网址，例如 http://192.168.1.20:30333')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('请输入 http:// 或 https:// 地址，不要包含账号或密码')
  }
  return parsed.href
}

export type SettingsDraft = {
  url: string
  serverEnabled: boolean
  startCommand: string
  readyPath: string
  packageEnabled: boolean
  packageName: string
  packageRegistry: string
  startupUpdate: UpdatePolicy
  periodicUpdate: UpdatePolicy
  channel: ReleaseChannel
}

export async function readDesktopSettings(originalUrl: string | null): Promise<SettingsDraft> {
  const settings = await getTargetSettings(originalUrl)
  const target = settings?.target
  const server = target?.server ?? settings?.defaultServer
  return {
    url: target?.url ?? '',
    serverEnabled: Boolean(target?.server),
    startCommand: server?.startCommand ?? '',
    readyPath: server?.readyPath ?? '',
    packageEnabled: Boolean(server?.package),
    packageName: server?.package?.name ?? '',
    packageRegistry: server?.package?.registry ?? '',
    startupUpdate: server?.package?.startupUpdate ?? 'check',
    periodicUpdate: server?.package?.periodicUpdate ?? 'none',
    channel: server?.package?.channel ?? 'stable'
  }
}

export async function saveDesktopSettings(
  originalUrl: string | null,
  draft: SettingsDraft
): Promise<string> {
  const current = originalUrl ? await getTargetSettings(originalUrl) : null
  if (originalUrl && !current?.target) throw new Error('这个地址已被移除，请刷新后重试')
  const value: TargetConfig = {
    url: normalizeDesktopAddress(draft.url),
    server: draft.serverEnabled
      ? {
          startCommand: draft.startCommand,
          readyPath: draft.readyPath,
          package: draft.packageEnabled
            ? {
                name: draft.packageName,
                registry: draft.packageRegistry.trim() || null,
                startupUpdate: draft.startupUpdate,
                periodicUpdate: draft.periodicUpdate,
                channel: draft.channel
              }
            : null
        }
      : null,
    tunnel: current?.target?.tunnel ?? null
  }
  await desktopCommand('apply_target_command', { originalUrl, value })
  return value.url
}

export async function saveDesktopAddress(
  originalUrl: string | null,
  address: string
): Promise<string> {
  const url = normalizeDesktopAddress(address)
  const settings = originalUrl ? await getTargetSettings(originalUrl) : null
  if (originalUrl && !settings?.target) throw new Error('这个地址已被移除，请刷新后重试')
  const value: TargetConfig = settings?.target
    ? { ...settings.target, url }
    : { url, server: null, tunnel: null }
  await desktopCommand('apply_target_command', { originalUrl, value })
  return url
}

export async function copyDesktopText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}
