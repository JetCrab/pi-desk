'use client'

import { useEffect, type RefObject } from 'react'

// 只在进入可见预览或窗口重新激活时读取；计时器仅合并同一次激活事件。
export function useL3ProjectRefresh(
  host: RefObject<HTMLElement | null>,
  refresh: () => void,
  active = true
): void {
  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const visible = (): boolean =>
      document.visibilityState === 'visible' &&
      Boolean(host.current?.getClientRects().length) &&
      !host.current?.closest('[inert], [aria-hidden="true"]')
    const run = (): void => {
      timer = undefined
      if (visible()) refresh()
    }
    const onFocus = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (visible()) timer = setTimeout(run, 150)
    }
    run()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [active, host, refresh])
}
