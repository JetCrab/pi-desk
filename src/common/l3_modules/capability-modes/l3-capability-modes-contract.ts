import type { CapabilityModeNames, CapabilityModes } from '@jetcrab/pi-desk-sdk/capabilities'

export {
  CapabilityModeKeySchema as L3CapabilityModeKeySchema,
  CapabilityModeSchema as L3CapabilityModeSchema,
  CapabilityModesSchema as L3CapabilityModesSchema,
  CapabilityModeNamesSchema as L3CapabilityModeNamesSchema,
  CapabilityCatalogSchema as L3CapabilityCatalogSchema
} from '@jetcrab/pi-desk-sdk/capabilities'

export type {
  CapabilityMode as L3CapabilityMode,
  CapabilityModes as L3CapabilityModes,
  CapabilityModeNames as L3CapabilityModeNames,
  CapabilityCatalog as L3CapabilityCatalog
} from '@jetcrab/pi-desk-sdk/capabilities'

export function l3CapabilityModeNames(modes: CapabilityModes): CapabilityModeNames {
  return Object.fromEntries(Object.entries(modes).map(([key, mode]) => [key, mode.name]))
}
