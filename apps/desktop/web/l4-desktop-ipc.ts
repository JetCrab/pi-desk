import { invoke } from '@tauri-apps/api/core'

export type PackageUpdate = {
  status: 'idle' | 'checking' | 'available' | 'installing' | 'switching' | 'failed'
  version: string | null
  error: string | null
}

export type ServerSnapshot = {
  status: 'stopped' | 'starting' | 'running' | 'failed'
  detail: string
  version: string | null
  autoStart: boolean
  needsSetup: boolean
  update: PackageUpdate | null
}

export type TunnelSnapshot = {
  status: 'stopped' | 'opening' | 'connecting' | 'listening' | 'recovering' | 'stopping' | 'failed'
  detail: string
  publicAddr: string | null
  publicPort: number
}

export type TargetSnapshot = {
  url: string
  server: ServerSnapshot | null
  tunnel: TunnelSnapshot | null
}

export type EnvironmentComponent = {
  name: 'node' | 'pi' | 'bash'
  status: 'ready' | 'missing' | 'invalid'
  version: string | null
  path: string | null
  detail: string | null
}

export type DownloadSource = 'official' | 'npmmirror'

export type EnvironmentSnapshot = {
  status: 'checking' | 'required' | 'ready' | 'installing' | 'failed'
  components: EnvironmentComponent[]
  step: string
  download: { received: number; total: number | null } | null
  error: string | null
}

export type ControlState = {
  targets: TargetSnapshot[]
  environment: EnvironmentSnapshot
}

export type UpdatePolicy = 'none' | 'check' | 'update'
export type ReleaseChannel = 'stable' | 'dev'

export type PackageConfig = {
  name: string
  registry: string | null
  startupUpdate: UpdatePolicy
  periodicUpdate: UpdatePolicy
  channel: ReleaseChannel
}

export type ServerConfig = {
  startCommand: string
  readyPath: string
  package: PackageConfig | null
}

export type TargetConfig = {
  url: string
  server: ServerConfig | null
  tunnel: { enabled: boolean; publicPort: number } | null
}

export type TargetSettings = { target: TargetConfig | null; defaultServer: ServerConfig }
export type TunnelConnection = { controlServerUrl: string; controlKey: string }

export function desktopCommand(command: string, args?: Record<string, unknown>): Promise<void> {
  return invoke<void>(command, args)
}

export function getControlState(): Promise<ControlState> {
  return invoke<ControlState>('get_control_state')
}

export function getEnvironmentDownloadSource(): Promise<DownloadSource> {
  return invoke<DownloadSource>('get_environment_download_source')
}

export function getTargetSettings(url: string | null): Promise<TargetSettings> {
  return invoke<TargetSettings>('get_target_settings', { url })
}

export function getTunnelConnection(): Promise<TunnelConnection> {
  return invoke<TunnelConnection>('get_tunnel_connection')
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
