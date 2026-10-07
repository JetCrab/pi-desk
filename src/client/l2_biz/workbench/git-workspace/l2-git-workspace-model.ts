export {
  buildL3GitBranchTree as buildL2GitBranchTree,
  joinL3GitProjectPath as joinL2GitProjectPath,
  getL3GitRepositoryName as getL2GitRepositoryName,
  getL3GitHeadLabel as getL2GitHeadLabel,
  getL3GitBranchSummary as getL2GitBranchSummary,
  getL3GitChangeBadge as getL2GitChangeBadge,
  listL3GitProjectChanges as listL2GitProjectChanges,
  type L3GitBranchSummary as L2GitBranchSummary,
  type L3GitProjectChange as L2GitProjectChange,
  type L3GitBranchTreeNode as L2GitBranchTreeNode
} from '@client/l3_modules/project-files/l3-project-git-model'

export interface L2GitBranchPickerTarget {
  workId: string
  cwd: string
  projectName: string
  repositoryRoot: string | null
}
