import 'server-only'

import {
  L2ModelCatalogListResponseSchema,
  L2ModelSettingsGetResponseSchema,
  L2ProjectModelDefaultGetResponseSchema,
  type L2ModelCatalogListRequest,
  type L2ModelCatalogListResponse,
  type L2ModelSettingsGetResponse,
  type L2ModelSettingsReplaceRequest,
  type L2ProjectModelDefaultGetResponse,
  type L2ProjectModelDefaultReplaceRequest
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import {
  listL4ModelCatalog,
  readL4ModelSettings,
  readL4ProjectModelDefault,
  replaceL4ModelSettings,
  replaceL4ProjectModelDefault
} from '@server/l4_foundation/model-settings/l4-model-settings'

export async function getL2ModelSettings(): Promise<L2ModelSettingsGetResponse> {
  return L2ModelSettingsGetResponseSchema.parse(await readL4ModelSettings())
}

export async function replaceL2ModelSettings(input: L2ModelSettingsReplaceRequest): Promise<void> {
  await replaceL4ModelSettings(input)
}

export async function listL2ModelCatalog(
  input: L2ModelCatalogListRequest
): Promise<L2ModelCatalogListResponse> {
  return L2ModelCatalogListResponseSchema.parse(await listL4ModelCatalog(input))
}

export async function getL2ProjectModelDefault(
  cwd: string
): Promise<L2ProjectModelDefaultGetResponse> {
  return L2ProjectModelDefaultGetResponseSchema.parse(await readL4ProjectModelDefault(cwd))
}

export async function replaceL2ProjectModelDefault(
  input: L2ProjectModelDefaultReplaceRequest
): Promise<void> {
  await replaceL4ProjectModelDefault(input.cwd, input.default)
}
