'use client'

import { ChevronDownIcon, FolderIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { projectPreviewDirectoryKey } from '@common/l4_foundation/file/l4-project-preview-contract'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@client/l4_foundation/ui/shadcn/dropdown-menu'
import { L3ProjectFileBrowser } from '@client/l3_modules/project-files/l3-project-file-browser'
import type { L2FileWorkspaceRuntime } from './l2-file-workspace-runtime'
import type { L2GitWorkspaceRuntime } from '../git-workspace/l2-git-workspace-runtime'
import type { L2GitBranchPickerTarget } from '../git-workspace/l2-git-workspace-model'

function directoryName(directory: string): string {
  return directory.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? directory
}
function compactDirectory(directory: string): string {
  const parts = directory.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.length <= 2 ? directory : `…/${parts.slice(-2).join('/')}`
}

interface Props {
  workId: string
  cwd: string
  projectName: string
  runtime: L2FileWorkspaceRuntime
  gitRuntime: L2GitWorkspaceRuntime
  onOpenGitBranches: (target: L2GitBranchPickerTarget) => void
  onFileOpened?: () => void
}
export function L2ProjectFileBrowser({
  workId,
  cwd,
  projectName,
  runtime,
  gitRuntime,
  onOpenGitBranches,
  onFileOpened
}: Props): React.JSX.Element {
  const { t } = useTranslation('projectFiles')
  useSyncExternalStore(runtime.subscribe, runtime.getRevision, runtime.getRevision)
  const directory = runtime.getDirectory(workId)
  const directories = runtime.getDirectories(workId)
  const original = projectPreviewDirectoryKey(cwd) === projectPreviewDirectoryKey(directory)
  const name = original ? projectName : directoryName(directory)
  return (
    <L3ProjectFileBrowser
      cwd={directory}
      projectName={name}
      gitReadOnly={!original}
      rootTitle={
        directories.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid="project-preview-directory-trigger"
              aria-label={t('selectPreviewDirectory')}
              title={directory}
              className="flex min-h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="max-w-[45%] truncate text-xs font-semibold">{name}</span>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {compactDirectory(directory)}
              </span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              finalFocus
              className="w-[23rem] min-w-0 max-w-[calc(100vw-1.5rem)]"
              aria-label={t('previewDirectories')}
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('previewDirectories')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={directory}
                  onValueChange={(value) => runtime.selectDirectory(workId, value)}
                >
                  {directories.map((root) => (
                    <DropdownMenuRadioItem
                      key={projectPreviewDirectoryKey(root)}
                      value={root}
                      data-testid="project-preview-directory-option"
                      data-directory={root}
                      className="items-start py-2 data-checked:bg-muted"
                    >
                      <FolderIcon className="mt-0.5 size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 break-all">
                            {projectPreviewDirectoryKey(root) === projectPreviewDirectoryKey(cwd)
                              ? projectName
                              : directoryName(root)}
                          </span>
                          {projectPreviewDirectoryKey(root) === projectPreviewDirectoryKey(cwd) ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {t('sessionDirectory')}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block break-all font-mono text-xs leading-5 text-muted-foreground">
                          {root}
                        </span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined
      }
      runtime={runtime.getFileRuntime(workId)}
      gitRuntime={gitRuntime}
      onOpenGitBranches={(repositoryRoot) => {
        if (original) onOpenGitBranches({ workId, cwd, projectName, repositoryRoot })
      }}
      onFileOpened={() => {
        runtime.showWindow(workId)
        onFileOpened?.()
      }}
    />
  )
}
