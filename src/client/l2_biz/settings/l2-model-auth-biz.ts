import {
  L2ModelAuthSocketContracts,
  type L2ModelAuthProvider,
  type L2ModelAuthState
} from '@common/l2_biz/model-auth/l2-model-auth-contract'
import type { L4AppSocketClient } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'

export function createL2ModelAuthBiz(socket: L4AppSocketClient): {
  list: () => Promise<L2ModelAuthProvider[]>
  start: (loginId: string, provider: string) => Promise<void>
  respond: (loginId: string, promptId: string, value: string) => Promise<void>
  cancel: (loginId: string) => Promise<void>
  logout: (provider: string) => Promise<void>
  subscribe: (listener: (state: L2ModelAuthState) => void) => () => void
} {
  return {
    async list(): Promise<L2ModelAuthProvider[]> {
      return (await socket.request(L2ModelAuthSocketContracts.list, {})).providers
    },
    async start(loginId, provider): Promise<void> {
      await socket.request(L2ModelAuthSocketContracts.start, { loginId, provider })
    },
    async respond(loginId, promptId, value): Promise<void> {
      await socket.request(L2ModelAuthSocketContracts.respond, { loginId, promptId, value })
    },
    async cancel(loginId): Promise<void> {
      await socket.request(L2ModelAuthSocketContracts.cancel, { loginId })
    },
    async logout(provider): Promise<void> {
      await socket.request(L2ModelAuthSocketContracts.logout, { provider })
    },
    subscribe: (listener) => socket.subscribe(L2ModelAuthSocketContracts.state, listener)
  }
}

export function safeL2ModelAuthUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function openL2ModelAuthUrl(value: string): void {
  const url = safeL2ModelAuthUrl(value)
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}

export async function copyL2ModelAuthText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value)
}
