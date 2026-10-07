'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CopyIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  ShieldCheckIcon,
  Trash2Icon
} from 'lucide-react'
import {
  l3CapabilityModeNames,
  type L3CapabilityModeNames
} from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import { useL4AppSocket } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'
import { createL2CapabilityModesBiz } from './l2-capability-modes-biz'
import { useL2CapabilityModes } from './hooks/l2-use-capability-modes'
import { L2CapabilityModeEditor } from './views/l2-capability-mode-editor'
import { L2CapabilityModesConfirm } from './views/l2-capability-modes-confirm'

export function L2CapabilityModesSettings({
  modeNames,
  onBeforeLeaveChange
}: {
  modeNames: L3CapabilityModeNames
  onBeforeLeaveChange: (handler: (() => Promise<boolean>) | null) => void
}): React.JSX.Element {
  const { t } = useTranslation('capabilityModes')
  const { clientId } = useL4AppSocket()
  const toast = useL4AppToast()
  const biz = useMemo(() => createL2CapabilityModesBiz(clientId), [clientId])
  const editor = useL2CapabilityModes(biz)
  const [deleteName, setDeleteName] = useState<string | null>(null)
  const { beforeLeave } = editor
  useEffect(() => {
    onBeforeLeaveChange(beforeLeave)
    return (): void => onBeforeLeaveChange(null)
  }, [beforeLeave, onBeforeLeaveChange])
  const names = editor.saved === null ? modeNames : l3CapabilityModeNames(editor.draft)
  const mode = editor.selected ? editor.draft[editor.selected] : undefined
  const busy = editor.loading || editor.saving
  const save = async (): Promise<void> => {
    if (await editor.save()) toast.success(t('saved'))
  }
  const saveButton = (
    <Button size="sm" disabled={!editor.dirty || busy} onClick={() => void save()}>
      {editor.saving ? (
        <LoaderCircleIcon className="size-4 animate-spin" />
      ) : (
        <SaveIcon className="size-4" />
      )}
      {editor.saving ? t('saving') : t('saveModes')}
    </Button>
  )

  return (
    <section aria-label={t('settings')} className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-sm font-medium">{t('editMode')}</span>
          <Select
            value={editor.selected ?? ''}
            disabled={busy}
            onValueChange={(value) => {
              if (typeof value === 'string') void editor.select(value || null)
            }}
          >
            <SelectTrigger aria-label={t('selectMode')} className="w-40 sm:w-48">
              <SelectValue>
                {editor.selected ? names[editor.selected] || t('unnamedMode') : t('allDefault')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent positionerClassName="z-[140]">
              <SelectItem value="">{t('allDefault')}</SelectItem>
              {Object.entries(names).map(([key, name]) => (
                <SelectItem key={key} value={key}>
                  {name || t('unnamedMode')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void editor.add()}>
            <PlusIcon className="size-4" />
            {t('addMode')}
          </Button>
          {mode && (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('copyMode')}
                title={t('copyTitle')}
                disabled={busy}
                onClick={() => void editor.add(true)}
              >
                <CopyIcon className="size-4" />
              </Button>
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
            </>
          )}
          {editor.catalog && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('refreshCatalog')}
              title={t('refreshCatalog')}
              disabled={busy}
              onClick={() => void editor.load(true)}
            >
              <RefreshCwIcon className="size-4" />
            </Button>
          )}
          <span className="ml-1 hidden sm:inline-flex">{saveButton}</span>
        </div>
      </header>
      {editor.error && (
        <div role="alert" className="shrink-0 border-b px-4 py-3 text-sm text-destructive">
          {editor.error}
          <Button variant="ghost" size="sm" onClick={() => void editor.load(true)}>
            {t('retryRead')}
          </Button>
        </div>
      )}
      {editor.loading && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b px-4 py-3 text-sm text-muted-foreground"
        >
          <LoaderCircleIcon className="size-4 animate-spin" />
          {t('loadingCatalog')}
        </div>
      )}
      {mode && editor.selected ? (
        <L2CapabilityModeEditor
          modeKey={editor.selected}
          mode={mode}
          catalog={editor.catalog}
          disabled={editor.saving}
          onChange={editor.update}
        />
      ) : (
        <div className="flex items-start gap-3 p-6">
          <ShieldCheckIcon className="mt-0.5 size-6 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">{t('allEnabled')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('allDescription')}</p>
          </div>
        </div>
      )}
      <footer className="mt-auto flex shrink-0 items-center justify-between gap-3 border-t px-4 py-3 pb-[max(.75rem,env(safe-area-inset-bottom))] text-xs text-muted-foreground sm:py-2">
        <span role="status">{editor.dirty ? t('unsaved') : t('allIsDefault')}</span>
        <span className="sm:hidden">{saveButton}</span>
      </footer>
      <L2CapabilityModesConfirm
        open={editor.leaveOpen || deleteName !== null}
        deleteName={deleteName}
        saving={editor.saving}
        error={editor.leaveOpen ? editor.error : null}
        onCancel={() => {
          if (deleteName !== null) setDeleteName(null)
          else void editor.decideLeave('cancel')
        }}
        onDelete={() => {
          editor.remove()
          setDeleteName(null)
        }}
        onLeave={(choice) => void editor.decideLeave(choice)}
      />
    </section>
  )
}
