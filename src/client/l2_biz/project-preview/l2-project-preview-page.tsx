'use client'

import { FolderOpenIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L2ProjectPreview } from './l2-project-preview'
import { useL2ProjectPicker } from './hooks/l2-use-project-picker'
import { L2ProjectPickerView } from './views/l2-project-picker'

function ProjectPicker({
  clientId,
  onSelect,
  onUnauthorized
}: {
  clientId: string
  onSelect: (cwd: string) => void
  onUnauthorized: () => void
}): React.JSX.Element {
  const picker = useL2ProjectPicker(clientId, onUnauthorized)
  return <L2ProjectPickerView picker={picker} onSelect={onSelect} />
}

export function L2ProjectPreviewPage({
  clientId,
  cwd,
  onSelect,
  onUnauthorized
}: {
  clientId: string
  cwd: string | null
  onSelect: (cwd: string | null) => void
  onUnauthorized: () => void
}): React.JSX.Element {
  const { t } = useTranslation('projectHistory')
  return (
    <main
      className="flex h-[var(--pi-desk-content-height)] min-w-0 flex-col overflow-hidden bg-background text-foreground"
      data-testid="project-preview-page"
    >
      {cwd ? (
        <L2ProjectPreview
          key={cwd}
          clientId={clientId}
          cwd={cwd}
          onUnauthorized={onUnauthorized}
          actions={
            <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>
              <FolderOpenIcon className="size-4" />
              <span>{t('switchProject')}</span>
            </Button>
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <ProjectPicker clientId={clientId} onSelect={onSelect} onUnauthorized={onUnauthorized} />
        </div>
      )}
    </main>
  )
}
