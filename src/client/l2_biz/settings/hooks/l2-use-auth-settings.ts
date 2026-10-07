'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2AuthSettings } from '@common/l2_biz/auth/l2-auth-contract'
import { useL4AppSocket } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { useL4ConfirmDialog } from '@client/l4_foundation/ui/l4-confirm-dialog'
import { getL2AuthSettings, logoutL2Auth, replaceL2AuthSettings } from '../l2-auth-settings-biz'

interface AuthSettingsState {
  settings: L2AuthSettings | null
  loading: boolean
  saving: boolean
  signingOut: boolean
  error: string | null
  password: string
  setPassword: (value: string) => void
  retry: () => void
  save: () => Promise<void>
  disable: () => Promise<void>
  logout: () => Promise<void>
  dialog: React.JSX.Element | null
}

export function useL2AuthSettings(): AuthSettingsState {
  const { t } = useTranslation('auth')
  const { clientId } = useL4AppSocket()
  const { confirm, dialog } = useL4ConfirmDialog()
  const [settings, setSettings] = useState<L2AuthSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [password, setPassword] = useState('')
  const pending = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    void getL2AuthSettings(clientId, controller.signal)
      .then((snapshot) => {
        if (controller.signal.aborted) return
        setSettings(snapshot)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setError(cause instanceof Error ? cause.message : t('settingsFailed'))
        setLoading(false)
      })
    return () => controller.abort()
  }, [clientId, attempt, t])

  const save = async (): Promise<void> => {
    if (pending.current || !settings) return
    pending.current = true
    setSaving(true)
    setError(null)
    try {
      await replaceL2AuthSettings(clientId, { password })
    } catch (cause) {
      pending.current = false
      setSaving(false)
      setError(cause instanceof Error ? cause.message : t('settingsFailed'))
    }
  }

  const disable = async (): Promise<void> => {
    if (pending.current || !settings) return
    pending.current = true
    const confirmed = await confirm({
      title: t('disableTitle'),
      description: t('disableDescription'),
      confirmLabel: t('disable')
    })
    if (!confirmed) {
      pending.current = false
      return
    }
    setSaving(true)
    setError(null)
    try {
      await replaceL2AuthSettings(clientId, { password: null })
    } catch (cause) {
      pending.current = false
      setSaving(false)
      setError(cause instanceof Error ? cause.message : t('settingsFailed'))
    }
  }

  const logout = async (): Promise<void> => {
    if (pending.current || !settings?.enabled) return
    pending.current = true
    setSigningOut(true)
    setError(null)
    try {
      await logoutL2Auth(clientId)
    } catch (cause) {
      pending.current = false
      setSigningOut(false)
      setError(cause instanceof Error ? cause.message : t('logoutFailed'))
    }
  }

  return {
    settings,
    loading,
    saving,
    signingOut,
    error,
    password,
    setPassword,
    save,
    disable,
    logout,
    dialog,
    retry: () => {
      setLoading(true)
      setError(null)
      setAttempt((value) => value + 1)
    }
  }
}
