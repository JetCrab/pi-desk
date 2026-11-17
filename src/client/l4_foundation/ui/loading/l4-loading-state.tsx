import type { HTMLAttributes } from 'react'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { L4LoadingSpinner } from './l4-loading-spinner'

export function L4LoadingState({
  compact = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { compact?: boolean }): React.JSX.Element {
  return (
    <div
      role="status"
      {...props}
      className={cn(
        'flex min-w-0 items-center justify-center text-sm text-muted-foreground',
        compact ? 'gap-2 py-2' : 'min-h-40 flex-1 flex-col gap-3 px-4 py-8 text-center',
        className
      )}
    >
      <L4LoadingSpinner
        aria-hidden="true"
        className={compact ? 'size-4 shrink-0' : 'size-6 shrink-0'}
      />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}
