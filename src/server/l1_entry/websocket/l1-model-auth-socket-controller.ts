import 'server-only'

import { L2ModelAuthSocketContracts } from '@common/l2_biz/model-auth/l2-model-auth-contract'
import type { L4AppSocketRequestContract } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import { L2ModelAuth, L2ModelAuthError } from '@server/l2_biz/model-auth/l2-model-auth'
import type { L4AppSocketConnection } from '@server/l4_foundation/realtime/app-socket/l4-app-socket'
import type { L1AppSocketRoute } from './l1-app-socket-route'

export class L1ModelAuthSocketController {
  readonly routes: readonly L1AppSocketRoute[]

  private readonly auth: L2ModelAuth
  private disposed = false

  constructor(private readonly connection: L4AppSocketConnection) {
    this.auth = new L2ModelAuth((state) => {
      if (!this.disposed && this.connection.isCurrent()) {
        this.connection.sendPush(L2ModelAuthSocketContracts.state, state)
      }
    })
    this.routes = Object.freeze([
      this.route(L2ModelAuthSocketContracts.list, async () => ({
        providers: await this.auth.list()
      })),
      this.route(L2ModelAuthSocketContracts.start, async (input) => {
        await this.auth.start(input.provider, input.loginId)
        return {}
      }),
      this.route(L2ModelAuthSocketContracts.respond, (input) => {
        this.auth.respond(input.loginId, input.promptId, input.value)
        return {}
      }),
      this.route(L2ModelAuthSocketContracts.cancel, (input) => {
        this.auth.cancel(input.loginId)
        return {}
      }),
      this.route(L2ModelAuthSocketContracts.logout, async (input) => {
        await this.auth.logout(input.provider)
        return {}
      })
    ])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.auth.dispose()
  }

  private route<TInput, TOutput>(
    contract: L4AppSocketRequestContract<TInput, TOutput>,
    operation: (input: TInput) => TOutput | Promise<TOutput>
  ): L1AppSocketRoute {
    return {
      path: contract.path,
      access: 'ready',
      handle: async (request) => {
        const input = contract.inputSchema.safeParse(request.body)
        if (!input.success) {
          this.connection.sendError(contract.path, request.head.requestId, 400, '账号操作参数无效')
          return
        }
        if (this.disposed || !this.connection.isCurrent()) return
        try {
          const output = await operation(input.data)
          if (!this.disposed && this.connection.isCurrent()) {
            this.connection.sendSuccess(contract, request.head.requestId, output)
          }
        } catch (error) {
          if (this.disposed || !this.connection.isCurrent()) return
          if (error instanceof L2ModelAuthError) {
            this.connection.sendError(
              contract.path,
              request.head.requestId,
              error.code,
              error.message
            )
            return
          }
          console.warn('[Pi Desk][ModelAuthSocket] 账号请求失败', {
            stage: contract.path,
            errorName: error instanceof Error ? error.name : 'UnknownError'
          })
          this.connection.sendError(
            contract.path,
            request.head.requestId,
            500,
            '账号操作失败，请重试'
          )
        }
      }
    }
  }
}
