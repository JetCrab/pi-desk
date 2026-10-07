'use client'

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { useL4Region } from './l4-region-provider'

export function L4RegionNotice(): null {
  const { pendingLocale } = useL4Region()
  const { t } = useTranslation('common')
  const toast = useL4AppToast()
  const notified = useRef<string | null>(null)

  useEffect(() => {
    if (!pendingLocale) {
      notified.current = null
      return
    }
    if (notified.current === pendingLocale) return
    notified.current = pendingLocale
    toast.show({ level: 'info', title: t('languagePendingNotice') })
  }, [pendingLocale, t, toast])

  return null
}
