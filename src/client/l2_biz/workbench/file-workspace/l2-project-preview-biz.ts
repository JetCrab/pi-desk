import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import {
  L4_PROJECT_PREVIEW_PLUGIN_KEY,
  readL4ProjectPreviewState
} from '@common/l4_foundation/file/l4-project-preview-contract'
import type { L2WorkbenchChatRuntime } from '../l2-workbench-chat'
import type { L2GitWorkspaceRuntime } from '../git-workspace/l2-git-workspace-runtime'
import type { L2FileWorkspaceRuntime } from './l2-file-workspace-runtime'

export function syncL2ProjectPreviewGitReferences(
  files: L2FileWorkspaceRuntime,
  git: L2GitWorkspaceRuntime,
  sessions: readonly L2WorkSessionListItem[],
  focusedWorkId: string | null
): void {
  git.reconcileWorkSessions(
    sessions,
    focusedWorkId,
    sessions.flatMap(({ workId }) => files.getDirectories(workId).map((cwd) => ({ workId, cwd })))
  )
}

export function subscribeL2ProjectPreviewDirectories(
  chat: L2WorkbenchChatRuntime,
  files: L2FileWorkspaceRuntime,
  git: L2GitWorkspaceRuntime,
  getSessions: () => readonly L2WorkSessionListItem[],
  getFocusedWorkId: () => string | null
): () => void {
  const unsubscribeChat = chat.subscribeSourceEvents(({ source, event }, state) => {
    if (event.type !== 'session_sync' && event.type !== 'runtime_update') return
    files.applyPreviewDirectories(
      source,
      readL4ProjectPreviewState(state.runtime.plugins[L4_PROJECT_PREVIEW_PLUGIN_KEY])
    )
    syncL2ProjectPreviewGitReferences(files, git, getSessions(), getFocusedWorkId())
  })
  for (const session of getSessions()) {
    const state = chat.getSourceState(session)
    if (state.syncStatus === 'loading') continue
    files.applyPreviewDirectories(
      session,
      readL4ProjectPreviewState(state.runtime.plugins[L4_PROJECT_PREVIEW_PLUGIN_KEY])
    )
  }
  syncL2ProjectPreviewGitReferences(files, git, getSessions(), getFocusedWorkId())
  return unsubscribeChat
}
