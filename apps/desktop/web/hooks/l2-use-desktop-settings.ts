import { useEffect, useState } from 'react'
import { readDesktopSettings, saveDesktopSettings, type SettingsDraft } from '../l2-desktop-biz'
import { errorMessage } from '../l4-desktop-ipc'

export function useDesktopSettings(
  originalUrl: string | null,
  onDirty: (dirty: boolean) => void
): {
  draft: SettingsDraft | null
  loadError: string
  saveError: string
  saving: boolean
  patch: (value: Partial<SettingsDraft>) => void
  reload: () => void
  save: () => Promise<{ url: string | null } | null>
} {
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let disposed = false
    void readDesktopSettings(originalUrl).then(
      (next) => {
        if (!disposed) setDraft(next)
      },
      (error: unknown) => {
        if (!disposed) setLoadError(errorMessage(error))
      }
    )
    return () => {
      disposed = true
    }
  }, [originalUrl, reloadKey])
  const patch = (value: Partial<SettingsDraft>): void => {
    setDraft((current) => (current ? { ...current, ...value } : null))
    setSaveError('')
    onDirty(true)
  }
  const save = async (): Promise<{ url: string | null } | null> => {
    if (!draft || loadError || saving) return null
    setSaving(true)
    setSaveError('')
    try {
      return { url: await saveDesktopSettings(originalUrl, draft) }
    } catch (cause) {
      setSaveError(errorMessage(cause))
      return null
    } finally {
      setSaving(false)
    }
  }
  return {
    draft,
    loadError,
    saveError,
    saving,
    patch,
    reload: () => {
      setLoadError('')
      setDraft(null)
      setReloadKey((key) => key + 1)
    },
    save
  }
}
