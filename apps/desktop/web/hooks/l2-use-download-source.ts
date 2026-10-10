import { useEffect, useState } from 'react'
import { errorMessage, getEnvironmentDownloadSource, type DownloadSource } from '../l4-desktop-ipc'

export function useDownloadSource(enabled = true): {
  downloadSource: DownloadSource | null
  loading: boolean
  loadError: string
  reload: () => void
  updateDownloadSource: (source: DownloadSource) => void
} {
  const [downloadSource, setDownloadSource] = useState<DownloadSource | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let active = true
    void getEnvironmentDownloadSource().then(
      (source) => {
        if (!active) return
        setDownloadSource(source)
        setLoading(false)
      },
      (cause: unknown) => {
        if (!active) return
        const message = errorMessage(cause)
        console.error('读取下载源失败：', message)
        setLoadError(message)
        setLoading(false)
      }
    )
    return () => {
      active = false
    }
  }, [enabled, revision])

  return {
    downloadSource,
    loading,
    loadError,
    reload: () => {
      setLoading(true)
      setLoadError('')
      setRevision((value) => value + 1)
    },
    updateDownloadSource: setDownloadSource
  }
}
