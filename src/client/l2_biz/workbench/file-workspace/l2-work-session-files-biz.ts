import {
  L2WorkSessionFileListRequestSchema,
  L2WorkSessionFileSearchRequestSchema,
  L2WorkSessionFileGetRequestSchema,
  L2WorkSessionFileRevealRequestSchema,
  type L2WorkSessionFileListRequest,
  type L2WorkSessionFileListResponse,
  type L2WorkSessionFileSearchRequest,
  type L2WorkSessionFileSearchResponse,
  type L2WorkSessionFileGetRequest,
  type L2WorkSessionFileGetResponse,
  type L2WorkSessionFileRevealRequest,
  type L2WorkSessionFileRevealResponse
} from '@common/l2_biz/work-session/l2-work-session-file-contract'
import {
  L3ProjectFileList,
  L3ProjectFileSearch,
  L3ProjectFileGet,
  L3ProjectFileReveal
} from '@common/l3_modules/project-files/l3-project-files-contract'
import {
  L3ProjectRequestError,
  requestL3Project
} from '@client/l3_modules/project-files/l3-project-reader'
import { createL4Base64ImageBlob } from '@client/l4_foundation/media/l4-base64-image'
export { L3ProjectRequestError as L2WorkSessionFileRequestError } from '@client/l3_modules/project-files/l3-project-reader'

export interface L2WorkSessionFilesBiz {
  list(
    input: L2WorkSessionFileListRequest,
    signal?: AbortSignal
  ): Promise<L2WorkSessionFileListResponse>
  search(
    input: L2WorkSessionFileSearchRequest,
    signal?: AbortSignal
  ): Promise<L2WorkSessionFileSearchResponse>
  get(
    input: L2WorkSessionFileGetRequest,
    signal?: AbortSignal
  ): Promise<L2WorkSessionFileGetResponse>
  reveal(input: L2WorkSessionFileRevealRequest): Promise<L2WorkSessionFileRevealResponse>
}

export async function readL2WorkSessionImage(
  biz: L2WorkSessionFilesBiz,
  input: Pick<L2WorkSessionFileGetRequest, 'workId' | 'cwd' | 'path'>,
  signal: AbortSignal
): Promise<Blob | null> {
  try {
    const content = await biz.get({ ...input, imagePreviewMode: 'compressed' }, signal)
    if (content.kind !== 'image') throw new Error('该文件不是可展示的图片')
    return createL4Base64ImageBlob(content)
  } catch (error) {
    if (error instanceof L3ProjectRequestError && error.errorKey === 'errors:fileMissing') {
      return null
    }
    throw error
  }
}

export function createL2WorkSessionFilesBiz(clientId: string): L2WorkSessionFilesBiz {
  return {
    // 会话入口始终校验必需的 workId；不能因共享接口可省略而丢失来源保护。
    list: (input, signal) =>
      requestL3Project(
        clientId,
        L3ProjectFileList,
        L2WorkSessionFileListRequestSchema.parse(input),
        signal
      ),
    search: (input, signal) =>
      requestL3Project(
        clientId,
        L3ProjectFileSearch,
        L2WorkSessionFileSearchRequestSchema.parse(input),
        signal
      ),
    get: (input, signal) =>
      requestL3Project(
        clientId,
        L3ProjectFileGet,
        L2WorkSessionFileGetRequestSchema.parse(input),
        signal
      ),
    reveal: (input) =>
      requestL3Project(
        clientId,
        L3ProjectFileReveal,
        L2WorkSessionFileRevealRequestSchema.parse(input)
      )
  }
}
