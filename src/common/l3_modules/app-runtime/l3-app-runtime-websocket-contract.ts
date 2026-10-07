import {
  L3AppRuntimeApplyRequestSchema,
  L3AppRuntimeApplyResponseSchema,
  L3AppRuntimeEventSchema
} from './l3-app-runtime-contract'
import {
  defineL4AppSocketPush,
  defineL4AppSocketRequest
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'

export const L3AppRuntimeSocketContracts = Object.freeze({
  apply: defineL4AppSocketRequest({
    path: 'app-runtime/apply',
    inputSchema: L3AppRuntimeApplyRequestSchema,
    outputSchema: L3AppRuntimeApplyResponseSchema
  }),
  update: defineL4AppSocketPush({
    path: 'app-runtime/update',
    bodySchema: L3AppRuntimeEventSchema
  })
})
