import 'server-only'

import { L3AppRuntimeSocketContracts } from '@common/l3_modules/app-runtime/l3-app-runtime-websocket-contract'
import type { L4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  L2AppRuntimeTargetNotFoundError,
  type L2AppRuntime
} from '@server/l2_biz/app-runtime/l2-app-runtime'
import type { L4AppSocketConnection } from '@server/l4_foundation/realtime/app-socket/l4-app-socket'
import type { L1AppSocketRoute } from './l1-app-socket-route'

export class L1AppRuntimeSocketController {
  readonly routes: readonly L1AppSocketRoute[]

  constructor(
    private readonly connection: L4AppSocketConnection,
    private readonly runtime: L2AppRuntime
  ) {
    this.routes = Object.freeze([
      {
        path: L3AppRuntimeSocketContracts.apply.path,
        access: 'ready',
        handle: (request) => this.apply(request)
      }
    ])
  }

  dispose(): void {}

  private async apply(request: L4AppSocketRequest): Promise<void> {
    const contract = L3AppRuntimeSocketContracts.apply
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(
        contract.path,
        request.head.requestId,
        400,
        'App Runtime 更新参数无效'
      )
      return
    }

    try {
      await this.runtime.applyClient(input.data)
      this.connection.sendSuccess(contract, request.head.requestId, {})
    } catch (error) {
      const notFound = error instanceof L2AppRuntimeTargetNotFoundError
      this.connection.sendError(
        contract.path,
        request.head.requestId,
        notFound ? 404 : 500,
        notFound ? 'App Runtime 目标不存在' : 'App Runtime 更新失败'
      )
    }
  }
}
