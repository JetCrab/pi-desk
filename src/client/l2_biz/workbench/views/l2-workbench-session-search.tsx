'use client'

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { SlidersHorizontalIcon } from 'lucide-react'
import type { L3PiSessionSearchScope } from '@common/l3_modules/pi/l3-pi-session-search-contract'
import { buttonVariants } from '@client/l4_foundation/ui/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@client/l4_foundation/ui/shadcn/dropdown-menu'

const SEARCH_SCOPE_OPTIONS: ReadonlyArray<{ value: L3PiSessionSearchScope; label: string }> = [
  { value: 'title', label: 'scopeTitle' },
  { value: 'user', label: 'scopeUser' },
  { value: 'assistant', label: 'scopeAssistant' },
  { value: 'sessionId', label: 'Session ID' }
]

export function L2WorkbenchSessionSearchScopes({
  value,
  onChange,
  disabled = false,
  compact = false
}: {
  value: readonly L3PiSessionSearchScope[]
  onChange: (value: readonly L3PiSessionSearchScope[]) => void
  disabled?: boolean
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('workbenchPicker')
  const toggle = (scope: L3PiSessionSearchScope): void => {
    if (value.includes(scope)) {
      if (value.length > 1) onChange(value.filter((item) => item !== scope))
    } else {
      onChange([...value, scope])
    }
  }
  if (compact) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              data-testid="work-session-search-scopes"
              type="button"
              disabled={disabled}
              aria-label={t('searchScopes')}
              title={t('searchScopes')}
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
            >
              <SlidersHorizontalIcon className="size-4" />
            </button>
          }
        />
        <DropdownMenuContent align="end">
          {SEARCH_SCOPE_OPTIONS.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={value.includes(option.value)}
              disabled={disabled || (value.length === 1 && value.includes(option.value))}
              closeOnClick={false}
              onCheckedChange={() => toggle(option.value)}
            >
              {t(option.label)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  return (
    <fieldset className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-0.5">
      <legend className="mr-1 text-xs text-muted-foreground">{t('searchScopes')}</legend>
      {SEARCH_SCOPE_OPTIONS.map((option) => {
        const checked = value.includes(option.value)
        return (
          <label
            key={option.value}
            className="flex min-h-7 cursor-pointer items-center gap-2 text-sm text-muted-foreground has-[:focus-visible]:rounded-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled || (checked && value.length === 1)}
              onChange={() => toggle(option.value)}
              className="size-4 accent-primary"
            />
            <span>{t(option.label)}</span>
          </label>
        )
      })}
    </fieldset>
  )
}

export function highlightL2WorkbenchSessionSearchText(
  text: string,
  query: string,
  markClassName = 'bg-accent text-accent-foreground'
): ReactNode {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return text
  const normalizedText = text.toLocaleLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let matchIndex = normalizedText.indexOf(normalizedQuery)
  while (matchIndex >= 0) {
    if (matchIndex > cursor) parts.push(text.slice(cursor, matchIndex))
    const matchEnd = matchIndex + normalizedQuery.length
    parts.push(
      <mark key={`${matchIndex}-${matchEnd}`} className={`rounded-sm px-px ${markClassName}`}>
        {text.slice(matchIndex, matchEnd)}
      </mark>
    )
    cursor = matchEnd
    matchIndex = normalizedText.indexOf(normalizedQuery, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.length ? parts : text
}
