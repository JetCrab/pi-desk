'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2ModelAccount } from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import {
  L4AppDialogRoot,
  L4AppDialogContent,
  L4AppDialogHeader,
  L4AppDialogTitle,
  L4AppDialogBody,
  L4AppDialogFooter
} from '@client/l4_foundation/ui/l4-app-dialog'
import { tokensToK } from './l2-model-settings-form'

export function L2AccountModelPicker({
  account,
  existingIds,
  onAdd,
  onClose
}: {
  account: L2ModelAccount
  existingIds: string[]
  onAdd: (modelIds: string[]) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const candidates = account.models.filter((model) =>
    `${model.name} ${model.modelId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  )
  return (
    <L4AppDialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <L4AppDialogContent className="max-w-xl">
        <L4AppDialogHeader className="border-b p-4 pr-12">
          <L4AppDialogTitle>{t('modelAddToService', { name: account.name })}</L4AppDialogTitle>
        </L4AppDialogHeader>
        <div className="p-4 pb-2">
          <Input
            value={query}
            aria-label={t('accountModelSearch')}
            placeholder={t('accountModelSearch')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <L4AppDialogBody className="max-h-[55dvh]">
          <div className="space-y-1 px-4 pb-4">
            {candidates.map((model) => {
              const added = existingIds.includes(model.modelId)
              return (
                <label
                  key={model.modelId}
                  className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary"
                    checked={added || selected.includes(model.modelId)}
                    disabled={added}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, model.modelId]
                          : current.filter((id) => id !== model.modelId)
                      )
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium">{model.name}</span>
                    <span className="block break-all text-xs text-muted-foreground">
                      {model.modelId} · {tokensToK(model.contextWindow)} K
                    </span>
                  </span>
                  {added ? (
                    <span className="text-xs text-muted-foreground">{t('accountModelAdded')}</span>
                  ) : null}
                </label>
              )
            })}
            {!candidates.length ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('accountNoModels')}
              </p>
            ) : null}
          </div>
        </L4AppDialogBody>
        <L4AppDialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('accountAddLater')}
          </Button>
          <Button type="button" disabled={!selected.length} onClick={() => onAdd(selected)}>
            {t('accountAddSelected', { count: selected.length })}
          </Button>
        </L4AppDialogFooter>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
