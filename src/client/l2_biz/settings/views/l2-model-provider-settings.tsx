'use client'

import {
  ArrowLeftIcon,
  DatabaseIcon,
  LogInIcon,
  PlusIcon,
  StarIcon,
  Trash2Icon
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2AccountModelSelection,
  L2ModelAccount,
  L2ModelSettingsGetResponse,
  L2ModelOption,
  L2ModelPreset,
  L2ModelProviderConfig
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@client/l4_foundation/ui/shadcn/tooltip'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { useL4ConfirmDialog } from '@client/l4_foundation/ui/l4-confirm-dialog'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import {
  L4AppDialogRoot,
  L4AppDialogContent,
  L4AppDialogHeader,
  L4AppDialogTitle,
  L4AppDialogBody,
  L4AppDialogFooter
} from '@client/l4_foundation/ui/l4-app-dialog'
import type { L2ModelSettingsBiz } from '../l2-model-settings-biz'
import { pickL2ModelPresetColor } from '../l2-model-preset-colors'
import {
  emptyL2ModelProvider,
  useL2ModelProviderSettings,
  type ModelInputState
} from '../hooks/l2-use-model-provider-settings'
import { L2ModelEditor } from './l2-model-editor'
import { L2ModelServiceDialog } from './l2-model-service-dialog'
import { Field, FixedSelect } from './l2-model-settings-form'
import { useL2ModelAuth } from '../hooks/l2-use-model-auth'
import { L2ModelAuthDialog } from './l2-model-auth-dialog'
import { L2AccountModelPicker } from './l2-account-model-picker'
import { L2AccountModelDetails } from './l2-account-model-details'
import { L2ModelServiceGroup } from './l2-model-service-group'
import { L2ModelServiceActions } from './l2-model-service-actions'

interface Props {
  biz: L2ModelSettingsBiz
  connectionReady: boolean
  providers: L2ModelProviderConfig[]
  accounts: L2ModelAccount[]
  accountModels: L2AccountModelSelection[]
  onAccountModelsChange: (models: L2AccountModelSelection[]) => void
  onRefreshAccounts: () => Promise<L2ModelSettingsGetResponse>
  savedModels: L2ModelOption[]
  savedProviders: L2ModelProviderConfig[]
  presets: L2ModelPreset[]
  resetVersion: number
  onChange: (providers: L2ModelProviderConfig[]) => void
  onPresetsChange: (presets: L2ModelPreset[]) => void
  onInputState: (state: ModelInputState) => void
  onServiceDirtyChange: (dirty: boolean) => void
}

const THINKING_LABELS = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax'
} as const

export function L2ModelProviderSettings({
  biz,
  connectionReady,
  providers,
  accounts,
  accountModels,
  onAccountModelsChange,
  onRefreshAccounts,
  savedModels,
  savedProviders,
  presets,
  resetVersion,
  onChange,
  onPresetsChange,
  onInputState,
  onServiceDirtyChange
}: Props): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { confirm, dialog } = useL4ConfirmDialog()
  const toast = useL4AppToast()
  const [accountSelection, setAccountSelection] = useState<{
    provider: string
    modelId: string
  } | null>(null)
  const [pickerProvider, setPickerProvider] = useState<string | null>(null)
  const [accountMobileDetail, setAccountMobileDetail] = useState(false)
  const [visitedAccountKeys, setVisitedAccountKeys] = useState<Set<string>>(() => new Set())
  const auth = useL2ModelAuth(connectionReady, async (provider, isCurrent) => {
    await onRefreshAccounts()
    if (isCurrent()) setPickerProvider(provider)
  })
  const state = useL2ModelProviderSettings(providers, onChange, onInputState, resetVersion)
  const { selection, mobileDetail, query, setQuery, modelKeys, serviceIndex, newService } = state
  const groups = useRef(new Map<number, HTMLElement>())
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const [presetOpen, setPresetOpen] = useState(false)
  const [presetLevel, setPresetLevel] = useState<L2ModelPreset['thinkingLevel']>('off')
  const selectedAccountRef =
    accountModels.find(
      (ref) =>
        ref.provider === accountSelection?.provider && ref.modelId === accountSelection?.modelId
    ) ?? (providers.some((provider) => provider.models.length) ? undefined : accountModels[0])
  const selectedAccount = accounts.find(
    (account) => account.provider === selectedAccountRef?.provider
  )
  const selectedAccountModel = selectedAccount?.models.find(
    (model) => model.modelId === selectedAccountRef?.modelId
  )
  const accountActive = Boolean(selectedAccountRef)
  const selectedProvider = !accountActive && selection ? providers[selection.providerIndex] : null
  const selectedModel =
    !accountActive && selection ? selectedProvider?.models[selection.modelIndex] : null
  const detailVisible = accountActive ? accountMobileDetail : mobileDetail && Boolean(selectedModel)
  const detailName = accountActive
    ? (selectedAccountModel?.name ?? selectedAccountRef?.modelId)
    : selectedModel?.name || selectedModel?.modelId || t('modelUnnamed')
  const serviceId =
    selectedAccountRef?.provider || selectedProvider?.provider || t('providerUnnamed')
  const pickerAccount = accounts.find((account) => account.provider === pickerProvider)
  const groupIds = [
    ...new Set([
      ...providers.map((provider) => provider.provider),
      ...accounts.map((account) => account.provider),
      ...accountModels.map((model) => model.provider)
    ])
  ]
  const accountKey = (ref: { provider: string; modelId: string }): string =>
    `account:${ref.provider}:${ref.modelId}`
  const currentAccountKeys = new Set(accountModels.map(accountKey))
  const nextVisitedAccountKeys = new Set(
    [...visitedAccountKeys].filter((key) => currentAccountKeys.has(key))
  )
  if (selectedAccountRef) nextVisitedAccountKeys.add(accountKey(selectedAccountRef))
  if (
    nextVisitedAccountKeys.size !== visitedAccountKeys.size ||
    (selectedAccountRef && !visitedAccountKeys.has(accountKey(selectedAccountRef)))
  )
    setVisitedAccountKeys(nextVisitedAccountKeys)
  const [visitedModelKeys, setVisitedModelKeys] = useState<Set<string>>(() => new Set())
  const selectedModelKey = selection
    ? modelKeys[selection.providerIndex]?.[selection.modelIndex]
    : undefined
  const currentModelKeys = new Set(modelKeys.flat())
  const nextVisitedModelKeys = new Set(
    [...visitedModelKeys].filter((key) => currentModelKeys.has(key))
  )
  if (selectedModelKey) nextVisitedModelKeys.add(selectedModelKey)
  if (
    nextVisitedModelKeys.size !== visitedModelKeys.size ||
    (selectedModelKey && !visitedModelKeys.has(selectedModelKey))
  )
    setVisitedModelKeys(nextVisitedModelKeys)
  const availableModel = accountActive
    ? savedModels.find(
        (model) =>
          model.provider === selectedAccountRef?.provider &&
          model.modelId === selectedAccountRef.modelId
      )
    : selectedProvider &&
        selectedModel &&
        savedProviders.some(
          (provider) =>
            provider.provider === selectedProvider.provider &&
            provider.models.some((model) => model.modelId === selectedModel.modelId)
        )
      ? savedModels.find(
          (model) =>
            model.provider === selectedProvider.provider && model.modelId === selectedModel.modelId
        )
      : undefined

  async function removeModel(): Promise<void> {
    if (selectedAccountRef) {
      if (
        await confirm({
          title: t('accountRemoveTitle'),
          description: t('accountRemoveDescription', { name: detailName })
        })
      ) {
        onAccountModelsChange(accountModels.filter((ref) => ref !== selectedAccountRef))
        state.updateInputState(accountKey(selectedAccountRef), { dirty: false, invalid: false })
        setAccountSelection(null)
        setAccountMobileDetail(false)
      }
      return
    }
    if (!selection || !selectedModel) return
    if (
      await confirm({
        title: t('modelDeleteTitle'),
        description: t('modelDeleteDescription', {
          name: selectedModel.name || selectedModel.modelId || t('modelUnnamed')
        })
      })
    )
      state.deleteModel(selection.providerIndex, selection.modelIndex)
  }

  function back(): void {
    if (selectedAccountRef) {
      setAccountMobileDetail(false)
      window.requestAnimationFrame(() => {
        const row = rows.current.get(accountKey(selectedAccountRef))
        row?.scrollIntoView({ block: 'nearest' })
        row?.focus({ preventScroll: true })
      })
      return
    }
    state.backToList()
    window.requestAnimationFrame(() => {
      if (!selection) return
      const key = modelKeys[selection.providerIndex]?.[selection.modelIndex]
      groups.current.get(selection.providerIndex)?.scrollIntoView({ block: 'nearest' })
      rows.current.get(key)?.scrollIntoView({ block: 'nearest' })
      rows.current.get(key)?.focus({ preventScroll: true })
    })
  }

  function addAccountModels(modelIds: string[]): void {
    if (!pickerAccount) return
    const additions = modelIds
      .filter(
        (modelId) =>
          !accountModels.some(
            (ref) => ref.provider === pickerAccount.provider && ref.modelId === modelId
          ) &&
          !providers.some(
            (provider) =>
              provider.provider === pickerAccount.provider &&
              provider.models.some((model) => model.modelId === modelId)
          )
      )
      .map((modelId) => ({ provider: pickerAccount.provider, modelId, overrides: {} }))
    onAccountModelsChange([...accountModels, ...additions])
    setPickerProvider(null)
  }

  async function logout(provider: string): Promise<void> {
    if (
      !(await confirm({
        title: t('accountLogoutTitle'),
        description: t('accountLogoutDescription', {
          name: accounts.find((account) => account.provider === provider)?.name ?? provider
        }),
        confirmLabel: t('accountLogout')
      }))
    )
      return
    try {
      await auth.logout(provider)
      await onRefreshAccounts()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t('accountLogoutFailed'))
    }
  }

  function openAccountModels(provider: string): void {
    const account = accounts.find((account) => account.provider === provider)
    if (account?.loggedIn) setPickerProvider(provider)
    else auth.show(provider)
  }

  function addPreset(): void {
    if (!availableModel) return
    if (
      !presets.some(
        (preset) =>
          preset.provider === availableModel.provider &&
          preset.modelId === availableModel.modelId &&
          preset.thinkingLevel === presetLevel
      )
    )
      onPresetsChange([
        ...presets,
        {
          provider: availableModel.provider,
          modelId: availableModel.modelId,
          thinkingLevel: presetLevel,
          color: pickL2ModelPresetColor(presets)
        }
      ])
    setPresetOpen(false)
  }

  return (
    <section className="@container/models h-full min-h-0 overflow-hidden bg-card">
      <div className="grid h-full min-h-0 grid-cols-1 @[48rem]/models:grid-cols-[15rem_minmax(0,1fr)]">
        <aside
          aria-label={t('providerList')}
          className={cn(
            'min-h-0 min-w-0 flex-col bg-sidebar @[48rem]/models:flex @[48rem]/models:border-r',
            detailVisible ? 'hidden' : 'flex'
          )}
        >
          <div className="shrink-0 p-3">
            <Input
              value={query}
              aria-label={t('modelSearch')}
              placeholder={t('modelSearch')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {groupIds.map((providerId) => {
              const providerIndex = providers.findIndex(
                (provider) => provider.provider === providerId
              )
              return (
                <L2ModelServiceGroup
                  key={providerId}
                  providerId={providerId}
                  custom={providers[providerIndex]}
                  account={accounts.find((account) => account.provider === providerId)}
                  accountModels={accountModels.filter((ref) => ref.provider === providerId)}
                  query={query}
                  modelKeys={modelKeys[providerIndex] ?? []}
                  selectedCustomIndex={
                    !accountActive && selection?.providerIndex === providerIndex
                      ? selection.modelIndex
                      : null
                  }
                  selectedAccountId={
                    selectedAccountRef?.provider === providerId ? selectedAccountRef.modelId : null
                  }
                  presets={presets}
                  onSelectCustom={(modelIndex) => {
                    setAccountSelection(null)
                    state.selectModel(providerIndex, modelIndex)
                  }}
                  onSelectAccount={(modelId) => {
                    setAccountSelection({ provider: providerId, modelId })
                    setAccountMobileDetail(true)
                    setVisitedAccountKeys(
                      (keys) => new Set([...keys, accountKey({ provider: providerId, modelId })])
                    )
                  }}
                  onCustomSettings={() => state.openService(providerIndex)}
                  onAddCustom={() => {
                    setAccountSelection(null)
                    state.addModel(providerIndex)
                  }}
                  onAddAccount={() => openAccountModels(providerId)}
                  onLogin={() => auth.show(providerId)}
                  onLogout={() => void logout(providerId)}
                  onGroupRef={(node) => {
                    if (providerIndex < 0) return
                    if (node) groups.current.set(providerIndex, node)
                    else groups.current.delete(providerIndex)
                  }}
                  onRowRef={(key, node) => {
                    if (node) rows.current.set(key, node)
                    else rows.current.delete(key)
                  }}
                />
              )
            })}
            {!groupIds.length ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('providerEmpty')}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-2 border-t p-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => state.openService(null)}
            >
              <PlusIcon />
              {t('accountCustomApi')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => auth.show()}>
              <LogInIcon />
              {t('accountLogin')}
            </Button>
          </div>
        </aside>

        <section
          aria-label={t('modelsHeading')}
          className={cn(
            'min-h-0 min-w-0 flex-col @[48rem]/models:flex',
            detailVisible ? 'flex' : 'hidden'
          )}
        >
          {!accountActive && (!selectedModel || !selection) ? (
            <div className="flex flex-col items-center gap-3 p-6 text-sm text-muted-foreground">
              <DatabaseIcon className="size-6" />
              {t('selectModelToEdit')}
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 @[48rem]/models:hidden">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('backModelList')}
                  onClick={back}
                >
                  <ArrowLeftIcon />
                </Button>
                <span
                  className="min-w-0 flex-1 truncate text-sm font-medium"
                  title={selectedAccount?.name ?? serviceId}
                >
                  {selectedAccount?.name ?? serviceId}
                </span>
                <L2ModelServiceActions
                  name={serviceId}
                  hasAccount={
                    accounts.some((account) => account.provider === serviceId) ||
                    accountModels.some((ref) => ref.provider === serviceId)
                  }
                  loggedIn={
                    accounts.find((account) => account.provider === serviceId)?.loggedIn ?? false
                  }
                  hasCustom={providers.some((provider) => provider.provider === serviceId)}
                  onCustomSettings={() =>
                    state.openService(
                      providers.findIndex((provider) => provider.provider === serviceId)
                    )
                  }
                  onLogin={() => auth.show(serviceId)}
                  onLogout={() => void logout(serviceId)}
                />
              </div>
              <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto p-4 @[48rem]/models:p-6">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="min-w-0 break-all text-lg font-semibold">{detailName}</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!availableModel}
                      title={!availableModel ? t('saveBeforePreset') : undefined}
                      onClick={() => {
                        setPresetLevel(availableModel?.thinkingLevels[0] ?? 'off')
                        setPresetOpen(true)
                      }}
                    >
                      <StarIcon />
                      {t('addModelPreset')}
                    </Button>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive hover:text-destructive"
                            aria-label={
                              accountActive
                                ? `${t('accountRemove')} ${detailName}`
                                : t('modelDeleteNamed', { name: detailName })
                            }
                            onClick={removeModel}
                          >
                            <Trash2Icon />
                          </Button>
                        }
                      />
                      <TooltipContent>
                        {t(accountActive ? 'accountRemove' : 'modelDelete')}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                {accountModels.map((ref) => {
                  const key = accountKey(ref)
                  if (!nextVisitedAccountKeys.has(key)) return null
                  const account = accounts.find((account) => account.provider === ref.provider)
                  return (
                    <div
                      key={`${key}:${resetVersion}`}
                      hidden={!accountActive || selectedAccountRef !== ref}
                    >
                      <L2AccountModelDetails
                        account={account}
                        model={account?.models.find((model) => model.modelId === ref.modelId)}
                        overrides={ref.overrides}
                        onChange={(overrides) =>
                          onAccountModelsChange(
                            accountModels.map((current) =>
                              current === ref ? { ...ref, overrides } : current
                            )
                          )
                        }
                        onInputState={(inputState) => state.updateInputState(key, inputState)}
                      />
                    </div>
                  )
                })}
                {providers.flatMap((provider, providerIndex) =>
                  provider.models.map((model, modelIndex) => {
                    const selected =
                      !accountActive &&
                      selection?.providerIndex === providerIndex &&
                      selection.modelIndex === modelIndex
                    const key = modelKeys[providerIndex]?.[modelIndex]
                    if (!nextVisitedModelKeys.has(key)) return null
                    return (
                      <div key={`${key}:${resetVersion}`} hidden={!selected}>
                        <L2ModelEditor
                          biz={biz}
                          provider={provider}
                          model={model}
                          onChange={(next) => state.updateModel(providerIndex, modelIndex, next)}
                          onInputState={(inputState) => state.updateInputState(key, inputState)}
                        />
                      </div>
                    )
                  })
                )}
              </div>
            </>
          )}
        </section>
      </div>
      <L2ModelAuthDialog
        open={auth.open}
        connected={connectionReady}
        providers={auth.providers}
        state={auth.state}
        loading={auth.loading}
        submitting={auth.submitting}
        error={auth.error}
        onClose={auth.close}
        onStart={auth.start}
        onRespond={auth.respond}
        onCopy={auth.copy}
        onOpenUrl={auth.openUrl}
        onRetry={() => (auth.state?.status === 'completed' ? void auth.finish() : auth.show())}
      />
      {pickerAccount ? (
        <L2AccountModelPicker
          key={pickerAccount.provider}
          account={pickerAccount}
          existingIds={[
            ...accountModels
              .filter((ref) => ref.provider === pickerAccount.provider)
              .map((ref) => ref.modelId),
            ...providers
              .filter((provider) => provider.provider === pickerAccount.provider)
              .flatMap((provider) => provider.models.map((model) => model.modelId))
          ]}
          onAdd={addAccountModels}
          onClose={() => setPickerProvider(null)}
        />
      ) : null}
      {newService || serviceIndex !== null ? (
        <L2ModelServiceDialog
          provider={newService ? emptyL2ModelProvider() : providers[serviceIndex!]}
          existingIds={providers
            .filter((_, index) => newService || index !== serviceIndex)
            .map((provider) => provider.provider)}
          isNew={newService}
          onApply={state.applyService}
          onDelete={state.deleteService}
          onClose={state.closeService}
          onDirtyChange={onServiceDirtyChange}
        />
      ) : null}
      <L4AppDialogRoot open={presetOpen} onOpenChange={setPresetOpen}>
        <L4AppDialogContent>
          <L4AppDialogHeader className="border-b px-4 py-4 pr-12">
            <L4AppDialogTitle>{t('addModelPreset')}</L4AppDialogTitle>
          </L4AppDialogHeader>
          <L4AppDialogBody>
            <div className="p-4">
              <Field label={t('thinkingLevel')}>
                <FixedSelect
                  value={presetLevel}
                  allowEmpty={false}
                  ariaLabel={t('presetThinkingNew')}
                  options={(availableModel?.thinkingLevels ?? []).map((level) => ({
                    value: level,
                    label: t(THINKING_LABELS[level])
                  }))}
                  onChange={(level) => setPresetLevel(level as L2ModelPreset['thinkingLevel'])}
                />
              </Field>
            </div>
          </L4AppDialogBody>
          <L4AppDialogFooter>
            <Button type="button" variant="ghost" onClick={() => setPresetOpen(false)}>
              {t('cancel', { ns: 'common' })}
            </Button>
            <Button type="button" onClick={addPreset} disabled={!availableModel}>
              {t('presetAdd')}
            </Button>
          </L4AppDialogFooter>
        </L4AppDialogContent>
      </L4AppDialogRoot>
      {dialog}
    </section>
  )
}
