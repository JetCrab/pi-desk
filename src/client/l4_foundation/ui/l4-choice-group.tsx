'use client'

import { CheckIcon } from 'lucide-react'
import type { ComponentType, KeyboardEvent } from 'react'
import { cn } from '@client/l4_foundation/lib/l4-utils'

interface L4ChoiceOption<T extends string> {
  value: T
  label: string
  description?: string
  icon?: ComponentType<{ className?: string }>
  testId?: string
}

interface L4ChoiceGroupProps<T extends string> {
  label: string
  value: T
  options: readonly L4ChoiceOption<T>[]
  onChange: (value: T) => void
  layout?: 'list' | 'segmented'
  disabled?: boolean
}

export function L4ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  layout = 'list',
  disabled = false
}: L4ChoiceGroupProps<T>): React.JSX.Element {
  const hasSelection = options.some((option) => option.value === value)
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey)
      return
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key)
      ? 1
      : ['ArrowLeft', 'ArrowUp'].includes(event.key)
        ? -1
        : 0
    if (!direction && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const current = Math.max(
      0,
      options.findIndex((option) => option.value === value)
    )
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (current + direction + options.length) % options.length
    const option = options[next]
    if (!option) return
    onChange(option.value)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn(
        layout === 'segmented'
          ? 'inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-muted p-0.5'
          : 'grid gap-2'
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (!hasSelection && index === 0) ? 0 : -1}
            disabled={disabled}
            data-testid={option.testId}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex min-w-0 cursor-pointer items-center gap-2 text-left text-sm leading-5 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              layout === 'segmented'
                ? 'min-h-7 rounded-md px-2 py-0.5'
                : 'min-h-9 rounded-lg border border-transparent px-3 py-2',
              selected
                ? layout === 'segmented'
                  ? 'bg-card text-card-foreground shadow-sm'
                  : 'border-border bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-foreground/8 hover:text-foreground'
            )}
          >
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{option.label}</span>
              {option.description ? (
                <span className="mt-1 block text-sm font-normal text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </span>
            {layout === 'list' ? (
              <CheckIcon
                aria-hidden="true"
                className={cn('size-4 shrink-0', !selected && 'invisible')}
              />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
