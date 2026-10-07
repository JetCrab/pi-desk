import type { L4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'

export type L1AppSocketRouteAccess = 'bootstrap' | 'ready'

export interface L1AppSocketRoute {
  readonly path: string
  readonly access: L1AppSocketRouteAccess
  readonly handle: (request: L4AppSocketRequest) => Promise<void>
}
