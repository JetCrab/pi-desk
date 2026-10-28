export type L4DesktopWindowAction =
  'attach' | 'detach' | 'state' | 'drag' | 'minimize' | 'toggle-maximize' | 'close'

export interface L4DesktopWindowState {
  maximized: boolean
}

export interface L4DesktopWindow {
  invoke(action: L4DesktopWindowAction): Promise<L4DesktopWindowState>
}

declare global {
  interface Window {
    __PI_DESK_WINDOW__?: L4DesktopWindow
  }
}

export function getL4DesktopWindow(): L4DesktopWindow | null {
  return typeof window === 'undefined' ? null : (window.__PI_DESK_WINDOW__ ?? null)
}
