'use client'

import { L3ProjectFileBrowser } from '@client/l3_modules/project-files/l3-project-file-browser'
import type { L2FileWorkspaceRuntime } from './l2-file-workspace-runtime'
import type { L2GitWorkspaceRuntime } from '../git-workspace/l2-git-workspace-runtime'
import type { L2GitBranchPickerTarget } from '../git-workspace/l2-git-workspace-model'

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
  return (
    <L3ProjectFileBrowser
      cwd={cwd}
      projectName={projectName}
      runtime={runtime.getFileRuntime(workId)}
      gitRuntime={gitRuntime}
      onOpenGitBranches={(repositoryRoot) =>
        onOpenGitBranches({ workId, cwd, projectName, repositoryRoot })
      }
      onFileOpened={() => {
        runtime.showWindow(workId)
        onFileOpened?.()
      }}
    />
  )
}
