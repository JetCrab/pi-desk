import { useState } from 'react'
import { saveDesktopAddress } from '../l2-desktop-biz'
import { errorMessage } from '../l4-desktop-ipc'

export function useAddressEditor(
  originalUrl: string | null,
  onDirty: (dirty: boolean) => void
): {
  value: string
  error: string
  saving: boolean
  change: (value: string) => void
  save: () => Promise<string | null>
} {
  const [value, setValue] = useState(originalUrl ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const change = (next: string): void => {
    setValue(next)
    setError('')
    onDirty(next !== (originalUrl ?? ''))
  }
  const save = async (): Promise<string | null> => {
    if (saving) return null
    setSaving(true)
    setError('')
    try {
      const url = await saveDesktopAddress(originalUrl, value)
      onDirty(false)
      return url
    } catch (cause) {
      setError(errorMessage(cause))
      return null
    } finally {
      setSaving(false)
    }
  }
  return { value, error, saving, change, save }
}
