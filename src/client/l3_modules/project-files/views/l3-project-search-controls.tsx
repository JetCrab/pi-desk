'use client'

import { SearchIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import type { L4ProjectSearchInput } from '@common/l4_foundation/file/l4-project-file-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@client/l4_foundation/ui/shadcn/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@client/l4_foundation/ui/shadcn/tooltip'

type SearchOptions = Partial<Omit<L4ProjectSearchInput, 'query'>>

interface L3ProjectSearchControlsProps {
  input: L4ProjectSearchInput
  inputRef: Ref<HTMLInputElement>
  invalid: boolean
  onQueryChange: (query: string) => void
  onOptionsChange: (options: SearchOptions) => void
  onComposingChange: (composing: boolean) => void
  onClose: () => void
  onOpenFirst: () => void
  onFocusResults: () => void
}

const SCOPES = ['all', 'files', 'content'] as const
const OPTIONS = [
  { key: 'caseSensitive', label: 'searchCaseSensitive', text: 'Aa' },
  { key: 'wholeWord', label: 'searchWholeWord', text: 'Ab' },
  { key: 'regex', label: 'searchRegex', text: '.*' }
] as const

export function L3ProjectSearchControls({
  input,
  inputRef,
  invalid,
  onQueryChange,
  onOptionsChange,
  onComposingChange,
  onClose,
  onOpenFirst,
  onFocusResults
}: L3ProjectSearchControlsProps): React.JSX.Element {
  const { t } = useTranslation('projectFiles')
  const [composition, setComposition] = useState<string | null>(null)
  const composing = useRef(false)
  useEffect(() => () => onComposingChange(false), [onComposingChange])
  const placeholder = t(
    input.scope === 'files'
      ? 'searchFiles'
      : input.scope === 'content'
        ? 'searchContent'
        : 'searchAll'
  )

  return (
    <div className="shrink-0 px-1 pt-1">
      <InputGroup className="rounded-md">
        <InputGroupAddon className="pl-1.5 py-0">
          <SearchIcon className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          data-testid="project-file-search"
          className="min-h-7 min-w-0 px-1.5 py-0.5 text-sm placeholder:text-xs"
          value={composition ?? input.query}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            if (composing.current) setComposition(event.target.value)
            else onQueryChange(event.target.value)
          }}
          onCompositionStart={(event) => {
            composing.current = true
            setComposition(event.currentTarget.value)
            onComposingChange(true)
          }}
          onCompositionEnd={(event) => {
            composing.current = false
            setComposition(null)
            onQueryChange(event.currentTarget.value)
            onComposingChange(false)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || composing.current) return
            if (event.key === 'Enter') {
              event.preventDefault()
              onOpenFirst()
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              onFocusResults()
            }
          }}
        />
        <InputGroupAddon align="inline-end" className="pr-0.5 py-0 has-[>button]:mr-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <InputGroupButton
                  size="icon-xs"
                  className="min-h-7"
                  aria-label={t('closeSearch')}
                  onClick={onClose}
                />
              }
            >
              <XIcon className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t('closeSearch')}</TooltipContent>
          </Tooltip>
        </InputGroupAddon>
      </InputGroup>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-1">
        <div className="flex min-w-0 items-center" role="radiogroup" aria-label={t('searchScope')}>
          {SCOPES.map((scope, index) => (
            <Button
              key={scope}
              type="button"
              role="radio"
              aria-checked={input.scope === scope}
              tabIndex={input.scope === scope ? 0 : -1}
              disabled={composition !== null}
              variant="ghost"
              size="sm"
              data-testid={`project-search-scope-${scope}`}
              className={cn(
                'px-1 text-xs',
                input.scope === scope && 'bg-accent text-accent-foreground'
              )}
              onClick={() => onOptionsChange({ scope })}
              onKeyDown={(event) => {
                const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
                const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                if (!forward && !backward && event.key !== 'Home' && event.key !== 'End') return
                event.preventDefault()
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? 2
                      : (index + (forward ? 1 : 2)) % 3
                onOptionsChange({ scope: SCOPES[next] })
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                  [next]?.focus()
              }}
            >
              {t(
                scope === 'all'
                  ? 'searchScopeAll'
                  : scope === 'files'
                    ? 'searchScopeFiles'
                    : 'searchScopeContent'
              )}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex items-center">
          {OPTIONS.map(({ key, label, text }) => (
            <Tooltip key={key}>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={composition !== null}
                    aria-label={t(label)}
                    aria-pressed={input[key]}
                    data-testid={`project-search-option-${key}`}
                    className={cn(
                      'font-mono text-xs text-muted-foreground',
                      key === 'wholeWord' && 'underline underline-offset-4'
                    )}
                    onClick={() => onOptionsChange({ [key]: !input[key] })}
                  />
                }
              >
                {text}
              </TooltipTrigger>
              <TooltipContent>{t(label)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  )
}
