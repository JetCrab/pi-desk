'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2AccountModelOverrides,
  L2ModelAccount,
  L2ModelConfig
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { Field, kToTokens, tokensToK } from './l2-model-settings-form'

const PRICE_FIELDS = [
  ['input', 'inputPrice'],
  ['output', 'outputPrice'],
  ['cacheRead', 'cacheReadPrice'],
  ['cacheWrite', 'cacheWritePrice']
] as const

export function L2AccountModelDetails({
  model,
  account,
  overrides,
  onChange,
  onInputState
}: {
  model: L2ModelConfig | undefined
  account: L2ModelAccount | undefined
  overrides: L2AccountModelOverrides
  onChange: (overrides: L2AccountModelOverrides) => void
  onInputState: (state: { dirty: boolean; invalid: boolean }) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const initial = (): Record<string, string> => ({
    contextWindow: overrides.contextWindow === undefined ? '' : tokensToK(overrides.contextWindow),
    maxTokens: overrides.maxTokens === undefined ? '' : tokensToK(overrides.maxTokens),
    ...Object.fromEntries(
      PRICE_FIELDS.map(([field]) => [
        field,
        overrides.cost?.[field] === undefined ? '' : String(overrides.cost[field])
      ])
    )
  })
  const [draft, setDraft] = useState(initial)
  const invalidCapacity = (value: string): boolean => value !== '' && kToTokens(value) === null
  const invalidPrice = (value: string): boolean =>
    value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)

  function change(field: string, value: string): void {
    const next = { ...draft, [field]: value }
    setDraft(next)
    const invalid =
      invalidCapacity(next.contextWindow) ||
      invalidCapacity(next.maxTokens) ||
      PRICE_FIELDS.some(([key]) => invalidPrice(next[key]))
    onInputState({ dirty: invalid, invalid })
    if (field === 'contextWindow' || field === 'maxTokens') {
      if (invalidCapacity(value)) return
      const updated = { ...overrides }
      if (value === '') delete updated[field]
      else updated[field] = kToTokens(value)!
      onChange(updated)
    } else {
      if (PRICE_FIELDS.some(([key]) => invalidPrice(next[key]))) return
      const updated = { ...overrides }
      if (PRICE_FIELDS.every(([key]) => next[key] === '')) delete updated.cost
      else {
        updated.cost = Object.fromEntries(
          PRICE_FIELDS.filter(([key]) => next[key] !== '').map(([key]) => [key, Number(next[key])])
        )
      }
      onChange(updated)
    }
  }

  if (!model)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('accountModelUnavailable')}
      </p>
    )
  const cost = model.cost ? { ...model.cost, ...overrides.cost } : overrides.cost
  return (
    <div className="max-w-[40rem] space-y-6">
      <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
        <span>{t(account?.loggedIn ? 'accountLoggedIn' : 'accountLoggedOut')}</span>
        {account?.subscription ? (
          <span className="rounded-md bg-muted px-2">{t('accountSubscription')}</span>
        ) : null}
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted-foreground">{t('contextLength')}</dt>
          <dd className="mt-1 text-lg font-semibold">
            {tokensToK(overrides.contextWindow ?? model.contextWindow)} K
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{t('maximumOutput')}</dt>
          <dd className="mt-1 text-lg font-semibold">
            {tokensToK(overrides.maxTokens ?? model.maxTokens)} K
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-sm text-muted-foreground">{t('capabilities')}</dt>
          <dd className="mt-1 text-sm">
            {[
              ...model.input.map((input) => t(input === 'image' ? 'imageInput' : 'textInput')),
              ...(model.reasoning ? [t('supportsThinking')] : [])
            ].join(' · ')}
          </dd>
        </div>
      </dl>
      <details className="border-t pt-3">
        <summary className="cursor-pointer text-sm font-semibold">
          {t('accountReferencePrice')}
        </summary>
        <div className="mt-3 text-sm text-muted-foreground">
          {cost
            ? PRICE_FIELDS.map(([field, label]) => (
                <p key={field}>
                  {t(label)}: {cost[field] === undefined ? '—' : `$${cost[field]}`}
                </p>
              ))
            : t('priceMissing')}
        </div>
      </details>
      <details className="border-t pt-3">
        <summary className="cursor-pointer text-sm font-semibold">
          {t('accountAdjustParameters')}
        </summary>
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {(['contextWindow', 'maxTokens'] as const).map((field) => (
              <Field
                key={field}
                label={`${t(field === 'contextWindow' ? 'contextLength' : 'maximumOutput')} (K)`}
              >
                <Input
                  value={draft[field]}
                  placeholder={tokensToK(model[field])}
                  inputMode="decimal"
                  aria-invalid={invalidCapacity(draft[field])}
                  onChange={(event) => change(field, event.target.value)}
                />
                {invalidCapacity(draft[field]) ? (
                  <span className="text-xs text-destructive">{t('capacityInvalid')}</span>
                ) : null}
              </Field>
            ))}
          </div>
          <details>
            <summary className="cursor-pointer text-sm font-medium">{t('price')}</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {PRICE_FIELDS.map(([field, label]) => (
                <Field key={field} label={t(label)}>
                  <Input
                    value={draft[field]}
                    inputMode="decimal"
                    placeholder={String(model.cost?.[field] ?? '')}
                    aria-invalid={invalidPrice(draft[field])}
                    onChange={(event) => change(field, event.target.value)}
                  />
                  {invalidPrice(draft[field]) ? (
                    <span className="text-xs text-destructive">{t('priceInvalid')}</span>
                  ) : null}
                </Field>
              ))}
            </div>
          </details>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft({
                contextWindow: '',
                maxTokens: '',
                input: '',
                output: '',
                cacheRead: '',
                cacheWrite: ''
              })
              onChange({})
              onInputState({ dirty: false, invalid: false })
            }}
          >
            {t('accountRestoreDefaults')}
          </Button>
        </div>
      </details>
    </div>
  )
}
