import 'server-only'

import { L4ClientTunnelResolveContract } from '@common/l4_foundation/tunnel/l4-client-tunnel-contract'
import type { L4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import type { L4AppSocketConnection } from '@server/l4_foundation/realtime/app-socket/l4-app-socket'
import { resolveL4ClientTunnel } from '@server/l4_foundation/tunnel/l4-client-tunnel'
import type { L1AppSocketRoute } from './l1-app-socket-route'

export class L1ClientTunnelSocketController {
  readonly routes: readonly L1AppSocketRoute[]
  private readonly lifetime = new AbortController()

  constructor(private readonly connection: L4AppSocketConnection) {
    this.routes = [
      {
        path: L4ClientTunnelResolveContract.path,
        access: 'ready',
        handle: (request) => this.resolve(request)
      }
    ]
  }

  dispose(): void {
    this.lifetime.abort()
  }

  private async resolve(request: L4AppSocketRequest): Promise<void> {
    const contract = L4ClientTunnelResolveContract
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '隧道端口参数无效')
      return
    }
    try {
      const target = await resolveL4ClientTunnel(input.data.remotePort, this.lifetime.signal)
      if (!this.lifetime.signal.aborted) {
        this.connection.sendSuccess(contract, request.head.requestId, target)
      }
    } catch (cause) {
      if (!this.lifetime.signal.aborted) {
        this.connection.sendError(
          contract.path,
          request.head.requestId,
          503,
          cause instanceof Error ? cause.message : '端口发布查询失败'
        )
      }
    }
  }
}
