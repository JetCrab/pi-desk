import { z } from 'zod'

export const L4_TERMINAL_MAX_COLS = 400
export const L4_TERMINAL_MAX_ROWS = 200
export const L4_TERMINAL_SCROLLBACK = 2000
export const L4_TERMINAL_MAX_INPUT = 16 * 1024
export const L4_TERMINAL_MAX_SNAPSHOT = 8 * 1024 * 1024
export const L4TerminalDimensionsShape = {
  cols: z.number().int().min(2).max(L4_TERMINAL_MAX_COLS),
  rows: z.number().int().min(2).max(L4_TERMINAL_MAX_ROWS)
}

export const L4TerminalSnapshotSchema = z
  .object({
    ...L4TerminalDimensionsShape,
    data: z.string().max(L4_TERMINAL_MAX_SNAPSHOT)
  })
  .strict()

export const L4TerminalEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: L4TerminalSnapshotSchema }).strict(),
  z
    .object({
      type: z.literal('output'),
      data: z
        .string()
        .min(1)
        .max(64 * 1024)
    })
    .strict(),
  z.object({ type: z.literal('resize'), ...L4TerminalDimensionsShape }).strict(),
  z.object({ type: z.literal('exit'), exitCode: z.number().int() }).strict()
])

export type L4TerminalSnapshot = z.infer<typeof L4TerminalSnapshotSchema>
export type L4TerminalEvent = z.infer<typeof L4TerminalEventSchema>
