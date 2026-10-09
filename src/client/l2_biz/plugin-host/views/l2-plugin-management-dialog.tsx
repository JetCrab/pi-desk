'use client'

import { useTranslation } from 'react-i18next'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  L4AppDialogRoot,
  L4AppDialogContent,
  L4AppDialogHeader,
  L4AppDialogTitle,
  L4AppDialogDescription,
  L4AppDialogBody,
  L4AppDialogFooter
} from '@client/l4_foundation/ui/l4-app-dialog'
import {
  pluginManagementActionLabel,
  pluginNpmSpec,
  type PluginManagementAction
} from '../l2-use-plugin-management'

interface ManagementDialogProps {
  open: boolean
  title: string
  confirmation: PluginManagementAction | null
  onClose: () => void
  onConfirm: (action: PluginManagementAction) => void
  children: React.ReactNode
}

export function L2PluginManagementDialog({
  open,
  title,
  confirmation,
  onClose,
  onConfirm,
  children
}: ManagementDialogProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const action = confirmation ? t(pluginManagementActionLabel(confirmation)) : null
  return (
    <L4AppDialogRoot
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
    >
      <L4AppDialogContent
        finalFocus
        className={confirmation ? 'max-w-lg' : 'h-[min(85dvh,52rem)] max-w-3xl'}
      >
        <L4AppDialogHeader className="p-4 pr-12">
          <L4AppDialogTitle className="min-w-0 [overflow-wrap:anywhere]">
            {confirmation ? t('confirmAction', { action }) : title}
          </L4AppDialogTitle>
          <L4AppDialogDescription>
            {confirmation
              ? confirmation.kind === 'del'
                ? t('removeDescription')
                : confirmation.kind === 'add'
                  ? t('thirdPartyDescription')
                  : confirmation.kind === 'reload'
                    ? t(
                        confirmation.mode === 'normal'
                          ? 'restartNormalDescription'
                          : 'restartDescription'
                      )
                    : t('confirmChange')
              : t('pluginDetails')}
          </L4AppDialogDescription>
        </L4AppDialogHeader>
        <L4AppDialogBody className="min-h-0">
          <div className="min-w-0 p-4 pt-0">
            {confirmation ? (
              confirmation.kind === 'add' ? (
                <dl className="space-y-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{t('packageName')}</dt>
                    <dd className="mt-1 font-medium [overflow-wrap:anywhere]">
                      {confirmation.package?.name ?? confirmation.input.source}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('version')}</dt>
                    <dd className="[overflow-wrap:anywhere]">
                      {confirmation.package?.version ??
                        pluginNpmSpec(confirmation.input.source)?.version ??
                        t('fromSource')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('publisher')}</dt>
                    <dd className="[overflow-wrap:anywhere]">
                      {confirmation.package?.publisher ?? t('unknownPublisher')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('source')}</dt>
                    <dd className="[overflow-wrap:anywhere]">
                      {confirmation.input.registry ??
                        confirmation.package?.registry ??
                        confirmation.input.source}
                    </dd>
                  </div>
                </dl>
              ) : confirmation.kind !== 'reload' ? (
                <p className="text-sm font-medium [overflow-wrap:anywhere]">
                  {confirmation.source}
                </p>
              ) : null
            ) : (
              children
            )}
          </div>
        </L4AppDialogBody>
        {confirmation ? (
          <L4AppDialogFooter>
            <Button size="sm" variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              variant={confirmation.kind === 'del' ? 'destructive' : 'default'}
              onClick={() => onConfirm(confirmation)}
            >
              {action}
            </Button>
          </L4AppDialogFooter>
        ) : null}
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
