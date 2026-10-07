import 'server-only'

import {
  createCodingTools,
  createReadOnlyTools,
  getAgentDir
} from '@earendil-works/pi-coding-agent'
import type { CapabilityOption } from '@jetcrab/pi-desk-sdk/capabilities'
import type { CapabilityCatalog as L3CapabilityCatalog } from '@jetcrab/pi-desk-sdk/capabilities'
import { getL4PiGlobalPluginRuntime } from '@server/l4_foundation/pi/l4-pi-global-plugin-runtime'
import { listL4PiLoadedNativeTools } from '@server/l4_foundation/pi/l4-pi-work-session-runtime'
import { listL4Skills } from '@server/l4_foundation/skills/l4-skills'

function options(items: readonly { name: string; description: string }[]): CapabilityOption[] {
  return [
    ...new Map(
      items.map((item) => [
        item.name,
        {
          value: item.name,
          description: item.description.replace(/\s+/g, ' ').trim().slice(0, 1000)
        }
      ])
    ).values()
  ].sort((left, right) => left.value.localeCompare(right.value))
}

export async function readL4CapabilityCatalog(): Promise<L3CapabilityCatalog> {
  const [loadedTools, skills, plugins] = await Promise.all([
    listL4PiLoadedNativeTools(),
    listL4Skills(null),
    getL4PiGlobalPluginRuntime().listCapabilityDeclarations()
  ])
  const cwd = getAgentDir()
  return {
    tools: options([...createCodingTools(cwd), ...createReadOnlyTools(cwd), ...loadedTools]),
    skills: options(skills.skills),
    plugins
  }
}
