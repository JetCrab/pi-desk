import 'server-only'

import {
  L2CapabilityModesGetResponseSchema,
  type L2CapabilityModesGetResponse,
  type L2CapabilityModesReplaceRequest,
  type L2SystemPromptGetRequest,
  type L2SystemPromptGetResponse,
  type L2SystemPromptReplaceRequest,
  type L2CapabilityModeDefaultsGetRequest,
  type L2CapabilityModeDefaultsGetResponse,
  type L2CapabilityModeDefaultsReplaceRequest
} from '@common/l2_biz/capability-modes/l2-capability-modes-contract'
import { readL4CapabilityCatalog } from '@server/l4_foundation/capability-modes/l4-capability-catalog'
import { getL4CapabilityModesStore } from '@server/l4_foundation/capability-modes/l4-capability-modes-store'

export async function getL2CapabilityModes(): Promise<L2CapabilityModesGetResponse> {
  const modes = getL4CapabilityModesStore().read()
  const catalog = await readL4CapabilityCatalog()
  return L2CapabilityModesGetResponseSchema.parse({ modes, catalog })
}

export async function replaceL2CapabilityModes(
  input: L2CapabilityModesReplaceRequest
): Promise<void> {
  await getL4CapabilityModesStore().replace(input.modes, input.promptContents)
}

export async function getL2SystemPrompt(
  input: L2SystemPromptGetRequest
): Promise<L2SystemPromptGetResponse> {
  return { content: await getL4CapabilityModesStore().readPrompt(input.modeKey) }
}

export async function replaceL2SystemPrompt(input: L2SystemPromptReplaceRequest): Promise<void> {
  await getL4CapabilityModesStore().replaceGlobalPrompt(input.content)
}

export async function getL2CapabilityModeDefaults(
  input: L2CapabilityModeDefaultsGetRequest
): Promise<L2CapabilityModeDefaultsGetResponse> {
  return getL4CapabilityModesStore().readDefault(input.cwd)
}

export async function replaceL2CapabilityModeDefaults(
  input: L2CapabilityModeDefaultsReplaceRequest
): Promise<void> {
  await getL4CapabilityModesStore().replaceDefault(input)
}
