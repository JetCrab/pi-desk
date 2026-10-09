'use client'

import { PlusIcon, ServerIcon, StarIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  L2AccountModelSelection,
  L2ModelAccount,
  L2ModelPreset,
  L2ModelProviderConfig
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { tokensToK } from './l2-model-settings-form'
import { L2ModelServiceActions } from './l2-model-service-actions'

export function L2ModelServiceGroup({
  providerId,
  custom,
  account,
  accountModels,
  query,
  modelKeys,
  selectedCustomIndex,
  selectedAccountId,
  presets,
  onSelectCustom,
  onSelectAccount,
  onCustomSettings,
  onAddCustom,
  onAddAccount,
  onLogin,
  onLogout,
  onGroupRef,
  onRowRef
}: {
  providerId: string
  custom: L2ModelProviderConfig | undefined
  account: L2ModelAccount | undefined
  accountModels: L2AccountModelSelection[]
  query: string
  modelKeys: string[]
  selectedCustomIndex: number | null
  selectedAccountId: string | null
  presets: L2ModelPreset[]
  onSelectCustom: (index: number) => void
  onSelectAccount: (modelId: string) => void
  onCustomSettings: () => void
  onAddCustom: () => void
  onAddAccount: () => void
  onLogin: () => void
  onLogout: () => void
  onGroupRef: (node: HTMLElement | null) => void
  onRowRef: (key: string, node: HTMLButtonElement | null) => void
}): React.JSX.Element | null {
  const { t } = useTranslation('settings')
  const name = (custom ? providerId : account?.name) || providerId || t('providerUnnamed')
  const accountEntries = accountModels.filter(
    (ref) => !custom?.models.some((model) => model.modelId === ref.modelId)
  )
  const models = [
    ...(custom?.models ?? []).map((model, index) => ({
      key: modelKeys[index],
      modelId: model.modelId,
      name: model.name,
      model,
      selected: selectedCustomIndex === index,
      select: () => onSelectCustom(index)
    })),
    ...accountEntries.map((ref) => {
      const model = account?.models.find((model) => model.modelId === ref.modelId)
      return {
        key: `account:${providerId}:${ref.modelId}`,
        modelId: ref.modelId,
        name: model?.name ?? ref.modelId,
        model: model ? { ...model, ...ref.overrides } : undefined,
        selected: selectedAccountId === ref.modelId,
        select: () => onSelectAccount(ref.modelId)
      }
    })
  ]
  const matching = models.filter((model) =>
    `${providerId} ${name} ${account?.name ?? ''} ${model.name} ${model.modelId}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase())
  )
  if (
    query &&
    !matching.length &&
    !`${providerId} ${name} ${account?.name ?? ''}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase())
  )
    return null
  const hasAccount = Boolean(account) || accountModels.length > 0
  return (
    <section ref={onGroupRef} className="mb-3">
      <div className="flex items-center gap-2 px-2 py-1 text-foreground">
        <ServerIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={account?.name}>
          {name}
        </span>
        <span className="text-xs text-muted-foreground">{models.length}</span>
        <L2ModelServiceActions
          name={name}
          hasAccount={hasAccount}
          loggedIn={account?.loggedIn ?? false}
          hasCustom={Boolean(custom)}
          onCustomSettings={onCustomSettings}
          onLogin={onLogin}
          onLogout={onLogout}
        />
      </div>
      <div className="space-y-1">
        {matching.map((item) => (
          <button
            key={item.key}
            ref={(node) => onRowRef(item.key, node)}
            type="button"
            aria-current={item.selected ? 'true' : undefined}
            className={cn(
              'flex min-h-14 w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
              item.selected && 'bg-accent text-accent-foreground'
            )}
            onClick={item.select}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {item.name || item.modelId || t('modelUnnamed')}
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {item.model
                  ? `${tokensToK(item.model.contextWindow)} K · ${t(item.model.input.includes('image') ? 'imageInput' : 'textInput')}`
                  : t('accountModelUnavailableShort')}
              </span>
            </span>
            {presets.some(
              (preset) => preset.provider === providerId && preset.modelId === item.modelId
            ) ? (
              <StarIcon className="size-4 shrink-0 text-muted-foreground" />
            ) : null}
          </button>
        ))}
        {hasAccount ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 w-full border border-dashed border-input"
            aria-label={t('modelAddToService', { name: account?.name ?? name })}
            onClick={onAddAccount}
          >
            <PlusIcon />
            {t('modelAdd')}
          </Button>
        ) : null}
        {custom ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 w-full border border-dashed border-input"
            aria-label={t('modelAddToService', { name })}
            onClick={onAddCustom}
          >
            <PlusIcon />
            {hasAccount ? t('accountCustomModel') : null}
          </Button>
        ) : null}
      </div>
    </section>
  )
}
