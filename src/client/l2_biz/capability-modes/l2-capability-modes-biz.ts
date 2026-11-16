import {
  L2CapabilityModesGetResponseSchema,
  L2CapabilityModesReplaceRequestSchema,
  L2CapabilityModesReplaceResponseSchema,
  L2SystemPromptGetResponseSchema,
  L2SystemPromptReplaceResponseSchema,
  type L2CapabilityModesGetResponse,
  type L2CapabilityModesReplaceRequest
} from '@common/l2_biz/capability-modes/l2-capability-modes-contract'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import {
  L2ChatModelContextGetResponseSchema,
  type L2ChatModelContextGetResponse
} from '@common/l2_biz/chat/l2-chat-context-contract'
import type { z } from 'zod'
import { requestL4Api } from '@client/l4_foundation/lib/l4-api-request'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'

export interface L2CapabilityModesBiz {
  get(signal?: AbortSignal): Promise<L2CapabilityModesGetResponse>
  replace(
    input: L2CapabilityModesReplaceRequest,
    signal?: AbortSignal
  ): Promise<L2CapabilityModesReplaceRequest>
  getPrompt(modeKey?: string, signal?: AbortSignal): Promise<string>
  replaceGlobalPrompt(content: string, signal?: AbortSignal): Promise<void>
  preview(
    source: L2ChatSource,
    content: string,
    signal?: AbortSignal
  ): Promise<L2ChatModelContextGetResponse>
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
    async replace(input, signal): Promise<L2CapabilityModesReplaceRequest> {
      const parsed = L2CapabilityModesReplaceRequestSchema.safeParse(input)
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
      return parsed.data
    },
    async getPrompt(modeKey, signal): Promise<string> {
      const result = await request(
        '/api/system-prompt/get',
        { modeKey },
        L2SystemPromptGetResponseSchema,
        signal
      )
      return result.content
    },
    async replaceGlobalPrompt(content, signal): Promise<void> {
      await request(
        '/api/system-prompt/replace',
        { content },
        L2SystemPromptReplaceResponseSchema,
        signal
      )
    },
    preview: (source, content, signal) =>
      request(
        '/api/chat/context/get',
        { source, previewAppendSystemPrompt: content },
        L2ChatModelContextGetResponseSchema,
        signal
      )
  }
}
