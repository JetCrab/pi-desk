'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircleIcon } from 'lucide-react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { Checkbox } from '@client/l4_foundation/ui/shadcn/checkbox'
import { L4PasswordInput } from '@client/l4_foundation/ui/l4-password-input'
import { createL2EnvironmentBiz, downloadL2EnvironmentBlob } from './l2-environment-biz'
import {
  activeL2EnvironmentOperation,
  buildL2EnvironmentImport,
  L2EnvironmentRuntime,
  selectedL2EnvironmentItems
} from './l2-environment-runtime'
import { L2EnvironmentNotices, L2EnvironmentPreview } from './views/l2-environment-preview'

const phaseLabels: Record<string, string> = {
  'awaiting-maintenance': 'phaseWaiting',
  'archiving-offline': 'phaseArchive',
  'applying-offline': 'phaseApplying',
  'archive-ready': 'phaseArchiveReady',
  'import-completed': 'phaseImportComplete',
  'desktop-staged-restart-required': 'phaseDesktopPending',
  interrupted: 'phaseInterrupted',
  'maintenance-failed': 'phaseFailed',
  'restart-rejected': 'phaseFailed',
  uploaded: 'phaseUploaded'
}

export function L2EnvironmentSettings({ clientId }: { clientId: string }): React.JSX.Element {
  const { t } = useTranslation('settings')
  const runtime = useMemo(
    () => new L2EnvironmentRuntime(createL2EnvironmentBiz(clientId)),
    [clientId]
  )
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
  useEffect(() => {
    runtime.start()
    return runtime.dispose
  }, [runtime])
  const [confirming, setConfirming] = useState(false)
  const active = activeL2EnvironmentOperation(state)
  const busy = state.pending !== null || active
  const { exportDraft, preview, operation } = state
  const exportValid = Boolean(
    exportDraft.password && exportDraft.password === exportDraft.confirmation
  )
  const importInput = preview
    ? buildL2EnvironmentImport(preview, state.selectedIds, state.targets, state.overwrite)
    : null
  const conflicts = preview
    ? selectedL2EnvironmentItems(preview, state.selectedIds).some(
        (item) => item.conflicts.length > 0
      )
    : false
  const mappingsComplete = Boolean(importInput?.mappings.every((mapping) => mapping.to))
  const importValid = Boolean(
    state.previewFresh &&
    importInput?.selectedIds.length &&
    mappingsComplete &&
    (!conflicts || state.overwrite)
  )
  const canRestart = state.capabilities?.canRestart === true
  const pendingText =
    state.pending === 'export'
      ? 'preparing'
      : state.pending === 'import'
        ? 'importing'
        : state.pending === 'preview'
          ? 'previewing'
          : state.pending === 'cancel'
            ? 'cancelling'
            : state.pending === 'download'
              ? 'downloading'
              : null

  const invalidateConfirmation = (): void => setConfirming(false)

  return (
    <section aria-labelledby="environment-title" className="min-w-0 space-y-6">
      <header className="space-y-2">
        <h2 id="environment-title" className="text-xl font-semibold">
          {t('environmentBackup')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('environment.description')}</p>
        <p className="text-sm text-muted-foreground">{t('environment.scope')}</p>
        {state.capabilities && !state.capabilities.desktopAvailable ? (
          <p className="text-sm text-muted-foreground">{t('environment.desktopScope')}</p>
        ) : null}
      </header>
      {state.pending === 'load' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common:loading')}
        </p>
      ) : null}
      {state.capabilities && !canRestart ? (
        <p className="rounded-xl border bg-muted p-4 text-sm">{t('environment.unsupported')}</p>
      ) : null}
      {!state.capabilities && state.pending !== 'load' ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t('environment.capabilitiesFailed')}</p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void runtime.load()}
          >
            {t('common:retry')}
          </Button>
        </div>
      ) : null}
      {state.error ? (
        <p
          role="alert"
          className="break-words rounded-lg border border-destructive/40 p-3 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(
            state.notice === 'unknown-outcome'
              ? 'environment.unknownOutcome'
              : state.notice === 'poll-stopped'
                ? 'environment.pollStopped'
                : 'environment.operationExpired'
          )}
        </p>
      ) : null}
      {pendingText ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
          {t(`environment.${pendingText}`)}
        </p>
      ) : null}
      {state.operationId ? (
        <section
          aria-label={t('environment.operationTitle')}
          className="space-y-3 rounded-xl border bg-muted/40 p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {t(
                state.operationId.kind === 'export'
                  ? 'environment.exportKind'
                  : state.operationId.kind === 'import'
                    ? 'environment.importKind'
                    : 'environment.operationTitle'
              )}
            </h3>
            <p role="status" className="text-sm">
              {operation
                ? t(
                    `environment.${operation.phase === 'desktop-staged-restart-required' ? 'phaseDesktopPending' : operation.status}`
                  )
                : t('environment.querying')}
            </p>
          </div>
          {operation?.phase ? (
            <p role="status" className="break-words text-sm text-muted-foreground">
              {t('environment.phase', {
                phase: t(`environment.${phaseLabels[operation.phase] ?? operation.status}`)
              })}
            </p>
          ) : null}
          {operation?.error ? (
            <p role="alert" className="break-words text-sm text-destructive">
              {operation.error}
            </p>
          ) : null}
          <L2EnvironmentNotices
            title={t('environment.warnings')}
            values={operation?.warnings ?? []}
          />
          <p className="text-sm text-muted-foreground">{t('environment.operationHint')}</p>
          {active && !state.polling && !state.pending ? (
            <Button type="button" variant="outline" onClick={runtime.resumePolling}>
              {t('environment.resume')}
            </Button>
          ) : null}
          {operation?.kind === 'export' && operation.status === 'ready' ? (
            <Button
              type="button"
              disabled={state.pending !== null}
              onClick={() => {
                void runtime.download().then((blob) => {
                  if (blob) downloadL2EnvironmentBlob(blob)
                })
              }}
            >
              {t('environment.download')}
            </Button>
          ) : null}
          {operation?.kind === 'import' && operation.status === 'completed' ? (
            <p className="text-sm">
              {t(
                operation.phase === 'desktop-staged-restart-required'
                  ? 'environment.desktopPending'
                  : 'environment.importCompleted'
              )}
            </p>
          ) : null}
        </section>
      ) : null}
      <section className="space-y-4 border-t pt-6" aria-labelledby="environment-export-title">
        <div className="space-y-1">
          <h3 id="environment-export-title" className="text-sm font-semibold">
            {t('environment.exportTitle')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('environment.exportHint')}</p>
        </div>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void runtime.export()
          }}
        >
          <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <label htmlFor="environment-export-password" className="text-sm font-medium">
                {t('environment.password')}
              </label>
              <L4PasswordInput
                id="environment-export-password"
                autoComplete="new-password"
                maxLength={4096}
                required
                value={exportDraft.password}
                disabled={busy}
                onChange={(event) => runtime.editExport({ password: event.target.value })}
              />
            </div>
            <div className="min-w-0 space-y-1">
              <label htmlFor="environment-export-confirmation" className="text-sm font-medium">
                {t('environment.confirmation')}
              </label>
              <L4PasswordInput
                id="environment-export-confirmation"
                autoComplete="new-password"
                maxLength={4096}
                required
                value={exportDraft.confirmation}
                disabled={busy}
                aria-invalid={Boolean(exportDraft.confirmation && !exportValid)}
                onChange={(event) => runtime.editExport({ confirmation: event.target.value })}
              />
            </div>
          </fieldset>
          {exportDraft.confirmation && !exportValid ? (
            <p className="text-sm text-destructive">{t('environment.mismatch')}</p>
          ) : null}
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={exportDraft.includeSessions}
                disabled={busy}
                onCheckedChange={(checked) =>
                  runtime.editExport({ includeSessions: checked === true })
                }
              />
              {t('environment.includeSessions')}
            </label>
            <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={exportDraft.includePluginData}
                disabled={busy}
                onCheckedChange={(checked) =>
                  runtime.editExport({ includePluginData: checked === true })
                }
              />
              {t('environment.includePluginData')}
            </label>
          </div>
          <Button type="submit" disabled={busy || !canRestart || !exportValid}>
            {t('environment.startExport')}
          </Button>
        </form>
      </section>
      <section
        aria-labelledby="environment-import-title"
        className="min-w-0 space-y-4 border-t pt-6"
      >
        <div className="space-y-1">
          <h3 id="environment-import-title" className="text-sm font-semibold">
            {t('environment.importTitle')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('environment.importHint')}</p>
        </div>
        <div className="space-y-1">
          <label htmlFor="environment-package" className="text-sm font-medium">
            {t('environment.file')}
          </label>
          <Input
            id="environment-package"
            type="file"
            disabled={busy}
            className="h-auto min-h-8 max-w-full text-sm"
            onChange={(event) => {
              invalidateConfirmation()
              runtime.setFile(event.target.files?.[0] ?? null)
            }}
          />
        </div>
        <div className="max-w-md space-y-1">
          <label htmlFor="environment-import-password" className="text-sm font-medium">
            {t('environment.password')}
          </label>
          <L4PasswordInput
            id="environment-import-password"
            autoComplete="off"
            maxLength={4096}
            value={state.password}
            disabled={busy}
            onChange={(event) => {
              invalidateConfirmation()
              runtime.editPassword(event.target.value)
            }}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {!preview ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !state.file || !state.password}
              onClick={() => {
                invalidateConfirmation()
                void runtime.preview()
              }}
            >
              {t('environment.preview')}
            </Button>
          ) : null}
          {preview ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                invalidateConfirmation()
                void runtime.cancelPreview()
              }}
            >
              {t('environment.cancelPreview')}
            </Button>
          ) : null}
        </div>
        {preview ? (
          <>
            <L2EnvironmentPreview
              preview={preview}
              previewFresh={state.previewFresh}
              selectedIds={state.selectedIds}
              targets={state.targets}
              overwrite={state.overwrite}
              browser={state.browser}
              disabled={busy}
              onSelect={(ids, checked) => {
                invalidateConfirmation()
                runtime.select(ids, checked)
              }}
              onTarget={(from, to) => {
                invalidateConfirmation()
                runtime.setTarget(from, to)
              }}
              onOverwrite={(checked) => {
                invalidateConfirmation()
                runtime.setOverwrite(checked)
              }}
              onBrowse={(from, cwd) => void runtime.browse(from, cwd)}
              onCloseBrowser={runtime.closeBrowser}
            />
            {!state.previewFresh ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t('environment.previewStale')}
              </p>
            ) : !importValid ? (
              <p className="text-sm text-muted-foreground">{t('environment.selectionRequired')}</p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy || !mappingsComplete}
              onClick={() => {
                invalidateConfirmation()
                void runtime.preview()
              }}
            >
              {t('environment.updatePreview')}
            </Button>
            {confirming ? (
              <section
                className="space-y-3 rounded-xl border p-4"
                aria-labelledby="environment-confirm-title"
              >
                <h3 id="environment-confirm-title" className="text-sm font-semibold">
                  {t('environment.confirmTitle')}
                </h3>
                <p className="text-sm">
                  {t('environment.confirmHint', { count: importInput?.selectedIds.length ?? 0 })}
                </p>
                {state.overwrite ? (
                  <p className="text-sm font-medium">{t('environment.overwriteConfirm')}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy || !canRestart || !importValid}
                    onClick={() => {
                      void runtime.apply().then(() => setConfirming(false))
                    }}
                  >
                    {t('environment.confirmApply')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                  >
                    {t('common:cancel')}
                  </Button>
                </div>
              </section>
            ) : (
              <Button
                type="button"
                disabled={busy || !canRestart || !importValid}
                onClick={() => setConfirming(true)}
              >
                {t('environment.prepareApply')}
              </Button>
            )}
          </>
        ) : null}
      </section>
    </section>
  )
}
