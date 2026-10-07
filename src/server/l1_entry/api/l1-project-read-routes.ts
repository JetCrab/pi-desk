import 'server-only'
import * as contracts from '@common/l3_modules/project-files/l3-project-files-contract'
import {
  getL4WorkSessionProjectFile,
  listL4WorkSessionProjectFiles,
  searchL4WorkSessionProjectFiles
} from '@server/l4_foundation/file/l4-work-session-project-file'
import {
  getL4WorkSessionGitHeads,
  getL4WorkSessionGitSnapshot
} from '@server/l4_foundation/git/l4-work-session-git'
import {
  getL4ProjectGitDiff,
  listL4ProjectGitBranches,
  listL4ProjectGitChanges,
  listL4ProjectGitLog
} from '@server/l4_foundation/git/l4-project-git-history'
import { createL1ProjectRoute } from './l1-project-route'

export const projectFileList = createL1ProjectRoute(contracts.L3ProjectFileList, (input) =>
  listL4WorkSessionProjectFiles(input.cwd, input.path)
)
export const projectFileSearch = createL1ProjectRoute(contracts.L3ProjectFileSearch, (input) =>
  searchL4WorkSessionProjectFiles(input.cwd, input.query)
)
export const projectFileGet = createL1ProjectRoute(contracts.L3ProjectFileGet, (input) =>
  getL4WorkSessionProjectFile(input.cwd, input.path, input.imagePreviewMode)
)
export const projectGitGet = createL1ProjectRoute(contracts.L3ProjectGitGet, (input) =>
  getL4WorkSessionGitSnapshot(input.cwd, input.refresh)
)
export const projectGitHeads = createL1ProjectRoute(contracts.L3ProjectGitHeads, (input) =>
  getL4WorkSessionGitHeads(input.cwd)
)
export const projectGitBranches = createL1ProjectRoute(contracts.L3ProjectGitBranches, (input) =>
  listL4ProjectGitBranches(input.cwd, input.repositoryRoot)
)
export const projectGitLog = createL1ProjectRoute(contracts.L3ProjectGitLog, (input) =>
  listL4ProjectGitLog(input.cwd, input.repositoryRoot, input)
)
export const projectGitChanges = createL1ProjectRoute(contracts.L3ProjectGitChanges, (input) =>
  listL4ProjectGitChanges(input.cwd, input.repositoryRoot, input)
)
export const projectGitDiff = createL1ProjectRoute(contracts.L3ProjectGitDiff, (input) =>
  getL4ProjectGitDiff(input.cwd, input.repositoryRoot, input.path, input.comparison)
)
