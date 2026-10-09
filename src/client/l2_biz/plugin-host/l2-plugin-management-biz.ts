'use client'

import type { ZodType } from 'zod'
import { requestL4Api } from '@client/l4_foundation/lib/l4-api-request'
import {
  L2PluginManagementApplyRequestSchema,
  L2PluginManagementReloadRequestSchema,
  L2PluginManagementChangedContract,
  L2PluginManagementDetailSchema,
  L2PluginManagementListRequestSchema,
  L2PluginManagementSnapshotSchema,
  L2PluginManagementSourceRequestSchema,
  L2PluginManagementInstallRequestSchema,
  L2PluginManagementEnabledRequestSchema,
  type L2PluginManagementInstallRequest,
  type L2PluginManagementDetail,
  type L2PluginManagementSnapshot
} from '@common/l2_biz/plugin/l2-plugin-management-contract'

import {
  L2PluginCatalogSearchRequestSchema,
  L2PluginCatalogSearchResultSchema,
  L2PluginCatalogGetRequestSchema,
  L2PluginCatalogDetailSchema,
  L2PluginCatalogSettingsSchema,
  L2PluginCatalogSettingsRequestSchema,
  type L2PluginCatalogSearchRequest,
  type L2PluginCatalogSearchResult,
  type L2PluginCatalogGetRequest,
  type L2PluginCatalogDetail,
  type L2PluginCatalogSettings,
  type L2PluginDownloadSource
} from '@common/l2_biz/plugin/l2-plugin-catalog-contract'

import type { L4AppSocketClient } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'

export interface L2PluginManagementBiz {
  subscribeChanges(listener: () => void): () => void
  list(checkUpdates?: boolean): Promise<L2PluginManagementSnapshot>
  get(source: string): Promise<L2PluginManagementDetail>
  add(input: L2PluginManagementInstallRequest): Promise<L2PluginManagementSnapshot>
  setEnabled(source: string, enabled: boolean): Promise<L2PluginManagementSnapshot>
  searchCatalog(input: L2PluginCatalogSearchRequest): Promise<L2PluginCatalogSearchResult>
  getCatalog(input: L2PluginCatalogGetRequest): Promise<L2PluginCatalogDetail>
  getCatalogSettings(): Promise<L2PluginCatalogSettings>
  saveCatalogSettings(downloadSource: L2PluginDownloadSource): Promise<L2PluginCatalogSettings>
  update(source: string): Promise<L2PluginManagementSnapshot>
  del(source: string): Promise<L2PluginManagementSnapshot>
  reload(mode?: 'normal' | 'basic'): Promise<L2PluginManagementSnapshot>
  apply(sources?: string[]): Promise<L2PluginManagementSnapshot>
}

async function request<T>(
  clientId: string,
  path: string,
  body: unknown,
  schema: ZodType<T>
): Promise<T> {
  return requestL4Api(clientId, path, body, schema, { fallbackMessage: '插件管理请求失败' })
}

export function createL2PluginManagementBiz(
  clientId: string,
  appSocket: Pick<L4AppSocketClient, 'subscribe'>
): L2PluginManagementBiz {
  return {
    subscribeChanges: (listener) =>
      appSocket.subscribe(L2PluginManagementChangedContract, listener),
    list: (checkUpdates = false) =>
      request(
        clientId,
        '/api/plugins/list',
        L2PluginManagementListRequestSchema.parse(checkUpdates ? { checkUpdates: true } : {}),
        L2PluginManagementSnapshotSchema
      ),
    get: (source) =>
      request(
        clientId,
        '/api/plugins/get',
        L2PluginManagementSourceRequestSchema.parse({ source }),
        L2PluginManagementDetailSchema
      ),
    add: (input) =>
      request(
        clientId,
        '/api/plugins/add',
        L2PluginManagementInstallRequestSchema.parse(input),
        L2PluginManagementSnapshotSchema
      ),
    setEnabled: (source, enabled) =>
      request(
        clientId,
        '/api/plugins/enabled-set',
        L2PluginManagementEnabledRequestSchema.parse({ source, enabled }),
        L2PluginManagementSnapshotSchema
      ),
    searchCatalog: (input) =>
      request(
        clientId,
        '/api/plugin-catalog/search',
        L2PluginCatalogSearchRequestSchema.parse(input),
        L2PluginCatalogSearchResultSchema
      ),
    getCatalog: (input) =>
      request(
        clientId,
        '/api/plugin-catalog/get',
        L2PluginCatalogGetRequestSchema.parse(input),
        L2PluginCatalogDetailSchema
      ),
    getCatalogSettings: () =>
      request(clientId, '/api/plugin-catalog/settings-get', {}, L2PluginCatalogSettingsSchema),
    saveCatalogSettings: (downloadSource) =>
      request(
        clientId,
        '/api/plugin-catalog/settings-replace',
        L2PluginCatalogSettingsRequestSchema.parse({ downloadSource }),
        L2PluginCatalogSettingsSchema
      ),
    update: (source) =>
      request(
        clientId,
        '/api/plugins/update',
        L2PluginManagementSourceRequestSchema.parse({ source }),
        L2PluginManagementSnapshotSchema
      ),
    del: (source) =>
      request(
        clientId,
        '/api/plugins/del',
        L2PluginManagementSourceRequestSchema.parse({ source }),
        L2PluginManagementSnapshotSchema
      ),
    reload: (mode) =>
      request(
        clientId,
        '/api/plugins/reload',
        L2PluginManagementReloadRequestSchema.parse({ mode }),
        L2PluginManagementSnapshotSchema
      ),
    apply: (sources) =>
      request(
        clientId,
        '/api/plugins/apply',
        L2PluginManagementApplyRequestSchema.parse({ sources }),
        L2PluginManagementSnapshotSchema
      )
  }
}
