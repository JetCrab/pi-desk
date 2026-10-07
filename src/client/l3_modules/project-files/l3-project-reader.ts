import type { z } from 'zod'
import type { L4ErrorTranslation } from '@common/l4_foundation/locale/l4-error-translation'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'
import * as contract from '@common/l3_modules/project-files/l3-project-files-contract'
import type {
  L4ProjectFileList,
  L4ProjectFileSearch,
  L4ProjectFileContent,
  L4ProjectFileImagePreviewMode
} from '@common/l4_foundation/file/l4-project-file-contract'
import type { L4GitRepository } from '@common/l4_foundation/git/l4-git-contract'
import type {
  L4GitReadBranches,
  L4GitLog,
  L4GitLogQuery,
  L4GitChanges,
  L4GitChangesQuery,
  L4GitHistoricalDiff,
  L4GitPreviewDiff
} from '@common/l4_foundation/git/l4-git-history-contract'

export class L3ProjectRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
    readonly errorKey: string | null = null
  ) {
    super(message)
    this.name = 'L3ProjectRequestError'
  }
}

export async function requestL3Project<I, O>(
  clientId: string,
  api: { path: string; request: z.ZodType<I>; response: z.ZodType<O> },
  input: I,
  signal?: AbortSignal
): Promise<O> {
  const response = await fetch(api.path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
    body: JSON.stringify(api.request.parse(input)),
    signal
  })
  const envelope = (await response.json()) as {
    code: number
    msg: string
    data: unknown
    i18n?: L4ErrorTranslation
  }
  if (!response.ok || envelope.code !== 0 || envelope.data === null) {
    throw new L3ProjectRequestError(
      response.status,
      envelope.code,
      envelope.msg ? l4LocalizedErrorMessage(envelope) : '项目读取失败',
      envelope.i18n?.key ?? null
    )
  }
  return api.response.parse(envelope.data)
}

export interface L3ProjectFileReader {
  list(path: string, signal?: AbortSignal): Promise<L4ProjectFileList>
  search(query: string, signal?: AbortSignal): Promise<L4ProjectFileSearch>
  get(
    path: string,
    imagePreviewMode: L4ProjectFileImagePreviewMode,
    signal?: AbortSignal
  ): Promise<L4ProjectFileContent>
  diff(
    root: string,
    path: string,
    signal?: AbortSignal,
    comparison?: L4GitHistoricalDiff
  ): Promise<L4GitPreviewDiff>
}
export interface L3ProjectReader extends L3ProjectFileReader {
  snapshot(signal?: AbortSignal, refresh?: boolean): Promise<{ repositories: L4GitRepository[] }>
  branches(root: string, signal?: AbortSignal): Promise<L4GitReadBranches>
  log(root: string, query: L4GitLogQuery, signal?: AbortSignal): Promise<L4GitLog>
  changes(root: string, query: L4GitChangesQuery, signal?: AbortSignal): Promise<L4GitChanges>
}

export function createL3ProjectReader(
  clientId: string,
  context: contract.L3ProjectReadContext
): L3ProjectReader {
  return {
    list: (path, signal) =>
      requestL3Project(clientId, contract.L3ProjectFileList, { ...context, path }, signal),
    search: (query, signal) =>
      requestL3Project(clientId, contract.L3ProjectFileSearch, { ...context, query }, signal),
    get: (path, imagePreviewMode, signal) =>
      requestL3Project(
        clientId,
        contract.L3ProjectFileGet,
        { ...context, path, imagePreviewMode },
        signal
      ),
    snapshot: (signal, refresh) =>
      requestL3Project(clientId, contract.L3ProjectGitGet, { ...context, refresh }, signal),
    branches: (repositoryRoot, signal) =>
      requestL3Project(
        clientId,
        contract.L3ProjectGitBranches,
        { ...context, repositoryRoot },
        signal
      ),
    log: (repositoryRoot, query, signal) =>
      requestL3Project(
        clientId,
        contract.L3ProjectGitLog,
        { ...context, repositoryRoot, ...query },
        signal
      ),
    changes: (repositoryRoot, query, signal) =>
      requestL3Project(
        clientId,
        contract.L3ProjectGitChanges,
        { ...context, repositoryRoot, ...query },
        signal
      ),
    diff: (repositoryRoot, path, signal, comparison) =>
      requestL3Project(
        clientId,
        contract.L3ProjectGitDiff,
        { ...context, repositoryRoot, path, comparison },
        signal
      )
  }
}
