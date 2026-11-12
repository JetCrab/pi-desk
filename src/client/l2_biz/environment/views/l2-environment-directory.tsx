'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import type { L2EnvironmentState } from '../l2-environment-runtime'

export function L2EnvironmentDirectory({
  browser,
  disabled,
  onBrowse,
  onChoose,
  onClose
}: {
  browser: NonNullable<L2EnvironmentState['browser']>
  disabled: boolean
  onBrowse: (cwd: string | null) => void
  onChoose: (cwd: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [path, setPath] = useState('')
  const listing = browser.listing
  return (
    <section
      aria-label={t('environment.browser')}
      className="min-w-0 space-y-3 rounded-xl border bg-muted/40 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{t('environment.browser')}</h4>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t('environment.closeBrowser')}
        </Button>
      </div>
      <p className="break-all text-sm text-muted-foreground">{browser.from}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || browser.loading}
          onClick={() => onBrowse(null)}
        >
          {t('environment.root')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || browser.loading || !listing?.cwd}
          onClick={() => onBrowse(listing?.parentCwd ?? null)}
        >
          {t('environment.parent')}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label={t('environment.target')}
          placeholder={t('environment.target')}
          value={path}
          disabled={disabled}
          className="min-w-0 flex-1 basis-48"
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              path.trim() &&
              !browser.loading
            ) {
              event.preventDefault()
              onBrowse(path.trim())
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || browser.loading || !path.trim()}
          onClick={() => onBrowse(path.trim())}
        >
          {t('environment.openDirectory')}
        </Button>
      </div>
      {browser.loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common:loading')}
        </p>
      ) : null}
      {browser.error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {browser.error}
        </p>
      ) : null}
      {listing ? (
        <>
          <p className="break-all font-mono text-sm">{listing.cwd ?? t('environment.root')}</p>
          <ul className="max-h-64 space-y-1 overflow-auto" aria-label={t('environment.browser')}>
            {listing.directories.map((entry) => (
              <li key={entry.cwd}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-8 w-full justify-start whitespace-normal text-left [overflow-wrap:anywhere]"
                  disabled={disabled}
                  onClick={() => onBrowse(entry.cwd)}
                >
                  {entry.name}
                </Button>
              </li>
            ))}
          </ul>
          {!listing.directories.length ? (
            <p className="text-sm text-muted-foreground">{t('environment.emptyDirectory')}</p>
          ) : null}
          <Button
            type="button"
            disabled={disabled || !listing.cwd}
            onClick={() => {
              if (listing.cwd) onChoose(listing.cwd)
            }}
          >
            {t('environment.useDirectory')}
          </Button>
        </>
      ) : null}
    </section>
  )
}
