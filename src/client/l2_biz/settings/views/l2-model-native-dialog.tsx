'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
import { Textarea } from '@client/l4_foundation/ui/shadcn/textarea'

export function L2ModelNativeDialog({
  open,
  text,
  error,
  saving,
  dirty,
  onChange,
  onClose,
  onSave
}: {
  open: boolean
  text: string
  error: string | null
  saving: boolean
  dirty: boolean
  onChange: (text: string) => void
  onClose: () => Promise<void>
  onSave: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <L4AppDialogRoot
      open={open}
      onOpenChange={(open) => {
        if (!open) void onClose()
      }}
    >
      <L4AppDialogContent className="max-w-[52rem]" initialFocus={false} showCloseButton={!saving}>
        <L4AppDialogHeader className="border-b px-4 py-4 pr-12">
          <L4AppDialogTitle>{t('nativeConfig')}</L4AppDialogTitle>
          <L4AppDialogDescription>{t('nativeConfigScope')}</L4AppDialogDescription>
        </L4AppDialogHeader>
        <L4AppDialogBody className="max-h-[70dvh]">
          <div className="space-y-3 p-4">
            <Textarea
              aria-label={t('nativeConfigEditor')}
              value={text}
              disabled={saving}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="min-h-[min(28rem,50dvh)] resize-y font-mono text-sm"
              onChange={(event) => onChange(event.target.value)}
            />
            {error ? (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </L4AppDialogBody>
        <L4AppDialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
            {t('cancel', { ns: 'common' })}
          </Button>
          <Button type="button" disabled={saving || !dirty} onClick={onSave}>
            {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
            {saving ? t('savingModels') : t('saveNativeConfig')}
          </Button>
        </L4AppDialogFooter>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
