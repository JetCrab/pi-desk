'use client'

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import type { L2WorkbenchBiz } from '../l2-workbench-biz'

interface L2WorkSessionRename {
  open: boolean
  title: string
  saving: boolean
  error: string | null
  show: (workSession: L2WorkSessionListItem) => void
  close: () => void
  setTitle: (title: string) => void
  save: () => Promise<void>
}

export function useL2WorkSessionRename(
  biz: Pick<L2WorkbenchBiz, 'renameWorkSession'>,
  disabled: boolean
): L2WorkSessionRename {
  const { t } = useTranslation('workbench')
  const [target, setTarget] = useState<Pick<L2WorkSessionListItem, 'workId' | 'sessionId'> | null>(
    null
  )
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const show = useCallback((workSession: L2WorkSessionListItem): void => {
    setTarget({ workId: workSession.workId, sessionId: workSession.sessionId })
    setTitle(workSession.sessionTitle ?? '')
    setError(null)
  }, [])

  const close = (): void => {
    if (!saving) setTarget(null)
  }

  const save = async (): Promise<void> => {
    const trimmedTitle = title.trim()
    if (!target || saving || disabled || !trimmedTitle) return
    setSaving(true)
    setError(null)
    try {
      await biz.renameWorkSession({ ...target, title: trimmedTitle })
      setTarget(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('renameSessionFailed'))
    } finally {
      setSaving(false)
    }
  }

  return { open: target !== null, title, saving, error, show, close, setTitle, save }
}
