'use client'

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react'
import {
  isCapabilityAllowed,
  type CapabilityOption,
  type CapabilityRule
} from '@jetcrab/pi-desk-sdk/capabilities'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { Switch } from '@client/l4_foundation/ui/shadcn/switch'
import { L4ChoiceGroup } from '@client/l4_foundation/ui/l4-choice-group'
import {
  L4AppDialogContent,
  L4AppDialogDescription,
  L4AppDialogFooter,
  L4AppDialogHeader,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import { l2ToggleCapability } from '../l2-capability-modes-model'

interface RulePickerProps {
  label: string
  rule: CapabilityRule
  options: readonly CapabilityOption[]
  disabled: boolean
  readOnly: boolean
  query: string
  rulesOpen: boolean
  onQueryChange: (query: string) => void
  onRulesOpenChange: (open: boolean) => void
  onChange: (rule: CapabilityRule) => void
}

export function L2CapabilityRulePicker({
  label,
  rule,
  options,
  disabled,
  readOnly,
  query,
  rulesOpen,
  onQueryChange,
  onRulesOpenChange,
  onChange
}: RulePickerProps): React.JSX.Element {
  const { t } = useTranslation('capabilityModes')
  const [pattern, setPattern] = useState('')
  const [side, setSide] = useState<'allow' | 'deny'>('deny')
  const [visibleCount, setVisibleCount] = useState(160)
  const [confirmation, setConfirmation] = useState<{
    rule: CapabilityRule
    description: string
  } | null>(null)
  const locked = disabled || readOnly
  const values = useMemo(() => {
    const map = new Map(options.map((option) => [option.value, option]))
    for (const value of [...(rule.allow ?? []), ...(rule.deny ?? [])]) {
      if (!value.includes('*') && !map.has(value)) map.set(value, { value })
    }
    return [...map.values()]
  }, [options, rule.allow, rule.deny])
  const needle = query.trim().toLowerCase()
  const filtered = values.filter((option) =>
    `${option.value} ${option.label ?? ''} ${option.description ?? ''}`
      .toLowerCase()
      .includes(needle)
  )
  const shown = filtered.slice(0, visibleCount)
  const count = values.filter((option) => isCapabilityAllowed(rule, option.value)).length
  const ruleCount = (rule.allow?.length ?? 0) + (rule.deny?.length ?? 0)
  const replaceAll = (next: CapabilityRule): void => {
    if (rule.allow !== undefined || rule.deny?.length)
      setConfirmation({ rule: next, description: t('resetRulesDescription', { name: label }) })
    else onChange(next)
  }
  const toggle = (value: string, enabled: boolean): void => {
    const next = l2ToggleCapability(rule, value, enabled)
    if (next.removedPatterns.length)
      setConfirmation({
        rule: next.rule,
        description: t('removePatternsDescription', { patterns: next.removedPatterns.join(', ') })
      })
    else onChange(next.rule)
  }
  const addPattern = (): void => {
    const value = pattern.trim()
    if (!value || locked) return
    onChange({ ...rule, [side]: [...new Set([...(rule[side] ?? []), value])] })
    setPattern('')
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={t('ruleEditor', { name: label })}>
      <div className="shrink-0 space-y-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-40 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t('capabilitySearch')}
              placeholder={t('capabilitySearch')}
              className="pl-9"
              value={query}
              onChange={(event) => {
                onQueryChange(event.target.value)
                setVisibleCount(160)
              }}
            />
          </div>
          <Button size="sm" variant="ghost" disabled={locked} onClick={() => replaceAll({})}>
            {t('policyAll')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => replaceAll({ allow: [] })}
          >
            {t('policyNone')}
          </Button>
          <Button
            size="sm"
            variant={rulesOpen ? 'secondary' : 'ghost'}
            aria-expanded={rulesOpen}
            onClick={() => onRulesOpenChange(!rulesOpen)}
          >
            <CodeIcon className="size-4" />
            {t('nameRules')}
            {ruleCount ? ` · ${ruleCount}` : ''}
          </Button>
        </div>
        {readOnly && <p className="text-sm text-muted-foreground">{t('allReadOnly')}</p>}
        {rulesOpen && (
          <div className="space-y-3 rounded-lg border p-3">
            <p className="text-sm text-muted-foreground">{t('rulesDescription')}</p>
            <label className="flex min-h-8 items-center gap-2 text-sm">
              <Switch
                checked={rule.allow === undefined}
                disabled={locked}
                onCheckedChange={(checked) => {
                  const next = { ...rule }
                  if (checked) delete next.allow
                  else next.allow = []
                  if (rule.allow?.length)
                    setConfirmation({ rule: next, description: t('resetAllowDescription') })
                  else onChange(next)
                }}
              />
              {t('defaultAvailable')}
            </label>
            {!readOnly && (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  addPattern()
                }}
              >
                <L4ChoiceGroup<'allow' | 'deny'>
                  label={t('ruleAction')}
                  layout="segmented"
                  value={side}
                  disabled={disabled}
                  options={[
                    { value: 'allow', label: t('allowRules') },
                    { value: 'deny', label: t('excludeRules') }
                  ]}
                  onChange={setSide}
                />
                <Input
                  aria-label={t('patternInput')}
                  placeholder={t('patternPlaceholder')}
                  maxLength={256}
                  value={pattern}
                  disabled={disabled}
                  className="min-w-32 flex-1 font-mono"
                  onChange={(event) => setPattern(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && event.nativeEvent.isComposing)
                      event.preventDefault()
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  type="submit"
                  disabled={disabled || !pattern.trim()}
                >
                  <PlusIcon className="size-4" />
                  {t('addRule')}
                </Button>
              </form>
            )}
            {(['allow', 'deny'] as const).map((kind) =>
              rule[kind]?.length ? (
                <div key={kind} className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t(kind === 'allow' ? 'allowRules' : 'excludeRules')}
                  </span>
                  {rule[kind]!.map((value) => (
                    <span
                      key={value}
                      className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 font-mono text-xs"
                    >
                      <span className="break-all">{value}</span>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-6 shrink-0"
                        aria-label={t('removeRule', { name: value })}
                        disabled={locked}
                        onClick={() =>
                          onChange({
                            ...rule,
                            [kind]: rule[kind]!.filter((entry) => entry !== value)
                          })
                        }
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </span>
                  ))}
                </div>
              ) : null
            )}
            {ruleCount === 0 && <p className="text-sm text-muted-foreground">{t('noSelection')}</p>}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2">
        {shown.map((option) => (
          <label
            key={option.value}
            className="flex min-h-12 cursor-pointer items-center gap-3 border-b border-border/60 py-3 last:border-0"
          >
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-medium">
                {option.label ?? option.value}
              </span>
              {option.label && option.label !== option.value && (
                <span className="block break-all font-mono text-xs text-muted-foreground">
                  {option.value}
                </span>
              )}
              {option.description && (
                <span className="mt-1 block whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {option.description}
                </span>
              )}
            </span>
            <Switch
              aria-label={t('availableValue', { name: option.value })}
              checked={isCapabilityAllowed(rule, option.value)}
              disabled={locked}
              onCheckedChange={(checked) => toggle(option.value, checked)}
            />
          </label>
        ))}
        {shown.length === 0 && (
          <p className="py-6 text-sm text-muted-foreground">{t('noCapabilityMatches')}</p>
        )}
        {filtered.length > shown.length && (
          <Button
            variant="ghost"
            className="mt-3"
            onClick={() => setVisibleCount((size) => size + 160)}
          >
            {t('moreRules', { count: filtered.length - shown.length })}
          </Button>
        )}
      </div>
      <p className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground">
        {t('availableCount', { count, total: values.length })}
      </p>
      <L4AppDialogRoot
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
      >
        <L4AppDialogContent className="z-[150]" backdropClassName="z-[140]">
          <L4AppDialogHeader className="p-4 pr-12">
            <L4AppDialogTitle>{t('changeRulesConfirm')}</L4AppDialogTitle>
            <L4AppDialogDescription>{confirmation?.description}</L4AppDialogDescription>
          </L4AppDialogHeader>
          <L4AppDialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                if (confirmation) onChange(confirmation.rule)
                setConfirmation(null)
              }}
            >
              {t('confirmChange')}
            </Button>
          </L4AppDialogFooter>
        </L4AppDialogContent>
      </L4AppDialogRoot>
    </section>
  )
}
