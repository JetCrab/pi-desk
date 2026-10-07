'use client'

import { CheckIcon, ChevronsUpDownIcon, LoaderCircleIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2ModelConfig,
  L2ModelProviderConfig
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandInput
} from '@client/l4_foundation/ui/shadcn/command'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput
} from '@client/l4_foundation/ui/shadcn/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@client/l4_foundation/ui/shadcn/popover'
import type { L2ModelSettingsBiz } from '../l2-model-settings-biz'
import { useL2ModelCatalog, type ModelCatalogCandidate } from '../hooks/l2-use-model-catalog'
import {
  Field,
  FixedSelect,
  HeaderTextarea,
  MODEL_APIS,
  THINKING_FORMATS,
  TriStateSelect,
  kToTokens,
  tokensToK
} from './l2-model-settings-form'

const THINKING_LEVELS = [
  ['off', 'thinkingOff'],
  ['minimal', 'thinkingMinimal'],
  ['low', 'thinkingLow'],
  ['medium', 'thinkingMedium'],
  ['high', 'thinkingHigh'],
  ['xhigh', 'thinkingXhigh'],
  ['max', 'thinkingMax']
] as const
const PRICE_FIELDS = [
  ['input', 'inputPrice'],
  ['output', 'outputPrice'],
  ['cacheRead', 'cacheReadPrice'],
  ['cacheWrite', 'cacheWritePrice']
] as const

type CapacityDraft = { contextWindow: string; maxTokens: string }
type PriceDraft = Record<(typeof PRICE_FIELDS)[number][0], string>

function priceDraft(model: L2ModelConfig): PriceDraft {
  return {
    input: String(model.cost?.input ?? ''),
    output: String(model.cost?.output ?? ''),
    cacheRead: String(model.cost?.cacheRead ?? ''),
    cacheWrite: String(model.cost?.cacheWrite ?? '')
  }
}

function invalidInputs(capacity: CapacityDraft, prices: PriceDraft): boolean {
  return (
    Object.values(capacity).some((value) => kToTokens(value) === null) ||
    Object.values(prices).some(
      (value) => value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)
    )
  )
}

export function L2ModelEditor({
  biz,
  provider,
  model,
  onChange,
  onInputState
}: {
  biz: L2ModelSettingsBiz
  provider: L2ModelProviderConfig
  model: L2ModelConfig
  onChange: (model: L2ModelConfig) => void
  onInputState: (state: { dirty: boolean; invalid: boolean }) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const modelIdInputId = useId()
  const [capacity, setCapacity] = useState<CapacityDraft>({
    contextWindow: tokensToK(model.contextWindow),
    maxTokens: tokensToK(model.maxTokens)
  })
  const [prices, setPrices] = useState<PriceDraft>(() => priceDraft(model))
  const {
    searchText,
    setSearchText,
    catalogOpen,
    setCatalogOpen,
    loadingCatalog,
    candidates,
    visibleCandidates,
    showAllCandidates,
    setShowAllCandidates,
    selectedCandidateKey,
    setSelectedCandidateKey
  } = useL2ModelCatalog(biz, model.modelId)
  const selectedLevels = new Map(model.thinkingLevels.map((item) => [item.level, item]))
  const inheritedApi = MODEL_APIS.find((api) => api.value === provider.api)?.label ?? provider.api

  function patch(changes: Partial<L2ModelConfig>): void {
    onChange({ ...model, ...changes })
  }

  function changeCapacity(field: keyof CapacityDraft, value: string): void {
    const next = { ...capacity, [field]: value }
    setCapacity(next)
    const invalid = invalidInputs(next, prices)
    onInputState({ dirty: invalid, invalid })
    const tokens = kToTokens(value)
    if (tokens !== null) patch({ [field]: tokens })
  }

  function changePrice(field: keyof PriceDraft, value: string): void {
    const next = { ...prices, [field]: value }
    setPrices(next)
    const invalid = invalidInputs(capacity, next)
    onInputState({ dirty: invalid, invalid })
    if (Object.values(next).every((price) => price === '')) {
      patch({ cost: null })
      return
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) return
    patch({
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cacheRead: model.cost?.cacheRead ?? 0,
        cacheWrite: model.cost?.cacheWrite ?? 0,
        [field]: parsed
      }
    })
  }

  function applySource(candidate: ModelCatalogCandidate): void {
    const { item, source } = candidate
    const nextModel = { ...model, modelId: source.modelId, name: item.name, ...source.defaults }
    onChange(nextModel)
    setCapacity({
      contextWindow: tokensToK(nextModel.contextWindow),
      maxTokens: tokensToK(nextModel.maxTokens)
    })
    setPrices(priceDraft(nextModel))
    onInputState({ dirty: false, invalid: false })
    setSearchText(source.modelId)
    setSelectedCandidateKey(candidate.key)
    setShowAllCandidates(false)
    setCatalogOpen(false)
  }

  return (
    <div className="@container/model-editor space-y-6">
      <div className="grid max-w-[40rem] gap-3 @[32rem]/model-editor:grid-cols-2">
        <div className="grid gap-1 text-sm @[32rem]/model-editor:col-span-2">
          <label htmlFor={modelIdInputId} className="font-medium">
            {t('modelId')}
          </label>
          <Command
            shouldFilter={false}
            loop
            className="h-auto w-full overflow-visible rounded-none bg-transparent p-0 [&_[data-slot=command-input-wrapper]]:p-0 [&_[data-slot=input-group-addon]]:hidden"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && catalogOpen) {
                event.preventDefault()
                event.stopPropagation()
                setCatalogOpen(false)
              }
            }}
          >
            <div className="relative">
              <CommandInput
                id={modelIdInputId}
                value={searchText}
                onValueChange={(value) => {
                  setSearchText(value)
                  patch({ modelId: value })
                  setSelectedCandidateKey(null)
                  setShowAllCandidates(false)
                  setCatalogOpen(true)
                }}
                placeholder={t('modelIdSearch')}
                aria-label={t('modelId')}
                aria-autocomplete="list"
                className="pr-9"
              />
              <Popover
                open={catalogOpen}
                onOpenChange={(open) => {
                  setCatalogOpen(open)
                  if (open) setShowAllCandidates(false)
                }}
              >
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      title={t('chooseModel')}
                      aria-label={t('chooseModel')}
                      aria-busy={loadingCatalog}
                      className="absolute top-0.5 right-0.5 z-10"
                    >
                      {loadingCatalog ? (
                        <LoaderCircleIcon className="animate-spin" />
                      ) : (
                        <ChevronsUpDownIcon />
                      )}
                    </Button>
                  }
                />
                <PopoverContent
                  align="end"
                  sideOffset={4}
                  initialFocus={false}
                  finalFocus={false}
                  positionerClassName="z-[120]"
                  className="w-[min(32rem,calc(100vw-2rem))] gap-0 p-0"
                >
                  <CommandList className="max-h-[min(24rem,var(--available-height))] p-1">
                    {loadingCatalog && candidates.length === 0 ? (
                      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                        {t('matchingCatalog')}
                      </p>
                    ) : candidates.length === 0 ? (
                      <CommandEmpty className="py-6 text-sm">{t('noCatalogMatches')}</CommandEmpty>
                    ) : (
                      <>
                        <CommandGroup className="p-0">
                          {visibleCandidates.map((candidate) => (
                            <CommandItem
                              key={candidate.key}
                              value={candidate.key}
                              data-checked={
                                selectedCandidateKey === candidate.key ? 'true' : undefined
                              }
                              className="px-3 py-2"
                              onSelect={() => applySource(candidate)}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="break-all font-mono text-sm font-semibold">
                                    {candidate.source.modelId}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    {candidate.source.providerName}
                                  </span>
                                </span>
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  {candidate.item.name} ·{' '}
                                  {t('contextAndOutput', {
                                    context: `${tokensToK(candidate.source.defaults.contextWindow)}K`,
                                    output: `${tokensToK(candidate.source.defaults.maxTokens)}K`
                                  })}
                                </span>
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  {candidate.source.defaults.cost
                                    ? `${t('priceInput', { price: `$${candidate.source.defaults.cost.input}` })} · ${t('priceOutput', { price: `$${candidate.source.defaults.cost.output}` })}${t('perMillionTokens')}`
                                    : t('priceMissing')}
                                </span>
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                        {!showAllCandidates && candidates.length > visibleCandidates.length ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="w-full"
                            onClick={() => setShowAllCandidates(true)}
                          >
                            {t('moreConfigurations', {
                              count: candidates.length - visibleCandidates.length
                            })}
                          </Button>
                        ) : null}
                      </>
                    )}
                  </CommandList>
                </PopoverContent>
              </Popover>
            </div>
          </Command>
          {!model.modelId.trim() ? (
            <span className="text-xs text-destructive">{t('modelIdRequired')}</span>
          ) : null}
        </div>
        <Field label={t('modelName')} className="@[32rem]/model-editor:col-span-2">
          <Input value={model.name} onChange={(event) => patch({ name: event.target.value })} />
          {!model.name.trim() ? (
            <span className="text-xs text-destructive">{t('modelNameRequired')}</span>
          ) : null}
        </Field>
        {(
          [
            ['contextWindow', 'contextLength'],
            ['maxTokens', 'maximumOutput']
          ] as const
        ).map(([field, label]) => {
          const invalid = kToTokens(capacity[field]) === null
          return (
            <Field key={field} label={t(label)}>
              <InputGroup>
                <InputGroupInput
                  aria-label={t(label)}
                  inputMode="decimal"
                  value={capacity[field]}
                  aria-invalid={invalid}
                  aria-describedby={invalid ? `${modelIdInputId}-${field}-error` : undefined}
                  onChange={(event) => changeCapacity(field, event.target.value)}
                />
                <InputGroupAddon align="inline-end">K</InputGroupAddon>
              </InputGroup>
              {invalid ? (
                <span
                  id={`${modelIdInputId}-${field}-error`}
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {t('capacityInvalid')}
                </span>
              ) : null}
            </Field>
          )
        })}
      </div>

      <section>
        <p className="text-sm font-semibold">{t('capabilities')}</p>
        <div className="mt-2 flex flex-wrap gap-2 text-sm">
          {model.input.map((input) => (
            <span key={input} className="rounded-md bg-muted px-2 py-1">
              {t(input === 'text' ? 'textInput' : 'imageInput')}
            </span>
          ))}
          {model.reasoning ? (
            <span className="rounded-md bg-muted px-2 py-1">{t('supportsThinking')}</span>
          ) : null}
        </div>
      </section>

      <details className="border-t pt-3">
        <summary className="cursor-pointer text-sm font-semibold">{t('inputAndThinking')}</summary>
        <div className="mt-3 flex flex-wrap gap-2">
          {(['text', 'image'] as const).map((inputType) => {
            const selected = model.input.includes(inputType)
            return (
              <Button
                key={inputType}
                type="button"
                size="sm"
                variant="outline"
                aria-pressed={selected}
                onClick={() => {
                  if (selected && model.input.length === 1) return
                  patch({
                    input: selected
                      ? model.input.filter((item) => item !== inputType)
                      : [...model.input, inputType]
                  })
                }}
              >
                {selected ? <CheckIcon /> : null}
                {t(inputType === 'text' ? 'textInput' : 'imageInput')}
              </Button>
            )
          })}
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={model.reasoning}
            onClick={() =>
              patch({
                reasoning: !model.reasoning,
                thinkingLevels: !model.reasoning
                  ? [{ level: 'high', providerValue: null }]
                  : [{ level: 'off', providerValue: null }]
              })
            }
          >
            {model.reasoning ? <CheckIcon /> : null}
            {t('supportsThinking')}
          </Button>
        </div>
        {model.reasoning ? (
          <details className="mt-4 border-t pt-3">
            <summary className="cursor-pointer text-sm font-medium">{t('thinkingMapping')}</summary>
            <div className="mt-2 grid max-w-[40rem] gap-x-4 @[32rem]/model-editor:grid-cols-2">
              {THINKING_LEVELS.map(([level, label]) => {
                const selected = selectedLevels.get(level)
                return (
                  <div
                    key={level}
                    className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 border-b py-2"
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-pressed={Boolean(selected)}
                      className="justify-start"
                      onClick={() => {
                        const next = selected
                          ? model.thinkingLevels.filter((item) => item.level !== level)
                          : [
                              ...model.thinkingLevels,
                              { level, providerValue: level === 'off' ? null : level }
                            ]
                        if (next.length) patch({ thinkingLevels: next })
                      }}
                    >
                      {selected ? <CheckIcon /> : null}
                      {t(label)}
                    </Button>
                    <Input
                      aria-label={t('providerMapping', { level: t(label) })}
                      disabled={!selected || level === 'off'}
                      value={level === 'off' ? t('noMapping') : (selected?.providerValue ?? '')}
                      placeholder={level}
                      onChange={(event) =>
                        patch({
                          thinkingLevels: model.thinkingLevels.map((current) =>
                            current.level === level
                              ? { ...current, providerValue: event.target.value || null }
                              : current
                          )
                        })
                      }
                    />
                  </div>
                )
              })}
            </div>
          </details>
        ) : null}
      </details>

      <details className="border-t pt-3">
        <summary className="cursor-pointer text-sm font-semibold">{t('price')}</summary>
        <div className="mt-3 grid max-w-[40rem] gap-3 @[32rem]/model-editor:grid-cols-2">
          {PRICE_FIELDS.map(([field, label]) => {
            const invalid =
              prices[field] !== '' &&
              (!Number.isFinite(Number(prices[field])) || Number(prices[field]) < 0)
            return (
              <Field key={field} label={t(label)}>
                <Input
                  inputMode="decimal"
                  value={prices[field]}
                  aria-invalid={invalid}
                  onChange={(event) => changePrice(field, event.target.value)}
                />
                {invalid ? (
                  <span role="alert" className="text-xs text-destructive">
                    {t('priceInvalid')}
                  </span>
                ) : null}
              </Field>
            )
          })}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-self-start"
            onClick={() => {
              const next = { input: '', output: '', cacheRead: '', cacheWrite: '' }
              setPrices(next)
              onInputState({ dirty: true, invalid: invalidInputs(capacity, next) })
              patch({ cost: null })
            }}
          >
            {t('clearPrice')}
          </Button>
        </div>
      </details>

      <details className="border-t pt-3">
        <summary className="cursor-pointer text-sm font-semibold">
          {t('advancedCompatibility')}
        </summary>
        <div className="mt-3 grid max-w-[40rem] gap-3 @[32rem]/model-editor:grid-cols-2">
          <Field label={t('apiOverride')} className="@[32rem]/model-editor:col-span-2">
            <FixedSelect
              value={model.api ?? ''}
              ariaLabel={t('apiOverride')}
              options={MODEL_APIS}
              placeholder={
                inheritedApi
                  ? t('inheritServiceValue', { value: inheritedApi })
                  : t('inheritService')
              }
              onChange={(value) => patch({ api: value || null })}
            />
          </Field>
          <Field label={t('baseUrlOverride')} className="@[32rem]/model-editor:col-span-2">
            <Input
              value={model.baseUrl ?? ''}
              aria-label={t('baseUrlOverride')}
              placeholder={
                provider.baseUrl
                  ? t('inheritServiceValue', { value: provider.baseUrl })
                  : t('inheritService')
              }
              onChange={(event) => patch({ baseUrl: event.target.value || null })}
            />
          </Field>
          <Field label={t('modelHeaders')} className="@[32rem]/model-editor:col-span-2">
            <HeaderTextarea
              headers={model.headers}
              onChange={(headers) => patch({ headers })}
              placeholder={t('headerPlaceholder')}
            />
          </Field>
          <Field label={t('developerRole')}>
            <TriStateSelect
              value={model.compat?.supportsDeveloperRole ?? null}
              ariaLabel={t('developerRole')}
              onChange={(value) =>
                patch({
                  compat: {
                    supportsDeveloperRole: value,
                    thinkingFormat: model.compat?.thinkingFormat ?? null,
                    requiresReasoningContentOnAssistantMessages:
                      model.compat?.requiresReasoningContentOnAssistantMessages ?? null
                  }
                })
              }
            />
          </Field>
          <Field label="Thinking Format">
            <FixedSelect
              value={model.compat?.thinkingFormat ?? ''}
              ariaLabel="Thinking Format"
              options={THINKING_FORMATS.map((format) => ({ value: format, label: format }))}
              onChange={(value) =>
                patch({
                  compat: {
                    supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? null,
                    thinkingFormat: value || null,
                    requiresReasoningContentOnAssistantMessages:
                      model.compat?.requiresReasoningContentOnAssistantMessages ?? null
                  }
                })
              }
            />
          </Field>
          <Field label={t('replayReasoning')}>
            <TriStateSelect
              value={model.compat?.requiresReasoningContentOnAssistantMessages ?? null}
              ariaLabel={t('replayReasoning')}
              onChange={(value) =>
                patch({
                  compat: {
                    supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? null,
                    thinkingFormat: model.compat?.thinkingFormat ?? null,
                    requiresReasoningContentOnAssistantMessages: value
                  }
                })
              }
            />
          </Field>
        </div>
      </details>
    </div>
  )
}
