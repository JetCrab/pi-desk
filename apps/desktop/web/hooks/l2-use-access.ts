import { useEffect, useRef, useState } from 'react'
import {
  deleteAccessPort,
  openAccessUrl,
  readAccessSettings,
  saveAccessConnection,
  saveAccessPort,
  setAccessEnabled,
  setAccessMode,
  type PortDraft
} from '../l2-access-biz'
import { copyDesktopText } from '../l2-desktop-biz'
import { errorMessage, type TunnelConnection, type TunnelMode } from '../l4-desktop-ipc'
import { useDesktopAction } from './l2-use-desktop-action'

export function useAccess(
  refresh: () => void,
  onDirty: (dirty: boolean) => void
): {
  connection: TunnelConnection | null
  configured: boolean | null
  settingsOpen: boolean
  editor: PortDraft | null
  loadError: string
  error: string
  errorTarget: string
  busy: boolean
  copied: string
  patchConnection: (value: Partial<TunnelConnection>) => void
  openSettings: () => void
  closeSettings: () => void
  edit: (value: PortDraft | null) => void
  reload: () => void
  saveConnection: () => Promise<void>
  savePort: () => Promise<void>
  toggle: (kind: PortDraft['kind'], localPort: number, enabled: boolean) => void
  remove: (kind: PortDraft['kind'], localPort: number) => Promise<void>
  setMode: (mode: TunnelMode) => void
  copy: (text: string, target?: string) => void
  openUrl: (url: string, target?: string) => void
} {
  const [connection, setConnection] = useState<TunnelConnection | null>(null)
  const savedConnection = useRef<TunnelConnection | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editor, setEditor] = useState<PortDraft | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [copied, setCopied] = useState('')
  const [errorTarget, setErrorTarget] = useState('page')
  const action = useDesktopAction(refresh)
  useEffect(() => {
    let disposed = false
    void readAccessSettings().then(
      (value) => {
        if (disposed) return
        savedConnection.current = value
        setConnection(value)
        setConfigured(Boolean(value.controlServerUrl.trim() && value.controlKey.trim()))
      },
      (cause: unknown) => {
        if (!disposed) setLoadError(errorMessage(cause))
      }
    )
    return () => {
      disposed = true
    }
  }, [reloadKey])
  return {
    connection,
    configured,
    settingsOpen,
    editor,
    loadError,
    error: action.error,
    errorTarget,
    busy: action.busy,
    copied,
    patchConnection: (value) => {
      setConnection((current) => (current ? { ...current, ...value } : null))
      onDirty(true)
      action.clearError()
    },
    openSettings: () => {
      setConnection(savedConnection.current)
      setSettingsOpen(true)
      action.clearError()
    },
    closeSettings: () => {
      setConnection(savedConnection.current)
      setSettingsOpen(false)
      onDirty(Boolean(editor))
      action.clearError()
    },
    edit: (value) => {
      setEditor(value)
      onDirty(Boolean(value))
      action.clearError()
    },
    reload: () => {
      setLoadError('')
      setReloadKey((value) => value + 1)
    },
    saveConnection: async () => {
      if (!connection) return
      setErrorTarget('settings')
      if (await action.run(() => saveAccessConnection(connection))) {
        savedConnection.current = connection
        setConfigured(true)
        setSettingsOpen(false)
        onDirty(Boolean(editor))
      }
    },
    savePort: async () => {
      if (!editor) return
      setErrorTarget('editor')
      if (await action.run(() => saveAccessPort(editor))) {
        setEditor(null)
        onDirty(false)
      }
    },
    toggle: (kind, localPort, enabled) => {
      setErrorTarget(`${kind}:${localPort}`)
      void action.run(() => setAccessEnabled(kind, localPort, enabled))
    },
    remove: async (kind, localPort) => {
      setErrorTarget(`${kind}:${localPort}`)
      await action.run(() => deleteAccessPort(kind, localPort))
    },
    setMode: (mode) => {
      setErrorTarget('mode')
      void action.run(() => setAccessMode(mode))
    },
    copy: (text, target = 'page') => {
      setErrorTarget(target)
      void action.run(async () => {
        await copyDesktopText(text)
        setCopied(text)
      })
    },
    openUrl: (url, target = 'page') => {
      setErrorTarget(target)
      void action.run(() => openAccessUrl(url))
    }
  }
}
