import { useEffect, useRef, useState } from 'react'
import { errorMessage, getEnvironmentDownloadSource, type DownloadSource } from '../l4-desktop-ipc'

export function useDownloadSource(enabled: boolean): {
  downloadSource: DownloadSource
  selectDownloadSource: (source: DownloadSource) => void
  markStarted: () => void
} {
  const [downloadSource, setDownloadSource] = useState<DownloadSource>('official')
  const recommendationBlocked = useRef(false)

  useEffect(() => {
    if (!enabled) return
    let active = true
    void getEnvironmentDownloadSource().then(
      (source) => {
        if (active && !recommendationBlocked.current) setDownloadSource(source)
      },
      (cause: unknown) => {
        if (active) console.error('读取下载源推荐失败，保留当前选择：', errorMessage(cause))
      }
    )
    return () => {
      active = false
    }
  }, [enabled])

  const selectDownloadSource = (source: DownloadSource): void => {
    recommendationBlocked.current = true
    setDownloadSource(source)
  }
  const markStarted = (): void => {
    recommendationBlocked.current = true
  }

  return { downloadSource, selectDownloadSource, markStarted }
}
