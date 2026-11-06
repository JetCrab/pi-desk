import {
  desktopCommand,
  getTunnelConnection,
  type TunnelConnection,
  type TunnelForward,
  type TunnelMode,
  type TunnelPublication
} from './l4-desktop-ipc'

export type PortDraft =
  | {
      kind: 'publication'
      originalPort: number | null
      localPort: string
      publicPort: string
      enabled: boolean
    }
  | {
      kind: 'forward'
      originalPort: number | null
      connectionInfo: string
      localPort: string
      enabled: boolean
    }

export function readAccessSettings(): Promise<TunnelConnection> {
  return getTunnelConnection()
}

export async function saveAccessConnection(value: TunnelConnection): Promise<void> {
  await desktopCommand('apply_tunnel_connection_command', { value })
}

function port(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
    throw new Error(`${label}应为 1 到 65535 的整数`)
  return parsed
}

export async function saveAccessPort(draft: PortDraft): Promise<void> {
  const localPort = port(draft.localPort, '本机端口')
  if (draft.kind === 'publication') {
    const value: TunnelPublication = {
      localPort,
      publicPort: draft.publicPort.trim() ? port(draft.publicPort, '公网端口') : null,
      enabled: draft.enabled
    }
    await desktopCommand('apply_tunnel_publication_command', {
      originalPort: draft.originalPort,
      value
    })
  } else {
    const target = parseAccessConnectionInfo(draft.connectionInfo)
    const value: TunnelForward = {
      ...target,
      localPort,
      enabled: draft.enabled
    }
    await desktopCommand('apply_tunnel_forward_command', {
      originalPort: draft.originalPort,
      value
    })
  }
}

export async function setAccessEnabled(
  kind: PortDraft['kind'],
  localPort: number,
  enabled: boolean
): Promise<void> {
  await desktopCommand(`set_tunnel_${kind}_enabled_command`, { localPort, enabled })
}

export async function deleteAccessPort(kind: PortDraft['kind'], localPort: number): Promise<void> {
  await desktopCommand(`delete_tunnel_${kind}_command`, { localPort })
}

export async function setAccessMode(mode: TunnelMode): Promise<void> {
  await desktopCommand('set_tunnel_mode_command', { mode })
}

export function formatAccessConnectionInfo(providerId: string, remotePort: number): string {
  return `pidesk-tcp://${providerId}:${remotePort}`
}

export function parseAccessConnectionInfo(value: string): {
  providerId: string
  remotePort: number
} {
  const match = /^pidesk-tcp:\/\/([a-f\d]{64}):(\d+)\/?$/iu.exec(value.trim())
  if (!match) throw new Error('连接信息无效，请从提供端复制后再粘贴')
  return { providerId: match[1].toLowerCase(), remotePort: port(match[2], '目标端口') }
}

export function publicAccessUrl(
  localUrls: readonly string[],
  localPort: number,
  publicAddr: string
): string | null {
  const original = localUrls.find((value) => localAddressPort(value) === localPort)
  if (!original) return null
  const url = new URL(original)
  return new URL(`${url.protocol}//${publicAddr}${url.pathname}${url.search}${url.hash}`).href
}

export async function openAccessUrl(url: string): Promise<void> {
  await desktopCommand('open_external_url_command', { url })
}

export function localAddressPort(value: string): number | null {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) return null
  if (!['localhost', '[::1]'].includes(url.hostname) && !/^127\.\d+\.\d+\.\d+$/u.test(url.hostname))
    return null
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80))
}
