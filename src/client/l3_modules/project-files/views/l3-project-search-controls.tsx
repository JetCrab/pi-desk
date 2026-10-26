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
    <div className="shrink-0 border-b px-2.5 py-2">
      <div className="rounded-lg border border-input bg-card p-1 focus-within:border-ring focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring">
        <div className="flex min-h-7 items-center justify-between gap-1">
          <div
            className="flex min-w-0 items-center gap-1"
            role="radiogroup"
            aria-label={t('searchScope')}
          >
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
                  'min-h-7 px-2 text-xs',
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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 shrink-0"
                  aria-label={t('closeSearch')}
                  onClick={onClose}
                />
              }
            >
              <XIcon className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t('closeSearch')}</TooltipContent>
          </Tooltip>
        </div>
        <InputGroup className="min-h-8 rounded-none border-0 bg-transparent has-[[data-slot=input-group-control]:focus-visible]:outline-none">
          <InputGroupAddon className="pl-1.5 py-0">
            <SearchIcon className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            data-testid="project-file-search"
            className="min-w-0 px-1.5 text-sm placeholder:text-xs"
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
          <InputGroupAddon align="inline-end" className="gap-0 pr-1 py-0">
            {OPTIONS.map(({ key, label, text }) => (
              <Tooltip key={key}>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      size="icon-xs"
                      disabled={composition !== null}
                      aria-label={t(label)}
                      aria-pressed={input[key]}
                      data-testid={`project-search-option-${key}`}
                      className={cn(
                        'border border-transparent font-mono text-xs text-muted-foreground',
                        key === 'wholeWord' && 'underline underline-offset-4',
                        input[key] && 'border-input bg-accent text-accent-foreground'
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
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  )
}
