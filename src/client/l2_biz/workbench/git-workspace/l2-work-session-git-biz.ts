import {
  L2WorkSessionGitBranchAddRequestSchema,
  L2WorkSessionGitBranchOperationResponseSchema,
  L2WorkSessionGitBranchReplaceRequestSchema,
  L2WorkSessionGitBranchesListRequestSchema,
  L2WorkSessionGitDiffGetRequestSchema,
  L2WorkSessionGitGetRequestSchema,
  type L2WorkSessionGitBranchAddRequest,
  type L2WorkSessionGitBranchOperationResponse,
  type L2WorkSessionGitBranchReplaceRequest,
  type L2WorkSessionGitBranchesListRequest,
  type L2WorkSessionGitBranchesListResponse,
  type L2WorkSessionGitDiffGetRequest,
  type L2WorkSessionGitDiffGetResponse,
  type L2WorkSessionGitGetRequest,
  type L2WorkSessionGitGetResponse
} from '@common/l2_biz/work-session/l2-work-session-git-contract'
import type { z } from 'zod'
import type { L4ErrorTranslation } from '@common/l4_foundation/locale/l4-error-translation'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'
import { requestL3Project } from '@client/l3_modules/project-files/l3-project-reader'
import {
  L3ProjectGitGet,
  L3ProjectGitHeads,
  L3ProjectGitBranches,
  L3ProjectGitDiff
} from '@common/l3_modules/project-files/l3-project-files-contract'

interface ApiEnvelope<T> {
  code: number
  msg: string
  data: T | null
  i18n?: L4ErrorTranslation
}

export interface L2WorkSessionGitBiz {
  getHeads: (
    input: L2WorkSessionGitGetRequest,
    signal?: AbortSignal
  ) => Promise<z.infer<typeof L3ProjectGitHeads.response>>
  get: (
    input: L2WorkSessionGitGetRequest,
    signal?: AbortSignal
  ) => Promise<L2WorkSessionGitGetResponse>
  listBranches: (
    input: L2WorkSessionGitBranchesListRequest,
    signal?: AbortSignal
  ) => Promise<L2WorkSessionGitBranchesListResponse>
  replaceBranch: (
    input: L2WorkSessionGitBranchReplaceRequest,
    signal?: AbortSignal
  ) => Promise<L2WorkSessionGitBranchOperationResponse>
  addBranch: (
    input: L2WorkSessionGitBranchAddRequest,
    signal?: AbortSignal
  ) => Promise<L2WorkSessionGitBranchOperationResponse>
  getDiff: (
    input: L2WorkSessionGitDiffGetRequest,
    signal?: AbortSignal
  ) => Promise<L2WorkSessionGitDiffGetResponse>
}

export function createL2WorkSessionGitBiz(clientId: string): L2WorkSessionGitBiz {
  async function request<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pi-Desk-Client-Id': clientId
      },
      body: JSON.stringify(body),
      signal
    })
    const envelope = (await response.json()) as ApiEnvelope<unknown>
    if (!response.ok || envelope.code !== 0 || envelope.data === null) {
      throw new Error(envelope.msg ? l4LocalizedErrorMessage(envelope) : 'Git 请求失败')
    }
    return schema.parse(envelope.data)
  }

  return {
    getHeads: (input, signal) => requestL3Project(clientId, L3ProjectGitHeads, input, signal),
    get: (input, signal) =>
      requestL3Project(
        clientId,
        L3ProjectGitGet,
        { ...L2WorkSessionGitGetRequestSchema.parse(input), refresh: true },
        signal
      ),
    listBranches: async (input, signal) => {
      const { head, recent, local, remote } = await requestL3Project(
        clientId,
        L3ProjectGitBranches,
        L2WorkSessionGitBranchesListRequestSchema.parse(input),
        signal
      )
      return { head, recent, local, remote }
    },
    replaceBranch: (input, signal) =>
      request(
        '/api/work-session-git-branch/replace',
        L2WorkSessionGitBranchReplaceRequestSchema.parse(input),
        L2WorkSessionGitBranchOperationResponseSchema,
        signal
      ),
    addBranch: (input, signal) =>
      request(
        '/api/work-session-git-branch/add',
        L2WorkSessionGitBranchAddRequestSchema.parse(input),
        L2WorkSessionGitBranchOperationResponseSchema,
        signal
      ),
    getDiff: async (input, signal) => {
      const result = await requestL3Project(
        clientId,
        L3ProjectGitDiff,
        L2WorkSessionGitDiffGetRequestSchema.parse(input),
        signal
      )
      if (result.kind === 'metadata') return { kind: 'binary' }
      return result
    }
  }
}
