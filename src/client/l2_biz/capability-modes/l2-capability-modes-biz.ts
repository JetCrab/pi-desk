import {
  L2CapabilityModesGetResponseSchema,
  L2CapabilityModesReplaceRequestSchema,
  L2CapabilityModesReplaceResponseSchema,
  type L2CapabilityModesGetResponse
} from '@common/l2_biz/capability-modes/l2-capability-modes-contract'
import type { L3CapabilityModes } from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import type { z } from 'zod'
import { requestL4Api } from '@client/l4_foundation/lib/l4-api-request'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'

export interface L2CapabilityModesBiz {
  get(signal?: AbortSignal): Promise<L2CapabilityModesGetResponse>
  replace(modes: L3CapabilityModes, signal?: AbortSignal): Promise<L3CapabilityModes>
}

export function createL2CapabilityModesBiz(clientId: string): L2CapabilityModesBiz {
  async function request<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal
  ): Promise<T> {
    return requestL4Api(clientId, path, body, schema, {
      signal,
      fallbackMessage: l4LocalizedErrorMessage({
        msg: '能力模式请求失败',
        i18n: { key: 'errors:capabilityFailed' }
      })
    })
  }
  return {
    get: (signal) =>
      request('/api/capability-modes/get', {}, L2CapabilityModesGetResponseSchema, signal),
    async replace(modes, signal): Promise<L3CapabilityModes> {
      const parsed = L2CapabilityModesReplaceRequestSchema.safeParse({ modes })
      if (!parsed.success)
        throw new Error(
          l4LocalizedErrorMessage({
            msg: '请检查模式规则',
            i18n: { key: 'errors:capabilityRuleInvalid' }
          })
        )
      await request(
        '/api/capability-modes/replace',
        parsed.data,
        L2CapabilityModesReplaceResponseSchema,
        signal
      )
      return parsed.data.modes
    }
  }
}
