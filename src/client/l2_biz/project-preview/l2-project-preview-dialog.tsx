'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2Icon, Minimize2Icon, XIcon } from 'lucide-react'
import {
  L4AppDialogRoot,
  L4AppDialogContent,
  L4AppDialogTitle,
  L4AppDialogDescription
} from '@client/l4_foundation/ui/l4-app-dialog'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { L2ProjectPreview } from './l2-project-preview'
import {
  loadL2ProjectPreviewGlobal,
  saveL2ProjectPreviewGlobal
} from './l2-project-preview-storage'

export function L2ProjectPreviewDialog({
  clientId,
  cwd,
  onClose
}: {
  clientId: string
  cwd: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('projectHistory')
  const [maximized, setMaximized] = useState(() => loadL2ProjectPreviewGlobal().maximized)
  const projectName = cwd.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? cwd
  return (
    <L4AppDialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <L4AppDialogContent
        showCloseButton={false}
        data-testid="project-preview-dialog"
        className={cn(
          'h-[min(94dvh,1080px)] w-[min(96dvw,1600px)] max-w-none gap-0 p-0',
          maximized && 'h-dvh max-h-none w-dvw rounded-none',
          'max-sm:h-dvh max-sm:max-h-none max-sm:w-dvw max-sm:rounded-none'
        )}
      >
        <L4AppDialogDescription className="sr-only">
          {t('previewDescription')}
        </L4AppDialogDescription>
        <L2ProjectPreview
          clientId={clientId}
          cwd={cwd}
          onEscape={onClose}
          title={
            <L4AppDialogTitle className="truncate text-sm" title={cwd}>
              {projectName}
            </L4AppDialogTitle>
          }
          actions={
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                className="max-md:hidden"
                aria-label={t(maximized ? 'restoreWindow' : 'maximizeWindow')}
                onClick={() => {
                  setMaximized(!maximized)
                  saveL2ProjectPreviewGlobal({
                    ...loadL2ProjectPreviewGlobal(),
                    maximized: !maximized
                  })
                }}
              >
                {maximized ? (
                  <Minimize2Icon className="size-4" />
                ) : (
                  <Maximize2Icon className="size-4" />
                )}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('closePreview')}
                onClick={onClose}
              >
                <XIcon className="size-4" />
              </Button>
            </>
          }
        />
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
