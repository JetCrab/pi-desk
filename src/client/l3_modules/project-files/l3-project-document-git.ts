'use client'

import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import type { L3ProjectFileRuntime } from './l3-project-file-runtime'
import type { L3ProjectGitBrowser } from './l3-project-git-runtime'
import { findL3GitFile } from './l3-project-git-model'
import { useL3ProjectRefresh } from './l3-use-project-refresh'

export function useL3ProjectDocumentGit(
  runtime: L3ProjectFileRuntime,
  git: L3ProjectGitBrowser,
  host: RefObject<HTMLDivElement | null>,
  savePosition: () => void,
  active: boolean
): { refresh: () => void; unavailable: boolean } {
  useSyncExternalStore(git.subscribe, git.getRevision, git.getRevision)
  const snapshot = git.getWorkspace(runtime.cwd)?.snapshot
  const path = runtime.state.activePath
  const diff = runtime.state.activeDiff
  const diffActive = Boolean(diff)
  const document = path ? runtime.state.documents.get(path) : undefined
  const save = useRef(savePosition)
  useEffect(() => {
    save.current = savePosition
  }, [savePosition])
  const refresh = useCallback((): void => {
    if (!path || diffActive) return
    save.current()
    runtime.reloadFile(path)
    void git.refreshSnapshot(runtime.cwd)
  }, [diffActive, git, path, runtime])

  const refreshVisible = useCallback((): void => {
    if (diff) runtime.refreshDiff()
    else if (path) {
      save.current()
      void runtime.ensureDocument(path, true)
    }
    void git.refreshSnapshot(runtime.cwd)
  }, [diff, git, path, runtime])
  useL3ProjectRefresh(host, refreshVisible, active)

  useEffect(() => {
    if (!active || !path || diffActive || document?.status !== 'text') return
    if (snapshot?.status === 'loading') return
    const controller = new AbortController()
    const file =
      snapshot?.status === 'ready' ? findL3GitFile(runtime.cwd, path, snapshot.repositories) : null
    void runtime.compareFile(
      path,
      file?.repository.state === 'ready' && file.change
        ? { repositoryRoot: file.repository.root, path: file.change.path }
        : null,
      controller.signal
    )
    return () => controller.abort()
  }, [active, diffActive, document, path, runtime, snapshot])

  const file =
    path && snapshot?.status === 'ready'
      ? findL3GitFile(runtime.cwd, path, snapshot.repositories)
      : null
  return {
    refresh,
    unavailable: snapshot?.status === 'error' || file?.repository.state === 'unavailable'
  }
}
