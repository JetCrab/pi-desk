'use client'

import { L4LoadingSpinner } from '@client/l4_foundation/ui/loading/l4-loading-spinner'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@client/l4_foundation/lib/l4-utils'

interface L2WorkbenchEmptyStateProps {
  variant: 'select-session' | 'loading'
  className?: string
  children?: ReactNode
}

export function L2WorkbenchEmptyState({
  variant,
  className,
  children
}: L2WorkbenchEmptyStateProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return (
    <div
      className={cn(
        '@container/empty-state flex size-full min-h-0 flex-1 items-center justify-center overflow-hidden px-6 py-8 text-center',
        className
      )}
    >
      {variant === 'select-session' ? (
        <div className="relative">
          {children}
          <h1 className="text-base font-medium text-muted-foreground">{t('emptySelectSession')}</h1>
        </div>
      ) : (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col items-center gap-3 animate-in fade-in-0 fill-mode-both delay-150 duration-150 motion-reduce:animate-none"
        >
          <L4LoadingSpinner className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium text-muted-foreground">{t('emptyLoading')}</p>
        </div>
      )}
    </div>
  )
}
