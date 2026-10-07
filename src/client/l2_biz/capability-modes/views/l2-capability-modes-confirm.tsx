import {
  L4AppDialogContent,
  L4AppDialogDescription,
  L4AppDialogFooter,
  L4AppDialogHeader,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { useTranslation } from 'react-i18next'

export function L2CapabilityModesConfirm({
  open,
  deleteName,
  saving,
  error,
  onCancel,
  onDelete,
  onLeave
}: {
  open: boolean
  deleteName: string | null
  saving: boolean
  error: string | null
  onCancel: () => void
  onDelete: () => void
  onLeave: (choice: 'save' | 'discard') => void
}): React.JSX.Element {
  const { t } = useTranslation('capabilityModes')
  return (
    <L4AppDialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onCancel()
      }}
    >
      <L4AppDialogContent className="z-[150]" showCloseButton={!saving}>
        <L4AppDialogHeader className="p-4 pr-12">
          <L4AppDialogTitle>{deleteName ? t('deleteConfirm') : t('saveConfirm')}</L4AppDialogTitle>
          <L4AppDialogDescription>
            {deleteName ? t('deleteDescription', { name: deleteName }) : t('unsavedDescription')}
          </L4AppDialogDescription>
        </L4AppDialogHeader>
        {error && (
          <p role="alert" className="px-4 pb-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <L4AppDialogFooter>
          <Button variant="outline" disabled={saving} onClick={onCancel}>
            {t('cancel')}
          </Button>
          {deleteName ? (
            <Button variant="destructive" onClick={onDelete}>
              {t('delete')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" disabled={saving} onClick={() => onLeave('discard')}>
                {t('discard')}
              </Button>
              <Button disabled={saving} onClick={() => onLeave('save')}>
                {saving ? t('saving') : t('saveContinue')}
              </Button>
            </>
          )}
        </L4AppDialogFooter>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
