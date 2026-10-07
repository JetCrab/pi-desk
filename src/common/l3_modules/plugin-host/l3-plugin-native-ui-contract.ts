import { z } from 'zod'
import { L3WorkSessionSourceSchema } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import {
  L4PiUiEventSchema,
  L4PiUiResponseSchema,
  L4PiUiSnapshotSchema
} from '@common/l4_foundation/pi/l4-pi-ui-contract'
import {
  defineL4AppSocketPush,
  defineL4AppSocketRequest
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'

const source = z.object({ source: L3WorkSessionSourceSchema }).strict()
const empty = z.object({}).strict()

export const L3PiUiSocketContracts = Object.freeze({
  subscribe: defineL4AppSocketRequest({
    path: 'pi/ui/subscribe',
    inputSchema: source,
    outputSchema: L4PiUiSnapshotSchema
  }),
  unsubscribe: defineL4AppSocketRequest({
    path: 'pi/ui/unsubscribe',
    inputSchema: source,
    outputSchema: empty
  }),
  respond: defineL4AppSocketRequest({
    path: 'pi/ui/respond',
    inputSchema: source.extend({ response: L4PiUiResponseSchema }).strict(),
    outputSchema: empty
  }),
  event: defineL4AppSocketPush({
    path: 'pi/ui/event',
    bodySchema: source.extend({ event: L4PiUiEventSchema }).strict()
  })
})
