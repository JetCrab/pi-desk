import 'server-only'

export interface L4PiDeskPackageMaintenanceRequest {
  action: 'install' | 'update' | 'remove' | 'reinstall'
  source: string
  registry?: string
}

type L4PiDeskRestartHandler = (
  maintenance?: L4PiDeskPackageMaintenanceRequest | readonly L4PiDeskPackageMaintenanceRequest[],
  mode?: 'normal' | 'basic'
) => void

const L4_PI_DESK_RESTART_DELAY_MS = 150

function restartHandler(): L4PiDeskRestartHandler | null {
  return globalThis.__piDeskRestartHandler ?? null
}

export function canRestartL4PiDesk(): boolean {
  return restartHandler() !== null
}

export function scheduleL4PiDeskRestart(
  maintenance?: L4PiDeskPackageMaintenanceRequest | readonly L4PiDeskPackageMaintenanceRequest[],
  mode?: 'normal' | 'basic'
): void {
  const handler = restartHandler()
  if (!handler) throw new Error('当前启动方式不支持自动重启 Pi Desk')
  const timer = setTimeout(() => handler(maintenance, mode), L4_PI_DESK_RESTART_DELAY_MS)
  timer.unref()
}

declare global {
  var __piDeskRestartHandler: L4PiDeskRestartHandler | undefined
}
