'use client'

import { CheckIcon, CircleAlertIcon, CopyIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import styles from './l2-work-session-columns.module.css'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger
} from '@client/l4_foundation/ui/shadcn/popover'

export function L2WorkbenchInitializationNotice({
  error,
  copied,
  reloading,
  canReload,
  onCopy,
  onReload
}: {
  error: string
  copied: boolean
  reloading: boolean
  canReload: boolean
  onCopy: () => void
  onReload: () => void
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('initializationDegraded')}
            title={t('initializationDegraded')}
            className={cn(styles.headerAction, 'text-xs text-destructive hover:text-destructive')}
          />
        }
      >
        <CircleAlertIcon className={cn(styles.headerActionIcon, 'size-4')} aria-hidden="true" />
        <span className={styles.headerActionLabel}>{t('initializationDegraded')}</span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        alignOffset={8}
        className="max-h-[min(28rem,var(--available-height))] w-[28rem] gap-0 overflow-hidden p-0"
        initialFocus={(interaction) => interaction === 'keyboard'}
      >
        <PopoverTitle className="shrink-0 border-b px-3 py-2">
          {t('initializationDetails')}
        </PopoverTitle>
        <pre
          className="min-h-0 overflow-auto overscroll-contain whitespace-pre-wrap break-words p-3 font-mono text-sm leading-[1.6]"
          aria-label={t('initializationDetails')}
        >
          {error}
        </pre>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t px-3 py-2">
          <Button variant="outline" size="sm" onClick={onCopy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? t('copied') : t('copyInitializationError')}
          </Button>
          <Button size="sm" disabled={!canReload} onClick={onReload}>
            {reloading ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
            {reloading ? t('reloadingPi') : t('reloadPi')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
