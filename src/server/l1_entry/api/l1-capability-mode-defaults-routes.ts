import 'server-only'

import {
  L2CapabilityModeDefaultsGetRequestSchema,
  L2CapabilityModeDefaultsReplaceRequestSchema
} from '@common/l2_biz/capability-modes/l2-capability-modes-contract'
import {
  getL2CapabilityModeDefaults,
  replaceL2CapabilityModeDefaults
} from '@server/l2_biz/capability-modes/l2-capability-modes'
import { handleCapabilityModesRequest } from './l1-capability-modes-routes'

export async function getCapabilityModeDefaults(request: Request): Promise<Response> {
  return handleCapabilityModesRequest(
    request,
    L2CapabilityModeDefaultsGetRequestSchema,
    getL2CapabilityModeDefaults
  )
}

export async function replaceCapabilityModeDefaults(request: Request): Promise<Response> {
  return handleCapabilityModesRequest(
    request,
    L2CapabilityModeDefaultsReplaceRequestSchema,
    replaceL2CapabilityModeDefaults
  )
}
