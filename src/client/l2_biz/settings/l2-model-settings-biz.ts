import {
  L2ModelNativeConfigSchema,
  type L2ModelNativeConfig,
  L2ModelCatalogListRequestSchema,
  L2ModelCatalogListResponseSchema,
  L2ModelSettingsGetResponseSchema,
  L2ModelSettingsReplaceRequestSchema,
  L2ModelSettingsReplaceResponseSchema,
  L2ProjectModelDefaultGetResponseSchema,
  L2ProjectModelDefaultReplaceRequestSchema,
  L2ProjectModelDefaultReplaceResponseSchema,
  type L2ModelCatalogListRequest,
  type L2ModelCatalogListResponse,
  type L2ModelSettingsGetResponse,
  type L2ModelSettingsReplaceRequest,
  type L2ProjectModelDefaultGetResponse,
  type L2ProjectModelDefaultReplaceRequest
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { L2PiDirectoryListResponseSchema } from '@common/l2_biz/pi-session/l2-pi-session-contract'
import type { z } from 'zod'
import { requestL4Api as request } from '@client/l4_foundation/lib/l4-api-request'
import { saveL4PiDirectoriesCache } from '@client/l4_foundation/storage/l4-pi-directory-cache'
import { saveL2ProjectModelDefaultCache } from './l2-model-settings-cache'

export interface L2ModelSettingsBiz {
  parseNativeConfig: (text: string) => L2ModelNativeConfig
  getSettings: () => Promise<L2ModelSettingsGetResponse>
  replaceSettings: (input: L2ModelSettingsReplaceRequest) => Promise<void>
  listCatalog: (input: L2ModelCatalogListRequest) => Promise<L2ModelCatalogListResponse>
  listDirectories: () => Promise<z.infer<typeof L2PiDirectoryListResponseSchema>>
  getProjectDefault: (cwd: string) => Promise<L2ProjectModelDefaultGetResponse>
  replaceProjectDefault: (input: L2ProjectModelDefaultReplaceRequest) => Promise<void>
}

export function createL2ModelSettingsBiz(clientId: string): L2ModelSettingsBiz {
  let settingsRequest: Promise<L2ModelSettingsGetResponse> | null = null
  return {
    parseNativeConfig(text): L2ModelNativeConfig {
      const value: unknown = JSON.parse(text)
      return L2ModelNativeConfigSchema.parse(value)
    },
    getSettings(): Promise<L2ModelSettingsGetResponse> {
      if (!settingsRequest) {
        settingsRequest = request(
          clientId,
          '/api/model-settings/get',
          {},
          L2ModelSettingsGetResponseSchema
        ).finally(() => {
          settingsRequest = null
        })
      }
      return settingsRequest
    },
    async replaceSettings(input): Promise<void> {
      const parsed = L2ModelSettingsReplaceRequestSchema.safeParse(input)
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path.at(-1)
        if (field === 'modelId') {
          throw new Error('请填写模型 ID 后再保存配置。')
        }
        if (field === 'provider') {
          throw new Error('请填写 Provider ID 后再保存配置。')
        }
        throw new Error('模型配置不完整或格式不正确，请检查必填字段和数值。')
      }
      await request(
        clientId,
        '/api/model-settings/replace',
        parsed.data,
        L2ModelSettingsReplaceResponseSchema
      )
    },
    listCatalog: (input) =>
      request(
        clientId,
        '/api/model-catalog/list',
        L2ModelCatalogListRequestSchema.parse(input),
        L2ModelCatalogListResponseSchema
      ),
    async listDirectories(): Promise<z.infer<typeof L2PiDirectoryListResponseSchema>> {
      const response = await request(
        clientId,
        '/api/pi/directories/list',
        { forceRefresh: false },
        L2PiDirectoryListResponseSchema
      )
      saveL4PiDirectoriesCache(response)
      return response
    },
    async getProjectDefault(cwd): Promise<L2ProjectModelDefaultGetResponse> {
      const response = await request(
        clientId,
        '/api/project-model-default/get',
        { cwd },
        L2ProjectModelDefaultGetResponseSchema
      )
      saveL2ProjectModelDefaultCache(response)
      return response
    },
    async replaceProjectDefault(input): Promise<void> {
      await request(
        clientId,
        '/api/project-model-default/replace',
        L2ProjectModelDefaultReplaceRequestSchema.parse(input),
        L2ProjectModelDefaultReplaceResponseSchema
      )
    }
  }
}
