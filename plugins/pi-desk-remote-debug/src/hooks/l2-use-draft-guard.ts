import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserSettingsPageTarget } from '@jetcrab/pi-desk-sdk/browser'

export function useDraftGuard(
  target: BrowserSettingsPageTarget,
  dirty: boolean,
  busy: boolean
): {
  confirming: boolean
  protect(hasChanges: boolean, action: () => void): void
  answer(allow: boolean): void
} {
  const [confirming, setConfirming] = useState(false)
  const resolver = useRef<((allow: boolean) => void) | null>(null)
  const ask = useCallback((): Promise<boolean> => {
    resolver.current?.(false)
    setConfirming(true)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])
  useEffect(() => {
    target.setBeforeLeave(() => {
      if (busy) return false
      return dirty ? ask() : true
    })
    return (): void => {
      target.setBeforeLeave(null)
    }
  }, [target, dirty, busy, ask])
  useEffect(
    () => () => {
      resolver.current?.(false)
      resolver.current = null
    },
    []
  )
  function answer(allow: boolean): void {
    setConfirming(false)
    resolver.current?.(allow)
    resolver.current = null
  }
  function protect(hasChanges: boolean, action: () => void): void {
    if (busy) return
    if (!hasChanges) action()
    else
      void ask().then((allow) => {
        if (allow) action()
      })
  }
  return { confirming, protect, answer }
}
