import { revealL3ProjectPath } from '@client/l3_modules/project-files/l3-project-file-actions'
import {
  createL3ProjectReader,
  requestL3Project
} from '@client/l3_modules/project-files/l3-project-reader'
import {
  L2PiDirectoryListRequestSchema,
  L2PiDirectoryListResponseSchema,
  L2PiDirectoryEntryListRequestSchema,
  L2PiDirectoryEntryListResponseSchema,
  type L2PiDirectoryListResponse,
  type L2PiDirectoryEntryListResponse
} from '@common/l2_biz/pi-session/l2-pi-session-contract'
import { L3ProjectFileRuntime } from '@client/l3_modules/project-files/l3-project-file-runtime'
import { L3ProjectGitRuntime } from '@client/l3_modules/project-files/l3-project-git-runtime'
import { readL3ImagePreviewMode } from '@client/l3_modules/preferences/l3-work-session-file-preferences'
import { L2ProjectHistoryRuntime } from './runtime/l2-project-history-runtime'
import type { L2ProjectPreviewGlobal, L2ProjectPreviewProject } from './l2-project-preview-storage'

export function listL2PreviewProjects(
  clientId: string,
  signal: AbortSignal
): Promise<L2PiDirectoryListResponse> {
  return requestL3Project(
    clientId,
    {
      path: '/api/pi/directories/list',
      request: L2PiDirectoryListRequestSchema,
      response: L2PiDirectoryListResponseSchema
    },
    { forceRefresh: false },
    signal
  )
}

export function browseL2PreviewDirectory(
  clientId: string,
  cwd: string | null,
  signal: AbortSignal
): Promise<L2PiDirectoryEntryListResponse> {
  return requestL3Project(
    clientId,
    {
      path: '/api/pi/directory-entries/list',
      request: L2PiDirectoryEntryListRequestSchema,
      response: L2PiDirectoryEntryListResponseSchema
    },
    { cwd },
    signal
  )
}

export interface L2ProjectPreviewOwner {
  files: L3ProjectFileRuntime
  git: L3ProjectGitRuntime
  history: L2ProjectHistoryRuntime
  restore(): void
  dispose(): void
}
export function createL2ProjectPreviewOwner(
  clientId: string,
  cwd: string,
  onNotice: (message: string) => void,
  initial: L2ProjectPreviewProject | null,
  global: L2ProjectPreviewGlobal,
  options: { lazyHistory?: boolean; onUnauthorized?: () => void } = {}
): L2ProjectPreviewOwner {
  const reader = createL3ProjectReader(clientId, { cwd }, options.onUnauthorized)
  const files = new L3ProjectFileRuntime(cwd, reader, {
    imagePreviewMode: readL3ImagePreviewMode,
    onNotice,
    reveal: (path, targetType = 'file') => revealL3ProjectPath(clientId, { cwd }, path, targetType),
    maxTabs: 20
  })
  const git = new L3ProjectGitRuntime(cwd, reader)
  const history = new L2ProjectHistoryRuntime(reader, files)
  let restored = false
  return {
    files,
    git,
    history,
    restore(): void {
      if (restored) return
      restored = true
      git.setLayout(cwd, global.treeLayout)
      if (!initial) return
      git.setChangesOnly(cwd, initial.changesOnly)
      for (const root of initial.expandedRepositories) git.toggleRepository(cwd, root)
      files.restoreBrowsing(initial)
      history.restoreBrowsing(initial.history, !options.lazyHistory)
    },
    dispose(): void {
      history.dispose()
      git.dispose()
      files.dispose()
    }
  }
}
