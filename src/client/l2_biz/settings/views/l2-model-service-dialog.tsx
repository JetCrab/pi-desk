'use client'

import { Trash2Icon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2ModelProviderConfig } from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { L4SecretInput } from '@client/l4_foundation/ui/l4-secret-input'
import { useL4ConfirmDialog } from '@client/l4_foundation/ui/l4-confirm-dialog'
import {
  L4AppDialogRoot,
  L4AppDialogContent,
  L4AppDialogHeader,
  L4AppDialogTitle,
  L4AppDialogDescription,
  L4AppDialogBody,
  L4AppDialogFooter
} from '@client/l4_foundation/ui/l4-app-dialog'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import {
  Field,
  FixedSelect,
  HeaderTextarea,
  MODEL_APIS,
  TriStateSelect
} from './l2-model-settings-form'

export function L2ModelServiceDialog({
  provider,
  existingIds,
  isNew,
  onApply,
  onDelete,
  onClose,
  onDirtyChange
}: {
  provider: L2ModelProviderConfig
  existingIds: string[]
  isNew: boolean
  onApply: (provider: L2ModelProviderConfig) => void
  onDelete: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { confirm, dialog } = useL4ConfirmDialog()
  const [draft, setDraft] = useState(() => structuredClone(provider))
  const dirty = JSON.stringify(draft) !== JSON.stringify(provider)
  const idInvalid = !draft.provider.trim() || existingIds.includes(draft.provider.trim())
  const title = draft.provider || t('providerUnnamed')

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  function patch(changes: Partial<L2ModelProviderConfig>): void {
    setDraft((current) => ({ ...current, ...changes }))
  }

  async function close(): Promise<void> {
    if (
      dirty &&
      !(await confirm({
        title: t('discardServiceTitle'),
        description: t('discardServiceDescription'),
        confirmLabel: t('discardModelConfirm')
      }))
    )
      return
    onClose()
  }

  async function remove(): Promise<void> {
    if (
      await confirm({
        title: t('providerDeleteTitle'),
        description: t('providerDeleteDescription', { name: title, count: provider.models.length })
      })
    )
      onDelete()
  }

  return (
    <>
      <L4AppDialogRoot
        open
        onOpenChange={(open) => {
          if (!open) void close()
        }}
      >
        <L4AppDialogContent className="max-w-[40rem]" initialFocus={false}>
          <L4AppDialogHeader className="border-b px-4 py-4 pr-12">
            <L4AppDialogTitle>{t('serviceConnection')}</L4AppDialogTitle>
            <L4AppDialogDescription>
              {t('serviceDraftScope', { count: provider.models.length })}
            </L4AppDialogDescription>
          </L4AppDialogHeader>
          <L4AppDialogBody className="max-h-[65dvh]">
            <div className="space-y-5 p-4">
              <Field label={t('serviceId')}>
                <Input
                  value={draft.provider}
                  aria-label={t('serviceId')}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={t('providerIdExample')}
                  aria-invalid={idInvalid}
                  onChange={(event) => patch({ provider: event.target.value })}
                />
                {idInvalid ? (
                  <span role="alert" className="text-xs text-destructive">
                    {t('serviceIdInvalid')}
                  </span>
                ) : null}
              </Field>
              <Field label={t('serviceAddress')}>
                <Input
                  value={draft.baseUrl ?? ''}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => patch({ baseUrl: event.target.value || null })}
                />
              </Field>
              <Field label={t('providerApiType')}>
                <FixedSelect
                  value={draft.api ?? ''}
                  ariaLabel={t('providerApiType')}
                  options={MODEL_APIS}
                  onChange={(value) => patch({ api: value || null })}
                />
              </Field>
              <Field label={t('serviceKey')}>
                <L4SecretInput
                  value={draft.apiKey ?? ''}
                  onChange={(event) => patch({ apiKey: event.target.value || null })}
                />
              </Field>
              <details className="border-t pt-3">
                <summary className="cursor-pointer text-sm font-semibold">
                  {t('providerAdvanced')}
                </summary>
                <div className="mt-3 space-y-3">
                  <Field label={t('providerAuthHeader')}>
                    <TriStateSelect
                      value={draft.authHeader}
                      ariaLabel={t('providerAuthHeader')}
                      onChange={(authHeader) => patch({ authHeader })}
                    />
                  </Field>
                  <Field label={t('providerHeaders')}>
                    <HeaderTextarea
                      headers={draft.headers}
                      onChange={(headers) => patch({ headers })}
                      placeholder={t('headerPlaceholder')}
                    />
                  </Field>
                </div>
              </details>
            </div>
          </L4AppDialogBody>
          <L4AppDialogFooter>
            {!isNew ? (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-destructive hover:text-destructive"
                onClick={remove}
              >
                <Trash2Icon />
                {t('providerDelete')}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('cancel', { ns: 'common' })}
            </Button>
            <Button
              type="button"
              disabled={idInvalid || (!dirty && !isNew)}
              onClick={() => onApply(draft)}
            >
              {t('applyServiceDraft')}
            </Button>
          </L4AppDialogFooter>
        </L4AppDialogContent>
      </L4AppDialogRoot>
      {dialog}
    </>
  )
}
