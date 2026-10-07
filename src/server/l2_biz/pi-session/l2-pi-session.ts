import 'server-only'

import {
  L2PiDirectoryEntryListResponseSchema,
  L2PiDirectoryIgnoreListResponseSchema,
  L2PiDirectoryIgnoreReplaceResponseSchema,
  L2PiDirectoryListResponseSchema,
  L2PiSessionHistoryResponseSchema,
  L2PiSessionUserMessageListResponseSchema,
  type L2PiDirectoryEntryListResponse,
  type L2PiDirectoryIgnoreListResponse,
  type L2PiDirectoryIgnoreReplaceResponse,
  type L2PiDirectoryListResponse,
  type L2PiSessionHistoryQuery,
  type L2PiSessionHistoryResponse,
  type L2PiSessionUserMessageListRequest,
  type L2PiSessionUserMessageListResponse
} from '@common/l2_biz/pi-session/l2-pi-session-contract'
import { listL4PiDirectoryEntries } from '@server/l4_foundation/pi/l4-pi-directory-browser'
import { replaceL4PiDirectoryIgnore } from '@server/l4_foundation/pi/l4-pi-directory-ignore-store'
import {
  listL4IgnoredPiDirectories,
  listL4PiDirectories,
  listL4PiSessionHistory,
  listL4PiSessionUserMessages
} from '@server/l4_foundation/pi/l4-pi-session-catalog'

export async function listL2PiDirectories(
  forceRefresh: boolean
): Promise<L2PiDirectoryListResponse> {
  return L2PiDirectoryListResponseSchema.parse({
    directories: await listL4PiDirectories(forceRefresh)
  })
}

export async function listL2IgnoredPiDirectories(
  forceRefresh: boolean
): Promise<L2PiDirectoryIgnoreListResponse> {
  return L2PiDirectoryIgnoreListResponseSchema.parse({
    directories: await listL4IgnoredPiDirectories(forceRefresh)
  })
}

export function replaceL2PiDirectoryIgnore(
  cwd: string,
  ignored: boolean
): L2PiDirectoryIgnoreReplaceResponse {
  replaceL4PiDirectoryIgnore(cwd, ignored)
  return L2PiDirectoryIgnoreReplaceResponseSchema.parse({})
}

export async function listL2PiDirectoryEntries(
  cwd: string | null
): Promise<L2PiDirectoryEntryListResponse> {
  return L2PiDirectoryEntryListResponseSchema.parse(await listL4PiDirectoryEntries(cwd))
}

export class L2PiSessionHistoryNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Pi session history was not found: ${sessionId}`)
    this.name = 'L2PiSessionHistoryNotFoundError'
  }
}

export async function listL2PiSessionHistory(
  input: L2PiSessionHistoryQuery
): Promise<L2PiSessionHistoryResponse> {
  return L2PiSessionHistoryResponseSchema.parse({
    cwd: input.cwd,
    sessions: await listL4PiSessionHistory(
      input.cwd,
      input.query,
      input.forceRefresh,
      input.searchIn
    )
  })
}

export async function listL2PiSessionUserMessages(
  input: L2PiSessionUserMessageListRequest
): Promise<L2PiSessionUserMessageListResponse> {
  const response = await listL4PiSessionUserMessages(input)
  if (!response) throw new L2PiSessionHistoryNotFoundError(input.sessionId)
  return L2PiSessionUserMessageListResponseSchema.parse(response)
}
