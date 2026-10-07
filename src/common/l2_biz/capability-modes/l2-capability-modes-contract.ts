import { z } from 'zod'
import {
  L3CapabilityCatalogSchema,
  L3CapabilityModesSchema
} from '@common/l3_modules/capability-modes/l3-capability-modes-contract'

export const L2CapabilityModesGetRequestSchema = z.object({}).strict()
export const L2CapabilityModesGetResponseSchema = z
  .object({ modes: L3CapabilityModesSchema, catalog: L3CapabilityCatalogSchema })
  .strict()
export const L2CapabilityModesReplaceRequestSchema = z
  .object({ modes: L3CapabilityModesSchema })
  .strict()
export const L2CapabilityModesReplaceResponseSchema = z.object({}).strict()

export type L2CapabilityModesGetResponse = z.infer<typeof L2CapabilityModesGetResponseSchema>
export type L2CapabilityModesReplaceRequest = z.infer<typeof L2CapabilityModesReplaceRequestSchema>
