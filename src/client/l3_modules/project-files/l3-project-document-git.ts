'use client'

import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import type { L3ProjectFileRuntime } from './l3-project-file-runtime'
import type { L3ProjectGitBrowser } from './l3-project-git-runtime'
import { findL3GitFile } from './l3-project-git-model'

export function useL3ProjectDocumentGit(
  runtime: L3ProjectFileRuntime,
  git: L3ProjectGitBrowser,
  host: RefObject<HTMLDivElement | null>,
  savePosition: () => void,
  active: boolean,
  refreshOnFocus = true
): { refresh: () => void; unavailable: boolean } {
  useSyncExternalStore(git.subscribe, git.getRevision, git.getRevision)
  const snapshot = git.getWorkspace(runtime.cwd)?.snapshot
  const path = runtime.state.activePath
  const diffActive = Boolean(runtime.state.activeDiff)
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

  useEffect(() => {
    if (!refreshOnFocus || !active || !path || diffActive) return
    const visible = (): boolean =>
      window.document.visibilityState === 'visible' &&
      Boolean(host.current?.getClientRects().length) &&
      !host.current?.closest('[inert], [aria-hidden="true"]')
    let lastRefresh = Date.now()
    if (visible()) {
      // 已打开的标签重新展示时重读；首次打开仍复用正在进行的正文请求。
      if (runtime.state.documents.get(path)?.status === 'text') {
        save.current()
        runtime.reloadFile(path)
      }
      void git.refreshSnapshot(runtime.cwd)
    }
    const onFocus = (): void => {
      if (!visible() || Date.now() - lastRefresh < 1000) return
      lastRefresh = Date.now()
      refresh()
    }
    window.addEventListener('focus', onFocus)
    window.document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.document.removeEventListener('visibilitychange', onFocus)
    }
  }, [active, diffActive, git, host, path, refresh, refreshOnFocus, runtime])

  useEffect(() => {
    if (!active || !path || diffActive || document?.status !== 'text') return
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
