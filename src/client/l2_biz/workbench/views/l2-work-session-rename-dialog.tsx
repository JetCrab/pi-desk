'use client'

import { useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircleIcon } from 'lucide-react'
import {
  L4AppDialogContent,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'

interface Props {
  open: boolean
  title: string
  saving: boolean
  disabled: boolean
  error: string | null
  onTitleChange: (title: string) => void
  onSave: () => void
  onClose: () => void
}

export function L2WorkSessionRenameDialog({
  open,
  title,
  saving,
  disabled,
  error,
  onTitleChange,
  onSave,
  onClose
}: Props): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <L4AppDialogRoot open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <L4AppDialogContent
        data-testid="work-session-rename-dialog"
        showCloseButton={false}
        initialFocus={inputRef}
        className="max-w-sm"
      >
        <form
          className="flex flex-col gap-4 overflow-y-auto p-4"
          onSubmit={(event) => {
            event.preventDefault()
            onSave()
          }}
        >
          <L4AppDialogTitle>{t('renameSessionTitle')}</L4AppDialogTitle>
          <div className="flex flex-col gap-2">
            <label htmlFor={inputId} className="font-medium">
              {t('sessionTitleLabel')}
            </label>
            <Input
              ref={inputRef}
              id={inputId}
              value={title}
              disabled={saving}
              onChange={(event) => onTitleChange(event.currentTarget.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
              }}
            />
          </div>
          {error ? (
            <p role="alert" className="break-words text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              {t('cancel', { ns: 'common' })}
            </Button>
            <Button type="submit" disabled={disabled || saving || !title.trim()} aria-busy={saving}>
              {saving ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
              {t('save', { ns: 'common' })}
            </Button>
          </div>
        </form>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
