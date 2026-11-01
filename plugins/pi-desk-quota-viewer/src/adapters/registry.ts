import { antigravityManagerAdapter } from './antigravity-manager.js'
import { commandCodeAdapter } from './commandcode.js'
import { cpaAdapter } from './cpa.js'
import { moonshotAdapter } from './moonshot.js'
import { openCodeGoAdapter } from './opencode-go.js'
import { openRouterAdapter } from './openrouter.js'
import { siliconFlowAdapter } from './siliconflow.js'
import type { QuotaAdapter } from './types.js'
import { zhipuCodingPlanAdapter } from './zhipu-coding-plan.js'

export const quotaAdapters: readonly QuotaAdapter[] = Object.freeze([
  openRouterAdapter,
  moonshotAdapter,
  siliconFlowAdapter,
  zhipuCodingPlanAdapter,
  openCodeGoAdapter,
  commandCodeAdapter,
  cpaAdapter,
  antigravityManagerAdapter
])

export const quotaAdapterRegistry: ReadonlyMap<string, QuotaAdapter> = new Map(
  quotaAdapters.map((adapter) => [adapter.descriptor.adapter, adapter])
)

export function getQuotaAdapter(name: string): QuotaAdapter | undefined {
  return quotaAdapterRegistry.get(name)
}
