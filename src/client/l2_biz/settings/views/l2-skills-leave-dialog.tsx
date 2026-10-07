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

export function L2SkillsLeaveDialog({
  open,
  saving,
  path,
  error,
  onDecide
}: {
  open: boolean
  saving: boolean
  path: string | null
  error: string | null
  onDecide: (choice: 'save' | 'discard' | 'cancel') => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('skills')
  return (
    <L4AppDialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) void onDecide('cancel')
      }}
    >
      <L4AppDialogContent className="z-[150]" showCloseButton={!saving}>
        <L4AppDialogHeader className="p-4 pr-12">
          <L4AppDialogTitle>{t('saveChangesTitle')}</L4AppDialogTitle>
          <L4AppDialogDescription>
            {t('saveChangesDescription', { path: path ?? '' })}
          </L4AppDialogDescription>
        </L4AppDialogHeader>
        {error && (
          <p role="alert" className="px-4 pb-4 text-sm text-destructive">
            {error}
          </p>
        )}
        <L4AppDialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => void onDecide('cancel')}>
            {t('cancel')}
          </Button>
          <Button variant="ghost" disabled={saving} onClick={() => void onDecide('discard')}>
            {t('discard')}
          </Button>
          <Button disabled={saving} onClick={() => void onDecide('save')}>
            {saving ? t('savingChanges') : t('saveContinue')}
          </Button>
        </L4AppDialogFooter>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
