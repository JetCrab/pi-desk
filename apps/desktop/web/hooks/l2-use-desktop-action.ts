import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../l4-desktop-ipc'

export function useDesktopAction(refresh: () => void): {
  busy: boolean
  error: string
  clearError: () => void
  run: (operation: () => Promise<void>) => Promise<boolean>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const run = async (operation: () => Promise<void>): Promise<boolean> => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await operation()
      if (mounted.current) refresh()
      return true
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause))
      return false
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return { busy, error, clearError: () => setError(''), run }
}
