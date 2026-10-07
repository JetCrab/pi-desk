'use client'

import {
  CodeIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SaveIcon
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserBeforeLeaveHandler } from '@jetcrab/pi-desk-sdk/browser'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Popover, PopoverContent, PopoverTrigger } from '@client/l4_foundation/ui/shadcn/popover'
import { L4ChoiceGroup } from '@client/l4_foundation/ui/l4-choice-group'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { useL2ModelSettings, type ModelSettingsTab } from '../hooks/l2-use-model-settings'
import { L2ModelNativeDialog } from './l2-model-native-dialog'
import { L2ModelPresetSettings } from './l2-model-preset-settings'
import { L2ModelProviderSettings } from './l2-model-provider-settings'
import { L2ProjectModelDefaultSettings } from './l2-project-model-default-settings'

const MODEL_SETTINGS_TABS: Array<{ value: ModelSettingsTab; label: string }> = [
  { value: 'providers', label: 'modelProviders' },
  { value: 'presets', label: 'modelPresets' },
  { value: 'project-default', label: 'projectDefault' }
]

function ModelSettingsPlaceholder({
  loading,
  error,
  onRetry
}: {
  loading: boolean
  error: string | null
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className="flex min-h-72 flex-col items-center justify-center gap-3 p-5 text-sm text-muted-foreground">
      {loading ? (
        <span className="flex items-center gap-2">
          <LoaderCircleIcon className="size-4 animate-spin" /> {t('loadingModels')}
        </span>
      ) : (
        <>
          <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">
            {error ?? t('modelsUnavailable')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t('retry', { ns: 'common' })}
          </Button>
        </>
      )}
    </div>
  )
}

export function L2ModelSettingsView({
  onBeforeLeaveChange,
  initialTab
}: {
  onBeforeLeaveChange: (handler: BrowserBeforeLeaveHandler | null) => void
  initialTab?: ModelSettingsTab
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { locale, timeZone } = useL4Region()
  const [toolsOpen, setToolsOpen] = useState(false)
  const {
    biz,
    tab,
    settings,
    providers,
    presets,
    resetVersion,
    formDirty,
    formInvalid,
    serviceDirty,
    nativeOpen,
    nativeText,
    nativeError,
    nativeDirty,
    setNativeText,
    openNative,
    closeNative,
    saveNative,
    revertConfig,
    setInputState,
    setServiceDirty,
    loading,
    saving,
    refreshing,
    catalogUpdatedAt,
    loadError,
    dialog,
    setProjectDefaultDirty,
    changeProviders,
    changePresets,
    selectTab,
    retry,
    refreshCatalog,
    saveConfig
  } = useL2ModelSettings(onBeforeLeaveChange, initialTab)

  return (
    <div className="@container/model-settings flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b p-4">
        <L4ChoiceGroup<ModelSettingsTab>
          label={t('models')}
          layout="segmented"
          value={tab}
          options={MODEL_SETTINGS_TABS.map((option) => ({ ...option, label: t(option.label) }))}
          onChange={selectTab}
        />
        <div className="hidden gap-2 @[40rem]/model-settings:flex">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!settings || saving}
            onClick={openNative}
          >
            <CodeIcon />
            {t('nativeConfig')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            title={
              catalogUpdatedAt
                ? t('catalogUpdatedAt', {
                    time: new Date(catalogUpdatedAt).toLocaleString(
                      locale === 'en' ? 'en-US' : 'zh-CN',
                      { timeZone, timeZoneName: 'shortOffset', hourCycle: 'h23' }
                    )
                  })
                : t('catalogUnavailable')
            }
            onClick={refreshCatalog}
            disabled={refreshing}
          >
            <RefreshCwIcon className={cn(refreshing && 'animate-spin')} />
            {refreshing ? t('refreshingCatalog') : t('refreshCatalog')}
          </Button>
        </div>
        <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('modelMoreActions')}
                className="shrink-0 @[40rem]/model-settings:hidden"
              >
                <MoreHorizontalIcon />
              </Button>
            }
          />
          <PopoverContent align="end" positionerClassName="z-[120]" className="w-48 gap-1 p-1">
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              disabled={!settings || saving}
              onClick={() => {
                setToolsOpen(false)
                openNative()
              }}
            >
              <CodeIcon />
              {t('nativeConfig')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              disabled={refreshing}
              onClick={() => {
                setToolsOpen(false)
                void refreshCatalog()
              }}
            >
              <RefreshCwIcon />
              {t('refreshCatalog')}
            </Button>
          </PopoverContent>
        </Popover>
      </div>

      <div
        className={cn(
          'pi-desk-chat-scrollbar min-h-0 flex-1',
          tab === 'presets' ? 'overflow-y-auto' : 'overflow-hidden'
        )}
      >
        {tab === 'project-default' ? (
          <L2ProjectModelDefaultSettings
            biz={biz}
            presets={settings?.presets ?? []}
            onDirtyChange={setProjectDefaultDirty}
          />
        ) : !settings ? (
          <ModelSettingsPlaceholder loading={loading} error={loadError} onRetry={retry} />
        ) : null}
        {settings ? (
          <>
            <fieldset
              disabled={saving}
              className={cn('h-full min-h-0 min-w-0', tab !== 'providers' && 'hidden')}
            >
              <L2ModelProviderSettings
                biz={biz}
                providers={providers}
                savedProviders={settings.providers}
                savedModels={settings.models}
                presets={presets}
                resetVersion={resetVersion}
                onChange={changeProviders}
                onPresetsChange={changePresets}
                onInputState={setInputState}
                onServiceDirtyChange={setServiceDirty}
              />
            </fieldset>
            <fieldset disabled={saving} className={cn('min-w-0', tab !== 'presets' && 'hidden')}>
              <L2ModelPresetSettings
                presets={presets}
                models={settings.models}
                onChange={changePresets}
              />
            </fieldset>
          </>
        ) : null}
      </div>
      {tab !== 'project-default' && settings ? (
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t bg-card px-4 py-3">
          <span
            className={cn('text-xs text-muted-foreground', formInvalid && 'text-destructive')}
            role="status"
          >
            {formInvalid
              ? t('fixModelInputs')
              : formDirty
                ? t('modelDraftPending')
                : t('modelDraftClean')}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving || !formDirty || serviceDirty}
              onClick={revertConfig}
            >
              {t('revertModels')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={saveConfig}
              disabled={saving || !formDirty || formInvalid || serviceDirty}
            >
              {saving ? <LoaderCircleIcon className="animate-spin" /> : <SaveIcon />}
              {saving ? t('savingModels') : t('saveModels')}
            </Button>
          </div>
        </footer>
      ) : null}
      <L2ModelNativeDialog
        open={nativeOpen}
        text={nativeText}
        error={nativeError}
        saving={saving}
        dirty={nativeDirty}
        onChange={setNativeText}
        onClose={closeNative}
        onSave={saveNative}
      />
      {dialog}
    </div>
  )
}
