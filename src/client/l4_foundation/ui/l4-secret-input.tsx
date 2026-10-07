'use client'

import { EyeIcon, EyeOffIcon } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Input } from '@client/l4_foundation/ui/shadcn/input'

type L4SecretInputProps = Omit<
  React.ComponentProps<typeof Input>,
  'type' | 'autoComplete' | 'autoCapitalize' | 'spellCheck'
>

function L4SecretInput({
  className,
  disabled,
  id,
  ...props
}: L4SecretInputProps): React.JSX.Element {
  const { t } = useTranslation('common')
  const [visible, setVisible] = React.useState(false)
  const actionLabel = t(visible ? 'hideSecret' : 'revealSecret')

  return (
    <div className="relative min-w-0">
      <Input
        {...props}
        id={id}
        disabled={disabled}
        type="text"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className={cn('pr-9', !visible && '[-webkit-text-security:disc]', className)}
      />
      <button
        type="button"
        className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        aria-label={actionLabel}
        aria-controls={id}
        aria-pressed={visible}
        title={actionLabel}
        disabled={disabled}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </button>
    </div>
  )
}

export { L4SecretInput }
