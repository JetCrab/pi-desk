import { z } from 'zod'

export const L3PiModelThinkingLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

export type L3PiModelThinkingLevel = z.infer<typeof L3PiModelThinkingLevelSchema>
