import { invoke } from '@tauri-apps/api/core'

export type PackageUpdate = {
  status: 'idle' | 'checking' | 'available' | 'installing' | 'installed' | 'switching' | 'failed'
  version: string | null
  error: string | null
}

export type PiUpdate = {
  status: 'idle' | 'checking' | 'available' | 'current' | 'updating' | 'failed'
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

export type TunnelPhase =
  'stopped' | 'opening' | 'connecting' | 'listening' | 'recovering' | 'stopping' | 'failed'
export type TunnelMode = 'auto' | 'relay-only'
export type TunnelPath = 'unknown' | 'direct' | 'relay'
export type TunnelPublication = { localPort: number; publicPort: number | null; enabled: boolean }
export type TunnelForward = {
  providerId: string
  remotePort: number
  localPort: number
  enabled: boolean
}
export type PublicationSnapshot = TunnelPublication & {
  phase: TunnelPhase
  detail: string
  publicAddr: string | null
}
export type ForwardSnapshot = TunnelForward & {
  phase: TunnelPhase
  detail: string
  path: TunnelPath
}
export type TunnelConnectionRow = {
  peerId: string
  localPort: number
  source: 'public' | 'client'
  path: TunnelPath
  activeTcp: number
}
export type TunnelSnapshot = {
  providerId: string | null
  mode: TunnelMode
  restartRequired: boolean
  publications: PublicationSnapshot[]
  forwards: ForwardSnapshot[]
  connections: TunnelConnectionRow[]
  error: string | null
}

export type TargetSnapshot = {
  url: string
  server: ServerSnapshot | null
}

export type EnvironmentComponent = {
  name: 'node' | 'pi' | 'bash'
  status: 'ready' | 'missing' | 'invalid'
  version: string | null
  path: string | null
  detail: string | null
  download: { received: number; total: number | null } | null
}

export type DownloadSource =
  { mode: 'domestic' } | { mode: 'official' } | { mode: 'custom'; registry: string }

export type EnvironmentSnapshot = {
  status: 'checking' | 'required' | 'ready' | 'installing' | 'failed'
  components: EnvironmentComponent[]
  step: string
  error: string | null
  piUpdate: PiUpdate
}

export type ControlState = {
  hideOnStartup: boolean | null
  hideOnOpen: boolean
  showOnClose: boolean
  targets: TargetSnapshot[]
  tunnel: TunnelSnapshot
  environment: EnvironmentSnapshot
}

export type StartupPreferences = {
  hideOnStartup?: boolean
  hideOnOpen?: boolean
  showOnClose?: boolean
}

export type UpdatePolicy = 'none' | 'check' | 'update'
export type ReleaseChannel = 'stable' | 'dev'

export type PackageConfig = {
  name: string
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

export function setEnvironmentDownloadSource(source: DownloadSource): Promise<void> {
  return desktopCommand('set_environment_download_source_command', { source })
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
