'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeftIcon,
  CopyIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon
} from 'lucide-react'
import type { L3CapabilityModeNames } from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import { useL4AppSocket } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { L4LoadingSpinner } from '@client/l4_foundation/ui/loading/l4-loading-spinner'
import { L4ChoiceGroup } from '@client/l4_foundation/ui/l4-choice-group'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { createL2CapabilityModesBiz } from './l2-capability-modes-biz'
import {
  l2CapabilityModeDirty,
  l2PromptDirty,
  type L2CapabilitySelection
} from './l2-capability-modes-drafts'
import type { L2CapabilityModeView } from './l2-capability-modes-model'
import { useL2CapabilityModes } from './hooks/l2-use-capability-modes'
import { L2CapabilityModeEditor } from './views/l2-capability-mode-editor'
import { L2CapabilityModeList } from './views/l2-capability-mode-list'
import { L2CapabilityModesConfirm } from './views/l2-capability-modes-confirm'
import { L2SystemPromptEditor } from './views/l2-system-prompt-editor'

export interface L2CapabilityModesSettingsProps {
  modeNames: L3CapabilityModeNames
  source?: L2ChatSource | null
  onBeforeLeaveChange: (handler: (() => Promise<boolean>) | null) => void
}

export function L2CapabilityModesSettings({
  modeNames,
  source = null,
  onBeforeLeaveChange
}: L2CapabilityModesSettingsProps): React.JSX.Element {
  const { t } = useTranslation('capabilityModes')
  const { clientId } = useL4AppSocket()
  const toast = useL4AppToast()
  const biz = useMemo(() => createL2CapabilityModesBiz(clientId), [clientId])
  const editor = useL2CapabilityModes(biz)
  const [deleteName, setDeleteName] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [mobileDetail, setMobileDetail] = useState(false)
  const [views, setViews] = useState<Record<string, L2CapabilityModeView>>({})
  const { beforeLeave } = editor
  useEffect(() => {
    onBeforeLeaveChange(beforeLeave)
    return (): void => onBeforeLeaveChange(null)
  }, [beforeLeave, onBeforeLeaveChange])
  const { drafts, selected } = editor
  const global = selected.kind === 'global'
  const builtin = selected.kind === 'all'
  const modeKey = selected.kind === 'mode' ? selected.key : undefined
  const mode = modeKey === undefined ? undefined : drafts.modes[modeKey]
  const identity = JSON.stringify(selected)
  const view = views[identity] ?? { tab: 'prompt', groupKey: 'tools', queries: {}, rulesOpen: {} }
  const changeView = (next: L2CapabilityModeView): void =>
    setViews((current) => ({ ...current, [identity]: next }))
  const forgetView = (): void =>
    setViews((current) => {
      const next = { ...current }
      delete next[identity]
      return next
    })
  const busy = editor.saving || editor.copying
  const promptSource = mode?.promptSource ?? 'global'
  const prompt = global
    ? drafts.global
    : promptSource === 'custom' && modeKey !== undefined
      ? drafts.prompts[modeKey]
      : null
  const content =
    global || promptSource === 'custom'
      ? (prompt?.content ?? null)
      : promptSource === 'none'
        ? ''
        : (drafts.global?.saved ?? null)
  const promptErrorId =
    modeKey !== undefined && promptSource === 'custom' ? `mode:${modeKey}` : 'global'
  const dirty = global
    ? l2PromptDirty(drafts.global)
    : modeKey !== undefined && l2CapabilityModeDirty(drafts, modeKey)
  const select = (item: L2CapabilitySelection): void => {
    void editor.select(item).then((success) => {
      if (!success) return
      setMobileDetail(true)
      if (item.kind === 'all' && views[JSON.stringify(item)]?.tab === 'capabilities')
        void editor.load()
    })
  }
  const save = async (): Promise<void> => {
    if (await editor.save()) toast.success(t(global ? 'globalSaved' : 'saved'))
  }
  const itemName = (item: L2CapabilitySelection): string =>
    item.kind === 'global'
      ? t('globalPrompt')
      : item.kind === 'mode'
        ? drafts.modes[item.key]?.name || modeNames[item.key] || t('unnamedMode')
        : t('allEnabled')

  return (
    <section
      aria-label={t('settings')}
      className="@container flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <span className="text-sm font-medium @min-[640px]:sr-only">{t('workingModes')}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || editor.loading}
            onClick={() => {
              void editor.add().then((success) => {
                if (success) setMobileDetail(true)
              })
            }}
          >
            <PlusIcon className="size-4" />
            {t('addMode')}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('refreshCatalog')}
            title={t('refreshCatalog')}
            disabled={busy || editor.loading}
            onClick={() => void editor.load(true)}
          >
            {editor.loading ? (
              <L4LoadingSpinner className="size-4" />
            ) : (
              <RefreshCwIcon className="size-4" />
            )}
          </Button>
        </div>
      </header>
      {editor.error && (
        <div
          role="alert"
          className="shrink-0 whitespace-pre-wrap border-b px-4 py-3 text-sm text-destructive"
        >
          {editor.error}
        </div>
      )}
      {editor.loading && drafts.saved === null && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b px-4 py-3 text-sm text-muted-foreground"
        >
          <L4LoadingSpinner className="size-4" />
          {t('loadingCatalog')}
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 @min-[640px]:grid-cols-[13rem_minmax(0,1fr)]">
        <div className={cn('min-h-0 border-r', mobileDetail ? 'hidden @min-[640px]:grid' : 'grid')}>
          <L2CapabilityModeList
            drafts={drafts}
            modeNames={modeNames}
            selected={selected}
            query={query}
            disabled={busy}
            onQuery={setQuery}
            onSelect={select}
          />
        </div>
        <div
          className={cn(
            'min-h-0 min-w-0 flex-col',
            mobileDetail ? 'flex' : 'hidden @min-[640px]:flex'
          )}
        >
          <div className="shrink-0 space-y-3 border-b px-4 py-3">
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2 @min-[640px]:hidden"
              onClick={() => setMobileDetail(false)}
            >
              <ArrowLeftIcon className="size-4" />
              {t('modeList')}
            </Button>
            <div className="flex flex-wrap items-center justify-between gap-2">
              {mode ? (
                <label className="min-w-40 flex-1">
                  <span className="sr-only">{t('modeName')}</span>
                  <Input
                    aria-label={t('modeName')}
                    value={mode.name}
                    maxLength={64}
                    disabled={busy}
                    onChange={(event) => editor.update({ ...mode, name: event.target.value })}
                  />
                </label>
              ) : (
                <h2 className="text-sm font-semibold">
                  {global ? t('globalPrompt') : t('allEnabled')}
                  {builtin && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {t('builtin')}
                    </span>
                  )}
                </h2>
              )}
              {!global && (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || editor.loading}
                    onClick={() => void editor.add(true)}
                  >
                    {editor.copying ? (
                      <L4LoadingSpinner className="size-4" />
                    ) : (
                      <CopyIcon className="size-4" />
                    )}
                    {t('copyTitle')}
                  </Button>
                  {mode && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('deleteMode')}
                      title={t('deleteTitle')}
                      disabled={busy}
                      onClick={() => setDeleteName(mode.name || t('unnamedMode'))}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  )}
                </div>
              )}
            </div>
            {!global && (
              <L4ChoiceGroup<'prompt' | 'capabilities'>
                label={t('modeConfiguration')}
                layout="segmented"
                value={view.tab}
                options={[
                  { value: 'prompt', label: t('systemPrompt') },
                  { value: 'capabilities', label: t('capabilities') }
                ]}
                onChange={(tab) => {
                  changeView({ ...view, tab })
                  if (tab === 'capabilities') void editor.load()
                }}
              />
            )}
          </div>
          {global || view.tab === 'prompt' ? (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <L2SystemPromptEditor
                key={identity}
                global={global}
                builtin={builtin}
                promptSource={promptSource}
                content={content}
                globalDirty={l2PromptDirty(drafts.global)}
                error={editor.promptErrors[promptErrorId] ?? null}
                disabled={busy}
                source={source}
                biz={biz}
                onSourceChange={(value) => {
                  if (mode) editor.update({ ...mode, promptSource: value })
                }}
                onChange={editor.updatePrompt}
                onReset={editor.resetPrompt}
                onRetry={() =>
                  void editor.ensurePrompt(
                    modeKey !== undefined && promptSource === 'custom' ? modeKey : undefined
                  )
                }
                onEditGlobal={() => select({ kind: 'global' })}
              />
            </div>
          ) : editor.catalog ? (
            <L2CapabilityModeEditor
              modeKey={modeKey ?? ''}
              mode={mode ?? { name: t('allEnabled') }}
              catalog={editor.catalog}
              disabled={busy}
              readOnly={builtin}
              view={view}
              onViewChange={changeView}
              onChange={editor.update}
            />
          ) : (
            <div className="flex-1 space-y-3 p-4">
              {editor.loading ? null : (
                <>
                  <p className="text-sm text-muted-foreground">{t('catalogFailed')}</p>
                  <Button size="sm" variant="outline" onClick={() => void editor.load()}>
                    {t('retryRead')}
                  </Button>
                </>
              )}
            </div>
          )}
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">
            <span role="status" className="text-xs text-muted-foreground">
              {dirty ? t('unsaved') : builtin ? t('allDescription') : t('savedState')}
              {editor.dirtyItems.length > (dirty ? 1 : 0) && (
                <span className="block pt-1">
                  {t('otherDrafts', { count: editor.dirtyItems.length - (dirty ? 1 : 0) })}
                </span>
              )}
            </span>
            {!builtin && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!dirty || busy}
                  onClick={() => {
                    editor.discard()
                    if (modeKey !== undefined && !drafts.saved?.[modeKey]) forgetView()
                  }}
                >
                  {t('discardCurrent')}
                </Button>
                <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
                  {editor.saving ? (
                    <L4LoadingSpinner className="size-4" />
                  ) : (
                    <SaveIcon className="size-4" />
                  )}
                  {editor.saving ? t('saving') : global ? t('saveGlobal') : t('saveCurrent')}
                </Button>
              </div>
            )}
          </footer>
        </div>
      </div>
      <L2CapabilityModesConfirm
        open={editor.leaveOpen || deleteName !== null}
        deleteName={deleteName}
        saving={editor.saving}
        error={editor.error}
        unsavedNames={editor.dirtyItems.map(itemName)}
        onCancel={() => {
          if (deleteName !== null) setDeleteName(null)
          else void editor.decideLeave('cancel')
        }}
        onDelete={() => {
          void editor.remove().then((success) => {
            if (success) {
              setDeleteName(null)
              forgetView()
              toast.success(t('deleted'))
            }
          })
        }}
        onLeave={(choice) => void editor.decideLeave(choice)}
      />
    </section>
  )
}
