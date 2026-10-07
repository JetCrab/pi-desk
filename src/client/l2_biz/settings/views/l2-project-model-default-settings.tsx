'use client'

import { ArrowLeftIcon, CheckIcon, FolderIcon, LoaderCircleIcon, SaveIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2ModelOption,
  L2ModelPreset
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { L4SearchSelect } from '@client/l4_foundation/ui/l4-search-select'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { L4ChoiceGroup } from '@client/l4_foundation/ui/l4-choice-group'
import type { L2ModelSettingsBiz } from '../l2-model-settings-biz'
import { useL2ProjectModelDefaultSettings } from '../hooks/l2-use-project-model-default-settings'
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

interface Props {
  biz: L2ModelSettingsBiz
  presets: L2ModelPreset[]
  onDirtyChange?: (dirty: boolean) => void
}

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

export function L2ProjectModelDefaultSettings({
  biz,
  presets,
  onDirtyChange
}: Props): React.JSX.Element {
  const { t } = useTranslation('settings')
  const state = useL2ProjectModelDefaultSettings(biz, onDirtyChange)
  const [query, setQuery] = useState('')
  const [mobileDetail, setMobileDetail] = useState(false)
  const selectedModel = state.models.find(
    (model): boolean =>
      model.provider === state.selection?.provider && model.modelId === state.selection.modelId
  )
  const applicablePresets = presets.filter((preset): boolean =>
    state.models.some(
      (model): boolean =>
        model.provider === preset.provider &&
        model.modelId === preset.modelId &&
        model.thinkingLevels.includes(preset.thinkingLevel)
    )
  )
  const visibleDirectories = state.directories.filter((directory): boolean =>
    directory.cwd.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  const modelOptions = state.models.map(
    (model): { value: string; label: string; description: string } => ({
      value: modelKey(model.provider, model.modelId),
      label: model.name || model.modelId,
      description: model.provider
    })
  )
  const formDisabled = state.projectLoading || state.projectRefreshing || state.saving

  async function selectProject(cwd: string): Promise<void> {
    if (await state.selectProject(cwd)) setMobileDetail(true)
  }

  function selectModel(value: string): void {
    const model = state.models.find(
      (item): boolean => modelKey(item.provider, item.modelId) === value
    )
    if (model) state.selectModel(model)
  }

  return (
    <section className="@container/project-default h-full min-h-0 overflow-hidden bg-card">
      <div className="grid h-full min-h-0 grid-cols-1 @[48rem]/project-default:grid-cols-[18rem_minmax(0,1fr)]">
        <aside
          aria-label={t('projectList')}
          className={cn(
            'min-h-0 min-w-0 flex-col bg-sidebar @[48rem]/project-default:flex @[48rem]/project-default:border-r',
            mobileDetail && state.cwd ? 'hidden' : 'flex'
          )}
        >
          <div className="shrink-0 space-y-3 p-3">
            <h3 className="text-sm font-semibold">{t('projectList')}</h3>
            <Input
              value={query}
              aria-label={t('projectSearch')}
              placeholder={t('projectSearch')}
              onChange={(event): void => setQuery(event.target.value)}
            />
          </div>
          <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {state.directoriesLoading && state.directories.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
                {t('projectLoading')}
              </div>
            ) : state.directoriesError ? (
              <div className="space-y-3 px-3 py-6 text-sm">
                <p role="alert" className="break-words text-destructive">
                  {state.directoriesError}
                </p>
                <Button type="button" variant="outline" size="sm" onClick={state.retryDirectories}>
                  {t('retry', { ns: 'common' })}
                </Button>
              </div>
            ) : visibleDirectories.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('projectEmpty')}
              </p>
            ) : (
              <div className="space-y-1">
                {visibleDirectories.map((directory): React.JSX.Element => {
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
                      onClick={(): void => {
                        void selectProject(directory.cwd)
                      }}
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
          aria-label={t('projectDefaultSource')}
          className={cn(
            'min-h-0 min-w-0 flex-col @[48rem]/project-default:flex',
            mobileDetail && state.cwd ? 'flex' : 'hidden'
          )}
        >
          {!state.cwd ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <FolderIcon aria-hidden="true" className="size-6 shrink-0" />
              {t('selectProjectToConfigure')}
            </div>
          ) : (
            <>
              <div className="shrink-0 border-b px-4 py-2 @[48rem]/project-default:hidden">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={(): void => setMobileDetail(false)}
                >
                  <ArrowLeftIcon aria-hidden="true" />
                  {t('backProjectList')}
                </Button>
              </div>
              <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto p-4 @[48rem]/project-default:p-6">
                <div className="max-w-[40rem] space-y-6">
                  <header className="space-y-1">
                    <h3 className="break-all text-lg font-semibold">{projectName(state.cwd)}</h3>
                    <p className="break-all text-sm text-muted-foreground">{state.cwd}</p>
                    {state.projectLoading && !state.projectReady ? (
                      <p
                        role="status"
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                      >
                        <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
                        {t('projectLoading')}
                      </p>
                    ) : null}
                  </header>

                  {state.projectError ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <p role="alert" className="min-w-0 flex-1 break-words text-destructive">
                        {state.projectError}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={state.retryProject}
                      >
                        {t('retry', { ns: 'common' })}
                      </Button>
                    </div>
                  ) : !state.projectReady ? null : (
                    <fieldset disabled={formDisabled} className="min-w-0 space-y-6">
                      <div className="space-y-1">
                        <p className="text-sm font-medium">{t('projectDefaultSource')}</p>
                        <L4ChoiceGroup
                          label={t('projectDefaultSource')}
                          value={state.fixed ? 'fixed' : 'global'}
                          layout="segmented"
                          disabled={formDisabled}
                          options={[
                            { value: 'global', label: t('projectFollowGlobal') },
                            { value: 'fixed', label: t('projectFixed') }
                          ]}
                          onChange={(value): void => state.changeFixed(value === 'fixed')}
                        />
                      </div>

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
                              disabled={formDisabled || state.models.length === 0}
                              onChange={selectModel}
                            />
                          </Field>
                          <Field label={t('thinkingLevel')}>
                            <FixedSelect
                              value={state.selection?.thinkingLevel ?? ''}
                              options={(selectedModel?.thinkingLevels ?? []).map(
                                (level): { value: string; label: string } => ({
                                  value: level,
                                  label: t(THINKING_LABELS[level])
                                })
                              )}
                              ariaLabel={t('projectDefaultThinking')}
                              allowEmpty={false}
                              onChange={state.selectThinking}
                            />
                          </Field>

                          {applicablePresets.length > 0 ? (
                            <div>
                              <p className="text-sm font-medium">{t('fromPreset')}</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {applicablePresets.map((preset, index): React.JSX.Element => {
                                  const model: L2ModelOption | undefined = state.models.find(
                                    (item): boolean =>
                                      item.provider === preset.provider &&
                                      item.modelId === preset.modelId
                                  )
                                  return (
                                    <Button
                                      key={`${preset.provider}/${preset.modelId}/${preset.thinkingLevel}/${index}`}
                                      type="button"
                                      variant="outline"
                                      size="xs"
                                      className="h-auto min-h-7 max-w-full whitespace-normal text-left"
                                      onClick={(): void => state.applyPreset(preset)}
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
                  )}
                </div>
              </div>
              <div className="shrink-0 border-t px-4 py-3 @[48rem]/project-default:px-6">
                <Button
                  type="button"
                  onClick={state.save}
                  disabled={
                    !state.projectReady || formDisabled || (state.fixed && !state.selection)
                  }
                >
                  {state.saving ? (
                    <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
                  ) : (
                    <SaveIcon aria-hidden="true" />
                  )}
                  {state.saving ? t('savingModels') : t('saveProjectDefault')}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
      {state.dialog}
    </section>
  )
}
