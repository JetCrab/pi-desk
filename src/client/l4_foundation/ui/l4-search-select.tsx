'use client'

import { ChevronsUpDownIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@client/l4_foundation/ui/shadcn/command'
import { Popover, PopoverContent, PopoverTrigger } from '@client/l4_foundation/ui/shadcn/popover'
import { cn } from '@client/l4_foundation/lib/l4-utils'

export interface L4SearchSelectOption {
  value: string
  label: string
  description?: string
}

interface L4SearchSelectProps {
  value: string
  options: L4SearchSelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
}

export function L4SearchSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled = false,
  className
}: L4SearchSelectProps): React.JSX.Element {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            disabled={disabled}
            className={cn(
              'w-full min-w-0 justify-between border-input px-2.5 font-normal focus-visible:-outline-offset-2',
              className
            )}
          >
            <span className={cn('min-w-0 truncate', !selected && 'text-muted-foreground')}>
              {selected?.label ?? placeholder ?? t('selectPlaceholder')}
            </span>
            <ChevronsUpDownIcon className="text-muted-foreground" />
          </Button>
        }
      />

      <PopoverContent
        align="start"
        sideOffset={4}
        positionerClassName="z-[120]"
        className="w-(--anchor-width) max-w-[calc(100vw-2rem)] gap-0 p-0"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder ?? t('searchPlaceholder')} autoFocus />
          <CommandList className="max-h-[min(20rem,var(--available-height))]">
            <CommandEmpty>{emptyText ?? t('noMatches')}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.description ?? ''} ${option.value}`}
                  data-checked={option.value === value ? 'true' : undefined}
                  onSelect={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
