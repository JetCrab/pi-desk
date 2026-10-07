import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, getControlState, type ControlState } from './l4-desktop-ipc'

export function useControlState(): {
  state: ControlState | null
  readError: string
  refreshing: boolean
  refresh: () => void
} {
  const [state, setState] = useState<ControlState | null>(null)
  const [readError, setReadError] = useState('')
  const [listenError, setListenError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const reader = useRef<(() => void) | null>(null)
  const refresh = useCallback(() => reader.current?.(), [])

  useEffect(() => {
    let disposed = false
    let pending = false
    let reading = false
    let unlisten: (() => void) | undefined

    const requestRead = (): void => {
      pending = true
      if (reading) return
      reading = true
      setRefreshing(true)
      void (async () => {
        while (pending && !disposed) {
          pending = false
          try {
            const next = await getControlState()
            if (!disposed) {
              setState(next)
              setReadError('')
            }
          } catch (cause) {
            if (!disposed) setReadError(errorMessage(cause))
          }
        }
        reading = false
        if (!disposed) setRefreshing(false)
      })()
    }
    reader.current = requestRead
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') requestRead()
    }
    document.addEventListener('visibilitychange', onVisible)
    void listen('desktop-state-changed', requestRead)
      .then((stop) => {
        if (disposed) stop()
        else {
          unlisten = stop
          requestRead()
        }
      })
      .catch((cause: unknown) => {
        if (disposed) return
        setListenError(`状态监听失败：${errorMessage(cause)}`)
        requestRead()
      })

    return () => {
      disposed = true
      reader.current = null
      document.removeEventListener('visibilitychange', onVisible)
      unlisten?.()
    }
  }, [])

  return { state, readError: listenError || readError, refreshing, refresh }
}
