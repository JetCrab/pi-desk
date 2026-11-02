'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { L4Locale } from '@common/l4_foundation/locale/l4-locale'
import { useL4AppSocket } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { L4SearchSelect } from '@client/l4_foundation/ui/l4-search-select'
import { useL4ConfirmDialog } from '@client/l4_foundation/ui/l4-confirm-dialog'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'
import {
  changeL3RegionLanguage,
  changeL3RegionTimeZone,
  listL3RegionTimeZones
} from '@client/l3_modules/region/l3-region-biz'

export function L2RegionSettings({
  canLeave
}: {
  canLeave?: () => boolean | Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const region = useL4Region()
  const { appSocket } = useL4AppSocket()
  const { confirm, dialog } = useL4ConfirmDialog()
  const [changingLanguage, setChangingLanguage] = useState(false)
  const languagePending = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [sampleTime, setSampleTime] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setSampleTime(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const timeZones = useMemo(
    () => [
      ...listL3RegionTimeZones().map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') }))
    ],
    []
  )

  const chooseLanguage = async (value: L4Locale): Promise<void> => {
    if (languagePending.current) return
    languagePending.current = true
    setChangingLanguage(true)
    setError(null)
    try {
      const result = await changeL3RegionLanguage(
        value,
        () =>
          confirm({
            title: t('language'),
            description: t('common:reloadConfirm'),
            confirmLabel: t('common:reload'),
            confirmVariant: 'default'
          }),
        appSocket,
        canLeave
      )
      if (result === 'save-failed') setError(t('common:localeError'))
      if (result === 'blocked') setError(t('common:reloadBlocked'))
    } finally {
      languagePending.current = false
      setChangingLanguage(false)
    }
  }

  const chooseTimeZone = async (value: string): Promise<void> => {
    setError((await changeL3RegionTimeZone(value, appSocket)) ? null : t('common:timeZoneError'))
  }

  return (
    <section className="@container min-w-0 space-y-6" aria-labelledby="region-settings-title">
      {dialog}
      <h2 id="region-settings-title" className="text-xl font-semibold">
        {t('region')}
      </h2>
      <div className="grid max-w-[40rem] gap-6 @min-[32rem]:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <label className="block text-sm font-medium" htmlFor="region-language">
            {t('language')}
          </label>
          <Select
            value={region.localePreference}
            disabled={changingLanguage}
            onValueChange={(value) => {
              if (value === 'zh-CN' || value === 'en') void chooseLanguage(value)
            }}
          >
            <SelectTrigger id="region-language" className="w-full">
              <SelectValue>
                {region.localePreference === 'zh-CN' ? t('common:chinese') : 'English'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent positionerClassName="z-[120]">
              <SelectItem value="zh-CN">{t('common:chinese')}</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t('currentLanguage', { locale: region.locale })}
          </p>
          {region.pendingLocale && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-muted-foreground">{t('common:languagePending')}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={changingLanguage}
                onClick={() => void chooseLanguage(region.localePreference)}
              >
                {t('reloadLanguage')}
              </Button>
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-2">
          <span className="block text-sm font-medium">{t('timeZone')}</span>
          <L4SearchSelect
            value={region.timeZonePreference}
            options={timeZones}
            onChange={(value) => void chooseTimeZone(value)}
            ariaLabel={t('timeZone')}
            searchPlaceholder={t('searchTimeZones')}
            emptyText={t('common:unavailable')}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            {t('currentTimeZone', { timeZone: region.timeZone })}
          </p>
        </div>
      </div>
      <div className="space-y-1 rounded-xl bg-muted p-4">
        <p className="text-xs text-muted-foreground">{t('timeExample')}</p>
        <p className="text-sm font-medium tabular-nums">
          {new Intl.DateTimeFormat(region.locale === 'en' ? 'en-US' : 'zh-CN', {
            timeZone: region.timeZone,
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
          }).format(sampleTime)}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
