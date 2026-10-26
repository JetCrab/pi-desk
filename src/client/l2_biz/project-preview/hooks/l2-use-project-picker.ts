'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  L2PiDirectoryListResponse,
  L2PiDirectoryEntryListResponse
} from '@common/l2_biz/pi-session/l2-pi-session-contract'
import { L3ProjectRequestError } from '@client/l3_modules/project-files/l3-project-reader'
import { browseL2PreviewDirectory, listL2PreviewProjects } from '../l2-project-preview-biz'

type Target = { view: 'projects' } | { view: 'browser'; cwd: string | null }
interface PickerState {
  target: Target
  projects: L2PiDirectoryListResponse['directories']
  browser: L2PiDirectoryEntryListResponse | null
  loading: boolean
  error: string | null
}
export interface L2ProjectPicker extends PickerState {
  showProjects: () => void
  browse: (cwd: string | null) => void
  retry: () => void
}

export function useL2ProjectPicker(clientId: string, onUnauthorized: () => void): L2ProjectPicker {
  const [state, setState] = useState<PickerState>({
    target: { view: 'projects' },
    projects: [],
    browser: null,
    loading: true,
    error: null
  })
  const pending = useRef<AbortController | null>(null)
  const load = useCallback(
    (target: Target): void => {
      pending.current?.abort()
      const controller = new AbortController()
      pending.current = controller
      setState((current) => ({ ...current, target, loading: true, error: null }))
      void (async (): Promise<void> => {
        try {
          if (target.view === 'projects') {
            const result = await listL2PreviewProjects(clientId, controller.signal)
            if (!controller.signal.aborted)
              setState((current) => ({ ...current, projects: result.directories, loading: false }))
          } else {
            const browser = await browseL2PreviewDirectory(clientId, target.cwd, controller.signal)
            if (!controller.signal.aborted)
              setState((current) => ({ ...current, browser, loading: false }))
          }
        } catch (cause) {
          if (controller.signal.aborted) return
          if (cause instanceof L3ProjectRequestError && cause.status === 401) onUnauthorized()
          setState((current) => ({
            ...current,
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause)
          }))
        }
      })()
    },
    [clientId, onUnauthorized]
  )

  useEffect(() => {
    load({ view: 'projects' })
    return () => pending.current?.abort()
  }, [load])

  return {
    ...state,
    showProjects: () => load({ view: 'projects' }),
    browse: (cwd) => load({ view: 'browser', cwd }),
    retry: () => load(state.target)
  }
}
