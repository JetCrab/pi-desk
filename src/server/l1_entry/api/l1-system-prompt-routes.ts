import 'server-only'

import {
  L2SystemPromptGetRequestSchema,
  L2SystemPromptReplaceRequestSchema
} from '@common/l2_biz/capability-modes/l2-capability-modes-contract'
import {
  getL2SystemPrompt,
  replaceL2SystemPrompt
} from '@server/l2_biz/capability-modes/l2-capability-modes'
import { handleCapabilityModesRequest } from './l1-capability-modes-routes'

export async function getSystemPrompt(request: Request): Promise<Response> {
  return handleCapabilityModesRequest(request, L2SystemPromptGetRequestSchema, getL2SystemPrompt)
}

export async function replaceSystemPrompt(request: Request): Promise<Response> {
  return handleCapabilityModesRequest(
    request,
    L2SystemPromptReplaceRequestSchema,
    replaceL2SystemPrompt
  )
}
