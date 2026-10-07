'use client'

import {
  ArrowLeftIcon,
  DatabaseIcon,
  PlusIcon,
  Settings2Icon,
  ServerIcon,
  StarIcon,
  Trash2Icon
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2ModelOption,
  L2ModelPreset,
  L2ModelProviderConfig
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@client/l4_foundation/ui/shadcn/tooltip'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { useL4ConfirmDialog } from '@client/l4_foundation/ui/l4-confirm-dialog'
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
import { Field, FixedSelect, tokensToK } from './l2-model-settings-form'

interface Props {
  biz: L2ModelSettingsBiz
  providers: L2ModelProviderConfig[]
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
  providers,
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
  const state = useL2ModelProviderSettings(providers, onChange, onInputState, resetVersion)
  const { selection, mobileDetail, query, setQuery, modelKeys, serviceIndex, newService } = state
  const groups = useRef(new Map<number, HTMLElement>())
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const [presetOpen, setPresetOpen] = useState(false)
  const [presetLevel, setPresetLevel] = useState<L2ModelPreset['thinkingLevel']>('off')
  const selectedProvider = selection ? providers[selection.providerIndex] : null
  const selectedModel = selection ? selectedProvider?.models[selection.modelIndex] : null
  const serviceId = selectedProvider?.provider || t('providerUnnamed')
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
  const availableModel =
    selectedProvider &&
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
    state.backToList()
    window.requestAnimationFrame(() => {
      if (!selection) return
      const key = modelKeys[selection.providerIndex]?.[selection.modelIndex]
      groups.current.get(selection.providerIndex)?.scrollIntoView({ block: 'nearest' })
      rows.current.get(key)?.scrollIntoView({ block: 'nearest' })
      rows.current.get(key)?.focus({ preventScroll: true })
    })
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
            mobileDetail && selectedModel ? 'hidden' : 'flex'
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
            {providers.map((provider, providerIndex) => {
              const name = provider.provider || t('providerUnnamed')
              const matchingModels = provider.models
                .map((model, modelIndex) => ({ model, modelIndex }))
                .filter(({ model }) =>
                  `${name} ${model.name} ${model.modelId}`
                    .toLocaleLowerCase()
                    .includes(query.toLocaleLowerCase())
                )
              if (
                query &&
                !matchingModels.length &&
                !name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
              )
                return null
              return (
                <section
                  key={providerIndex}
                  ref={(node) => {
                    if (node) groups.current.set(providerIndex, node)
                    else groups.current.delete(providerIndex)
                  }}
                  className="mb-3"
                >
                  <div className="flex items-center gap-2 px-2 py-1 text-foreground">
                    <ServerIcon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>
                    <span className="text-xs text-muted-foreground">{provider.models.length}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('serviceSettingsNamed', { name })}
                      onClick={() => state.openService(providerIndex)}
                    >
                      <Settings2Icon />
                    </Button>
                  </div>
                  <div className="space-y-1">
                    {matchingModels.map(({ model, modelIndex }) => {
                      const selected =
                        selection?.providerIndex === providerIndex &&
                        selection.modelIndex === modelIndex
                      const key = modelKeys[providerIndex]?.[modelIndex]
                      return (
                        <button
                          key={key}
                          ref={(node) => {
                            if (node) rows.current.set(key, node)
                            else rows.current.delete(key)
                          }}
                          type="button"
                          aria-current={selected ? 'true' : undefined}
                          className={cn(
                            'flex min-h-14 w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                            selected && 'bg-accent text-accent-foreground'
                          )}
                          onClick={() => state.selectModel(providerIndex, modelIndex)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {model.name || model.modelId || t('modelUnnamed')}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {tokensToK(model.contextWindow)} K ·{' '}
                              {t(model.input.includes('image') ? 'imageInput' : 'textInput')}
                            </span>
                          </span>
                          {presets.some(
                            (preset) =>
                              preset.provider === provider.provider &&
                              preset.modelId === model.modelId
                          ) ? (
                            <StarIcon className="size-4 shrink-0 text-muted-foreground" />
                          ) : null}
                        </button>
                      )
                    })}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-1 w-full border border-dashed border-input"
                      aria-label={t('modelAddToService', { name })}
                      onClick={() => state.addModel(providerIndex)}
                    >
                      <PlusIcon />
                    </Button>
                  </div>
                </section>
              )
            })}
            {!providers.length ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('providerEmpty')}
              </p>
            ) : null}
          </div>
          <div className="shrink-0 border-t p-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => state.openService(null)}
            >
              <PlusIcon />
              {t('providerNew')}
            </Button>
          </div>
        </aside>

        <section
          aria-label={t('modelsHeading')}
          className={cn(
            'min-h-0 min-w-0 flex-col @[48rem]/models:flex',
            mobileDetail && selectedModel ? 'flex' : 'hidden'
          )}
        >
          {!selectedModel || !selection ? (
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
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{serviceId}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('currentServiceSettings')}
                  onClick={() => state.openService(selection.providerIndex)}
                >
                  <Settings2Icon />
                </Button>
              </div>
              <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto p-4 @[48rem]/models:p-6">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="min-w-0 break-all text-lg font-semibold">
                    {selectedModel.name || selectedModel.modelId || t('modelUnnamed')}
                  </h3>
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
                            aria-label={t('modelDeleteNamed', {
                              name: selectedModel.name || selectedModel.modelId || t('modelUnnamed')
                            })}
                            onClick={removeModel}
                          >
                            <Trash2Icon />
                          </Button>
                        }
                      />
                      <TooltipContent>{t('modelDelete')}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                {providers.flatMap((provider, providerIndex) =>
                  provider.models.map((model, modelIndex) => {
                    const selected =
                      selection.providerIndex === providerIndex &&
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
