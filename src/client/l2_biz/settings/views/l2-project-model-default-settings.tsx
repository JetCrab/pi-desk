'use client'

import { ArrowLeftIcon, CheckIcon, GlobeIcon, SaveIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { L3CapabilityModeNames } from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import { L4LoadingSpinner } from '@client/l4_foundation/ui/loading/l4-loading-spinner'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { L4SearchSelect } from '@client/l4_foundation/ui/l4-search-select'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { L4ChoiceGroup } from '@client/l4_foundation/ui/l4-choice-group'
import type { L2ProjectModelDefaultSettingsState } from '../hooks/l2-use-project-model-default-settings'
import { Field, FixedSelect } from './l2-model-settings-form'

const THINKING_LABELS = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax'
} as const

function modelKey(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId])
}

function projectName(cwd: string): string {
  return (
    cwd
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || cwd
  )
}

function RequestError({
  message,
  onRetry,
  disabled = false
}: {
  message: string | null
  onRetry: () => void
  disabled?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('common')
  if (!message) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <p role="alert" className="min-w-0 flex-1 break-words text-destructive">
        {message}
      </p>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  )
}

export function L2ProjectModelDefaultSettings({
  state,
  modeNames
}: {
  state: L2ProjectModelDefaultSettingsState
  modeNames: L3CapabilityModeNames
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [query, setQuery] = useState('')
  const [mobileDetail, setMobileDetail] = useState(false)
  const global = state.cwd === null
  const selectedModel = state.models.find(
    (model) =>
      model.provider === state.selection?.provider && model.modelId === state.selection.modelId
  )
  const applicablePresets = state.presets.filter((preset) =>
    state.models.some(
      (model) =>
        model.provider === preset.provider &&
        model.modelId === preset.modelId &&
        model.thinkingLevels.includes(preset.thinkingLevel)
    )
  )
  const visibleDirectories = state.directories.filter((directory) =>
    directory.cwd.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  const modelOptions = state.models.map((model) => ({
    value: modelKey(model.provider, model.modelId),
    label: model.name || model.modelId,
    description: model.provider
  }))
  const modelDisabled = !state.modelReady || state.saving
  const modeDisabled = !state.modeReady || state.saving
  const missingMode =
    typeof state.defaultMode === 'string' && !Object.hasOwn(modeNames, state.defaultMode)
  const modeOptions = [
    ...(!global ? [{ value: 'follow', label: t('projectModeFollowGlobal') }] : []),
    { value: 'all', label: t('projectModeAllEnabled') },
    ...Object.entries(modeNames).map(([key, name]) => ({ value: `mode:${key}`, label: name })),
    ...(missingMode
      ? [
          {
            value: `mode:${state.defaultMode}`,
            label: t('projectModeMissing', { key: state.defaultMode })
          }
        ]
      : [])
  ]

  async function selectProject(cwd: string | null): Promise<void> {
    if (await state.selectProject(cwd)) setMobileDetail(true)
  }

  return (
    <section
      aria-label={t('projectDefault')}
      className="@container/project-default h-full min-h-0 overflow-hidden bg-card"
    >
      <div className="grid h-full min-h-0 grid-cols-1 @[48rem]/project-default:grid-cols-[18rem_minmax(0,1fr)]">
        <aside
          aria-label={t('projectList')}
          className={cn(
            'min-h-0 min-w-0 flex-col bg-sidebar @[48rem]/project-default:flex @[48rem]/project-default:border-r',
            mobileDetail ? 'hidden' : 'flex'
          )}
        >
          <div className="shrink-0 space-y-3 p-3">
            <h3 className="text-sm font-semibold">{t('projectList')}</h3>
            <Input
              value={query}
              aria-label={t('projectSearch')}
              placeholder={t('projectSearch')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <Button
              type="button"
              variant="ghost"
              aria-current={global ? 'true' : undefined}
              disabled={state.saving}
              className={cn(
                'mb-3 h-auto min-h-14 w-full justify-start whitespace-normal px-3 py-2 text-left',
                global && 'bg-accent text-accent-foreground ring-1 ring-border ring-inset'
              )}
              onClick={() => void selectProject(null)}
            >
              <GlobeIcon aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">{t('projectGlobalReference')}</span>
              {global ? <CheckIcon aria-hidden="true" className="size-4 shrink-0" /> : null}
            </Button>
            {state.directoriesLoading && state.directories.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <L4LoadingSpinner aria-hidden="true" className="size-4" />
                {t('projectLoading')}
              </div>
            ) : state.directoriesError ? (
              <div className="px-3 py-6">
                <RequestError message={state.directoriesError} onRetry={state.retryDirectories} />
              </div>
            ) : visibleDirectories.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('projectEmpty')}
              </p>
            ) : (
              <div className="space-y-1">
                {visibleDirectories.map((directory) => {
                  const selected = directory.cwd === state.cwd
                  return (
                    <Button
                      key={directory.cwd}
                      type="button"
                      variant="ghost"
                      aria-current={selected ? 'true' : undefined}
                      disabled={state.saving}
                      className={cn(
                        'h-auto min-h-14 w-full items-start justify-start gap-2 whitespace-normal px-3 py-2 text-left',
                        selected && 'bg-accent text-accent-foreground ring-1 ring-border ring-inset'
                      )}
                      onClick={() => void selectProject(directory.cwd)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 break-all text-sm font-medium">
                            {projectName(directory.cwd)}
                          </span>
                          {selected ? (
                            <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                          ) : null}
                        </span>
                        <span className="mt-1 block break-all text-xs font-normal text-muted-foreground">
                          {directory.cwd}
                        </span>
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          {t('projectSessionCount', { count: directory.sessionCount })}
                        </span>
                      </span>
                    </Button>
                  )
                })}
              </div>
            )}
          </div>
        </aside>
        <section
          aria-label={global ? t('projectGlobalReference') : t('projectDefault')}
          className={cn(
            'min-h-0 min-w-0 flex-col @[48rem]/project-default:flex',
            mobileDetail ? 'flex' : 'hidden'
          )}
        >
          <div className="shrink-0 border-b px-4 py-2 @[48rem]/project-default:hidden">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMobileDetail(false)}>
              <ArrowLeftIcon aria-hidden="true" />
              {t('backProjectList')}
            </Button>
          </div>
          <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto p-4 @[48rem]/project-default:p-6">
            <div className="max-w-[40rem] space-y-6">
              <header className="space-y-1">
                <h3 className="break-all text-lg font-semibold">
                  {state.cwd === null ? t('projectGlobalReference') : projectName(state.cwd)}
                </h3>
                {!global ? (
                  <p className="break-all text-sm text-muted-foreground">{state.cwd}</p>
                ) : null}
              </header>
              <section className="space-y-3" aria-label={t('projectDefaultModel')}>
                <h4 className="text-sm font-semibold">{t('projectDefaultModel')}</h4>
                {global ? (
                  <p className="text-sm text-muted-foreground">{t('projectModelManagedByPi')}</p>
                ) : (
                  <>
                    <RequestError
                      message={state.projectError}
                      onRetry={state.retryProject}
                      disabled={state.projectLoading || state.saving}
                    />
                    {state.projectLoading ? (
                      <p
                        role="status"
                        className="flex items-center gap-2 text-sm text-muted-foreground"
                      >
                        <L4LoadingSpinner aria-hidden="true" className="size-4" />
                        {t('projectLoading')}
                      </p>
                    ) : null}
                    <fieldset disabled={modelDisabled} className="min-w-0 space-y-4">
                      <L4ChoiceGroup
                        label={t('projectDefaultSource')}
                        value={state.fixed ? 'fixed' : 'global'}
                        layout="segmented"
                        disabled={modelDisabled}
                        options={[
                          { value: 'global', label: t('projectFollowGlobal') },
                          { value: 'fixed', label: t('projectFixed') }
                        ]}
                        onChange={(value) => state.changeFixed(value === 'fixed')}
                      />
                      {state.fixed ? (
                        <div className="space-y-3">
                          <Field label={t('projectDefaultModel')}>
                            <L4SearchSelect
                              value={
                                state.selection
                                  ? modelKey(state.selection.provider, state.selection.modelId)
                                  : ''
                              }
                              options={modelOptions}
                              ariaLabel={t('projectDefaultModel')}
                              searchPlaceholder={t('modelSearch')}
                              disabled={modelDisabled || state.models.length === 0}
                              onChange={(value) => {
                                const model = state.models.find(
                                  (item) => modelKey(item.provider, item.modelId) === value
                                )
                                if (model) state.selectModel(model)
                              }}
                            />
                          </Field>
                          <Field label={t('thinkingLevel')}>
                            <FixedSelect
                              value={state.selection?.thinkingLevel ?? ''}
                              options={(selectedModel?.thinkingLevels ?? []).map((level) => ({
                                value: level,
                                label: t(THINKING_LABELS[level])
                              }))}
                              ariaLabel={t('projectDefaultThinking')}
                              allowEmpty={false}
                              onChange={state.selectThinking}
                            />
                          </Field>
                          {applicablePresets.length > 0 ? (
                            <div>
                              <p className="text-sm font-medium">{t('fromPreset')}</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {applicablePresets.map((preset, index) => {
                                  const model = state.models.find(
                                    (item) =>
                                      item.provider === preset.provider &&
                                      item.modelId === preset.modelId
                                  )
                                  return (
                                    <Button
                                      key={`${preset.provider}/${preset.modelId}/${preset.thinkingLevel}/${index}`}
                                      type="button"
                                      variant="outline"
                                      size="xs"
                                      disabled={modelDisabled}
                                      className="h-auto min-h-7 max-w-full whitespace-normal text-left"
                                      onClick={() => state.applyPreset(preset)}
                                    >
                                      <span
                                        className="size-2 shrink-0 rounded-full bg-current"
                                        style={preset.color ? { color: preset.color } : undefined}
                                      />
                                      <span className="min-w-0 break-all">
                                        {model?.name || preset.modelId} ·{' '}
                                        {t(THINKING_LABELS[preset.thinkingLevel])}
                                      </span>
                                    </Button>
                                  )
                                })}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </fieldset>
                    <RequestError
                      message={state.presetsError}
                      onRetry={state.retryPresets}
                      disabled={state.saving}
                    />
                  </>
                )}
                {state.saveErrors.model ? (
                  <p role="alert" className="break-words text-sm text-destructive">
                    {t('projectOwnerSaveFailed', {
                      owner: t('projectDefaultModel'),
                      message: state.saveErrors.model
                    })}
                  </p>
                ) : null}
              </section>
              <section className="space-y-3 border-t pt-6" aria-label={t('projectDefaultMode')}>
                <h4 className="text-sm font-semibold">
                  {global ? t('projectGlobalDefaultMode') : t('projectDefaultMode')}
                </h4>
                <RequestError
                  message={state.modeError}
                  onRetry={state.retryMode}
                  disabled={state.modeLoading || state.saving}
                />
                {state.modeLoading ? (
                  <p
                    role="status"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <L4LoadingSpinner aria-hidden="true" className="size-4" />
                    {t('projectLoading')}
                  </p>
                ) : null}
                <L4SearchSelect
                  value={
                    state.defaultMode === undefined
                      ? global
                        ? 'all'
                        : 'follow'
                      : state.defaultMode === null
                        ? 'all'
                        : `mode:${state.defaultMode}`
                  }
                  options={modeOptions}
                  ariaLabel={global ? t('projectGlobalDefaultMode') : t('projectDefaultMode')}
                  searchPlaceholder={t('projectModeSearch')}
                  disabled={modeDisabled}
                  onChange={(value) =>
                    state.changeDefaultMode(
                      value === 'follow' ? undefined : value === 'all' ? null : value.slice(5)
                    )
                  }
                />
                {missingMode ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {t('projectModeMissingDescription')}
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {t('projectDefaultsApplyDescription')}
                </p>
                {state.saveErrors.mode ? (
                  <p role="alert" className="break-words text-sm text-destructive">
                    {t('projectOwnerSaveFailed', {
                      owner: t('projectDefaultMode'),
                      message: state.saveErrors.mode
                    })}
                  </p>
                ) : null}
              </section>
            </div>
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3 @[48rem]/project-default:px-6">
            <div role="status" className="min-w-0 text-sm text-muted-foreground">
              {state.savedOwners.length > 0 ? (
                <p>{t('projectOwnersSaved', { owners: state.savedOwners.join(', ') })}</p>
              ) : null}
              {state.saveErrors.model || state.saveErrors.mode ? (
                <p>{t('projectDefaultsRetryFailed')}</p>
              ) : state.dirty ? (
                <p>{t('projectDefaultsUnsaved')}</p>
              ) : null}
            </div>
            <Button type="button" onClick={state.save} disabled={!state.canSave}>
              {state.saving ? (
                <L4LoadingSpinner aria-hidden="true" />
              ) : (
                <SaveIcon aria-hidden="true" />
              )}
              {state.saving ? t('savingModels') : t('saveProjectDefault')}
            </Button>
          </footer>
        </section>
      </div>
      {state.dialog}
    </section>
  )
}
