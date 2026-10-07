'use client'

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckIcon, ListFilterIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react'
import { PluginCheckbox, PluginSurface } from '@jetcrab/pi-desk-sdk/react/base'
import {
  isCapabilityAllowed,
  type CapabilityOption,
  type CapabilityRule
} from '@jetcrab/pi-desk-sdk/capabilities'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { cn } from '@client/l4_foundation/lib/l4-utils'

type PolicyKind = 'all' | 'allow' | 'deny' | 'none'
const POLICIES: Array<{ key: PolicyKind; label: string }> = [
  { key: 'all', label: 'policyAll' },
  { key: 'allow', label: 'policyAllow' },
  { key: 'deny', label: 'policyDeny' },
  { key: 'none', label: 'policyNone' }
]

function policyKind(rule: CapabilityRule): PolicyKind {
  if (rule.allow !== undefined) return rule.allow.length === 0 ? 'none' : 'allow'
  return rule.deny?.length ? 'deny' : 'all'
}

interface RulePickerProps {
  label: string
  rule: CapabilityRule
  options: readonly CapabilityOption[]
  disabled: boolean
  onChange: (rule: CapabilityRule) => void
}

export function L2CapabilityRulePicker({
  label,
  rule,
  options,
  disabled,
  onChange
}: RulePickerProps): React.JSX.Element {
  const { t } = useTranslation('capabilityModes')
  const [kind, setKind] = useState<PolicyKind>(() => policyKind(rule))
  const [exclude, setExclude] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [visibleCount, setVisibleCount] = useState(160)
  const [manual, setManual] = useState<string[]>(() => [
    ...new Set([...(rule.allow ?? []), ...(rule.deny ?? [])])
  ])
  const side = kind === 'deny' || kind === 'all' || (kind === 'allow' && exclude) ? 'deny' : 'allow'
  const selected = rule[side] ?? []
  const selectedSet = new Set(selected)
  const values = useMemo(() => {
    const map = new Map(options.map((option) => [option.value, option]))
    for (const value of [...manual, ...(rule.allow ?? []), ...(rule.deny ?? [])]) {
      if (!map.has(value)) map.set(value, { value })
    }
    return [...map.values()].sort((left, right) => left.value.localeCompare(right.value))
  }, [manual, options, rule.allow, rule.deny])
  const needle = query.trim()
  const filtered = values.filter((option) => {
    if (selectedOnly && !selectedSet.has(option.value)) return false
    return (
      !needle ||
      `${option.value} ${option.label ?? ''} ${option.description ?? ''}`
        .toLowerCase()
        .includes(needle.toLowerCase()) ||
      (needle.includes('*') && isCapabilityAllowed({ allow: [needle] }, option.value))
    )
  })
  const shown = filtered.slice(0, visibleCount)
  const canAdd = needle.length > 0 && needle.length <= 256 && !selectedSet.has(needle)

  function changeKind(next: PolicyKind): void {
    setKind(next)
    setExclude(false)
    setSelectedOnly(false)
    if (next === 'all') onChange({})
    else if (next === 'none') onChange({ allow: [] })
    else if (next === 'deny') onChange({ deny: rule.deny ?? [] })
    else onChange({ allow: rule.allow ?? [], ...(rule.deny?.length ? { deny: rule.deny } : {}) })
  }

  function replaceSelected(next: string[]): void {
    if (kind === 'all' && next.length > 0) setKind('deny')
    if (kind === 'none' && next.length > 0) setKind('allow')
    onChange({ ...rule, [side]: next })
  }

  function toggle(value: string, checked: boolean): void {
    replaceSelected(
      checked ? [...new Set([...selected, value])] : selected.filter((item) => item !== value)
    )
  }

  function add(): void {
    if (!canAdd || disabled) return
    setManual((current) => [...new Set([...current, needle])])
    toggle(needle, true)
    setQuery('')
  }

  return (
    <PluginSurface
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t('ruleEditor', { name: label })}
    >
      <div className="shrink-0 space-y-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label={t('ruleMode', { name: label })}
          >
            {POLICIES.map((item) => (
              <Button
                key={item.key}
                size="sm"
                variant={kind === item.key ? 'secondary' : 'ghost'}
                aria-pressed={kind === item.key}
                disabled={disabled}
                onClick={() => changeKind(item.key)}
              >
                {kind === item.key && <CheckIcon className="size-3.5" />}
                {t(item.label)}
              </Button>
            ))}
          </div>
          {kind === 'allow' && (
            <Button
              size="sm"
              variant={exclude ? 'secondary' : 'ghost'}
              disabled={disabled}
              aria-pressed={exclude}
              onClick={() => {
                setExclude(!exclude)
                setSelectedOnly(false)
              }}
            >
              {t('exclusions')}
              {rule.deny?.length ? ` · ${rule.deny.length}` : ''}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t('ruleSearch')}
              placeholder={t('ruleSearchPlaceholder')}
              maxLength={256}
              className="pl-9 pr-9"
              value={query}
              disabled={disabled}
              onChange={(event) => {
                setQuery(event.target.value)
                setVisibleCount(160)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  add()
                }
              }}
            />
            {query && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('clearSearch')}
                className="absolute right-0.5 top-1/2 -translate-y-1/2"
                onClick={() => setQuery('')}
              >
                <XIcon className="size-3.5" />
              </Button>
            )}
          </div>
          <Button
            size="sm"
            variant={selectedOnly ? 'secondary' : 'ghost'}
            aria-pressed={selectedOnly}
            onClick={() => setSelectedOnly(!selectedOnly)}
          >
            <ListFilterIcon className="size-4" />
            <span className="hidden @min-[420px]:inline">{t('selectedOnly')}</span>
            <span className="@min-[420px]:hidden">{t('selectedShort')}</span>
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {t(side === 'allow' ? 'allowRules' : 'excludeRules')} ·{' '}
            {t('selectedCount', { count: selected.length })}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || shown.length === 0}
              onClick={() =>
                replaceSelected([...new Set([...selected, ...shown.map((option) => option.value)])])
              }
            >
              {t('selectVisible')}
            </Button>
            {selected.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => replaceSelected([])}
              >
                {t('clearSelected')}
              </Button>
            )}
          </div>
        </div>
      </div>
      <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {canAdd && (
          <Button
            variant="outline"
            disabled={disabled}
            className="mb-3 h-auto min-h-9 max-w-full justify-start"
            onClick={add}
          >
            <PlusIcon className="size-4 shrink-0" />
            {t('addRule')} <span className="min-w-0 truncate font-mono">{needle}</span>
          </Button>
        )}
        <div className="grid min-w-0 grid-cols-1 gap-1 @min-[620px]:grid-cols-2">
          {shown.map((option) => {
            const checked = selectedSet.has(option.value)
            return (
              <label
                key={option.value}
                className={cn(
                  'flex min-h-9 min-w-0 cursor-pointer items-start gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted',
                  checked && 'bg-accent text-accent-foreground',
                  disabled && 'pointer-events-none opacity-50'
                )}
              >
                <PluginCheckbox
                  checked={checked}
                  disabled={disabled}
                  aria-label={t(side === 'allow' ? 'allowValue' : 'excludeValue', {
                    name: option.value
                  })}
                  className="mt-1 shrink-0"
                  onChange={(event) => toggle(option.value, event.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-all text-sm font-medium">
                    {option.label ?? option.value}
                  </span>
                  {option.label && option.label !== option.value && (
                    <span className="block break-all font-mono text-xs text-muted-foreground">
                      {option.value}
                    </span>
                  )}
                  {option.description ? (
                    <details
                      className="mt-0.5 text-xs leading-5 text-muted-foreground"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <summary className="line-clamp-1 cursor-pointer list-none">
                        {option.description}
                      </summary>
                      <span className="block whitespace-pre-wrap break-words pt-1 text-sm">
                        {option.description}
                      </span>
                    </details>
                  ) : option.value.includes('*') ? (
                    <span className="block text-xs text-muted-foreground">{t('pattern')}</span>
                  ) : null}
                </span>
              </label>
            )
          })}
        </div>
        {shown.length === 0 && (
          <p className="px-3 py-6 text-sm text-muted-foreground">
            {needle ? t('noMatches') : selectedOnly ? t('noSelection') : t('enterPattern')}
          </p>
        )}
        {filtered.length > shown.length && (
          <Button
            variant="ghost"
            className="mt-3"
            onClick={() => setVisibleCount((count) => count + 160)}
          >
            {t('moreRules', { count: filtered.length - shown.length })}
          </Button>
        )}
      </div>
    </PluginSurface>
  )
}
