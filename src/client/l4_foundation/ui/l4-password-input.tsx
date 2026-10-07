'use client'

import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Input } from './shadcn/input'

export function L4PasswordInput({
  className,
  disabled,
  id,
  ...props
}: Omit<ComponentProps<typeof Input>, 'type'>): React.JSX.Element {
  const { t } = useTranslation('common')
  const [visible, setVisible] = useState(false)
  const action = t(visible ? 'hidePassword' : 'showPassword')
  return (
    <div className="relative min-w-0">
      <Input
        {...props}
        id={id}
        disabled={disabled}
        type={visible ? 'text' : 'password'}
        autoCapitalize="none"
        spellCheck={false}
        className={cn('pr-9', className)}
      />
      <button
        type="button"
        className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
        aria-label={action}
        aria-controls={id}
        aria-pressed={visible}
        title={action}
        disabled={disabled}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? (
          <EyeOffIcon className="size-4" aria-hidden="true" />
        ) : (
          <EyeIcon className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  )
}
