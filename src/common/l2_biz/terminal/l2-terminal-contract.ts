import { z } from 'zod'
import {
  defineL4AppSocketPush,
  defineL4AppSocketRequest
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'

import {
  L4_TERMINAL_MAX_INPUT as L2_TERMINAL_MAX_INPUT,
  L4TerminalDimensionsShape as Dimensions,
  L4TerminalSnapshotSchema as L2TerminalSnapshotSchema,
  L4TerminalEventSchema as L2TerminalEventSchema
} from '@common/l4_foundation/terminal/l4-terminal-screen'

export { L2_TERMINAL_MAX_INPUT, L2TerminalSnapshotSchema, L2TerminalEventSchema }

const TerminalId = z.string().uuid()
const Empty = z.object({}).strict()

export const L2TerminalSummarySchema = z
  .object({
    terminalId: TerminalId,
    cwd: z.string().min(1),
    shell: z.string().min(1),
    title: z.string().max(512),
    status: z.enum(['running', 'exited']),
    exitCode: z.number().int().nullable()
  })
  .strict()

export const L2TerminalListSchema = z
  .object({
    terminals: z.array(L2TerminalSummarySchema).max(32)
  })
  .strict()

export const L2TerminalSocketContracts = Object.freeze({
  list: defineL4AppSocketRequest({
    path: 'terminals/list',
    inputSchema: Empty,
    outputSchema: L2TerminalListSchema
  }),
  create: defineL4AppSocketRequest({
    path: 'terminals/create',
    inputSchema: z.object({ cwd: z.string().min(1).max(32768).optional() }).strict(),
    outputSchema: L2TerminalSummarySchema
  }),
  remove: defineL4AppSocketRequest({
    path: 'terminals/remove',
    inputSchema: z.object({ terminalId: TerminalId }).strict(),
    outputSchema: Empty
  }),
  watch: defineL4AppSocketRequest({
    path: 'terminals/watch',
    inputSchema: z.object({ terminalId: TerminalId.nullable() }).strict(),
    outputSchema: z.object({ snapshot: L2TerminalSnapshotSchema.nullable() }).strict()
  }),
  unwatch: defineL4AppSocketRequest({
    path: 'terminals/unwatch',
    inputSchema: z.object({ terminalId: TerminalId }).strict(),
    outputSchema: Empty
  }),
  input: defineL4AppSocketRequest({
    path: 'terminals/input',
    inputSchema: z
      .object({ terminalId: TerminalId, data: z.string().min(1).max(L2_TERMINAL_MAX_INPUT) })
      .strict(),
    outputSchema: Empty
  }),
  activate: defineL4AppSocketRequest({
    path: 'terminals/activate',
    inputSchema: z.object({ terminalId: TerminalId, ...Dimensions }).strict(),
    outputSchema: Empty
  }),
  resize: defineL4AppSocketRequest({
    path: 'terminals/resize',
    inputSchema: z.object({ terminalId: TerminalId, ...Dimensions }).strict(),
    outputSchema: Empty
  }),
  update: defineL4AppSocketPush({ path: 'terminals/update', bodySchema: L2TerminalListSchema }),
  event: defineL4AppSocketPush({
    path: 'terminals/event',
    bodySchema: z.object({ terminalId: TerminalId, event: L2TerminalEventSchema }).strict()
  })
})

export type L2TerminalSummary = z.infer<typeof L2TerminalSummarySchema>
export type L2TerminalSnapshot = z.infer<typeof L2TerminalSnapshotSchema>
export type L2TerminalEvent = z.infer<typeof L2TerminalEventSchema>
