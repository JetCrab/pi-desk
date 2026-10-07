import 'server-only'

import {
  L2CapabilityModesGetResponseSchema,
  type L2CapabilityModesGetResponse,
  type L2CapabilityModesReplaceRequest
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
  await getL4CapabilityModesStore().replace(input.modes)
}
