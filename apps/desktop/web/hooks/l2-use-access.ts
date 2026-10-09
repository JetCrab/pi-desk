import { useEffect, useState } from 'react'
import { readAccessSettings, saveAndStartAccess, type AccessDraft } from '../l2-access-biz'
import { copyDesktopText, runDesktopAction } from '../l2-desktop-biz'
import { errorMessage } from '../l4-desktop-ipc'
import { useDesktopAction } from './l2-use-desktop-action'

export function useAccess(
  url: string,
  refresh: () => void,
  onDirty: (dirty: boolean) => void
): {
  draft: AccessDraft | null
  loadError: string
  error: string
  busy: boolean
  copied: boolean
  patch: (value: Partial<AccessDraft>) => void
  reload: () => void
  save: () => Promise<boolean>
  start: () => void
  stop: () => void
  copy: (address: string) => void
} {
  const [draft, setDraft] = useState<AccessDraft | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [copied, setCopied] = useState(false)
  const action = useDesktopAction(refresh)
  useEffect(() => {
    let disposed = false
    void readAccessSettings(url).then(
      (value) => {
        if (!disposed) setDraft(value)
      },
      (cause: unknown) => {
        if (!disposed) setLoadError(errorMessage(cause))
      }
    )
    return () => {
      disposed = true
    }
  }, [url, reloadKey])
  return {
    draft,
    loadError,
    error: action.error,
    busy: action.busy,
    copied,
    patch: (value) => {
      setDraft((current) => (current ? { ...current, ...value } : null))
      action.clearError()
      setCopied(false)
      onDirty(true)
    },
    reload: () => {
      setLoadError('')
      setDraft(null)
      setReloadKey((value) => value + 1)
    },
    save: async () => {
      if (!draft) return false
      const accepted = await action.run(() => saveAndStartAccess(url, draft))
      if (accepted) onDirty(false)
      return accepted
    },
    start: () => {
      void action.run(() => runDesktopAction('start-tunnel', url))
    },
    stop: () => {
      void action.run(() => runDesktopAction('stop-tunnel', url))
    },
    copy: (address) => {
      void action.run(async () => {
        await copyDesktopText(address)
        setCopied(true)
      })
    }
  }
}
