import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import type { L4Locale } from '@common/l4_foundation/locale/l4-locale'
import { L3_PROJECT_FILES_LOCALE_MESSAGES } from '@common/l3_modules/project-files/l3-project-files-locale-messages'
import type {
  L4GitFileChange,
  L4GitHead,
  L4GitRepository,
  L4GitRepositoryHead,
  L4GitRepositoryReady
} from '@common/l4_foundation/git/l4-git-contract'
import { joinL3ProjectPath } from './l3-project-path-tree'

export interface L3GitBranchSummary {
  full: string
  compact: string
  title: string
  diverged: boolean
}

export interface L3GitProjectChange {
  repositoryRoot: string
  repository: L4GitRepositoryReady
  path: string
  projectPath: string
  change: L4GitFileChange
}

export interface L3GitBranchTreeNode {
  name: string
  path: string
  branchName: string | null
  children: readonly L3GitBranchTreeNode[]
}

interface MutableBranchTreeNode {
  name: string
  path: string
  branchName: string | null
  children: Map<string, MutableBranchTreeNode>
}

function finalizeBranchTree(nodes: Iterable<MutableBranchTreeNode>): L3GitBranchTreeNode[] {
  return [...nodes]
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    )
    .map((node) => ({
      name: node.name,
      path: node.path,
      branchName: node.branchName,
      children: finalizeBranchTree(node.children.values())
    }))
}

export function buildL3GitBranchTree(branchNames: readonly string[]): L3GitBranchTreeNode[] {
  const roots = new Map<string, MutableBranchTreeNode>()
  for (const branchName of branchNames) {
    const segments = branchName.split('/').filter(Boolean)
    let children = roots
    let path = ''
    for (const [index, name] of segments.entries()) {
      path = path ? `${path}/${name}` : name
      let node = children.get(name)
      if (!node) {
        node = { name, path, branchName: null, children: new Map() }
        children.set(name, node)
      }
      if (index === segments.length - 1) node.branchName = branchName
      children = node.children
    }
  }
  return finalizeBranchTree(roots.values())
}

export function joinL3GitProjectPath(repositoryRoot: string, path: string): string {
  return joinL3ProjectPath(repositoryRoot, path)
}

export function getL3GitRepositoryName(projectName: string, repositoryRoot: string): string {
  return repositoryRoot.split('/').at(-1) || projectName
}

export function getL3GitHeadLabel(head: L4GitHead): string {
  return head.type === 'branch' ? head.name : `@ ${head.commit.slice(0, 7)}`
}

export function getL3GitBranchSummary(
  projectName: string,
  repositories: readonly L4GitRepositoryHead[],
  locale: L4Locale = 'en'
): L3GitBranchSummary | null {
  if (repositories.length === 0) return null
  const labels = L3_PROJECT_FILES_LOCALE_MESSAGES[locale]
  if (repositories.length === 1) {
    const repository = repositories[0]!
    const name = getL3GitRepositoryName(projectName, repository.root)
    if (repository.state === 'unavailable') {
      const unavailable = labels.gitUnavailable
      return {
        full: repository.root ? `${name} · ${unavailable}` : unavailable,
        compact: 'Git !',
        title: `${name}${locale === 'en' ? ': ' : '：'}${selectL4LocalizedText(repository.message, locale)}`,
        diverged: true
      }
    }
    const branch = getL3GitHeadLabel(repository.head)
    return {
      full: repository.root ? `${name} · ${branch}` : branch,
      compact: branch,
      title: `${labels.gitBranches}: ${name} · ${branch}`,
      diverged: repository.head.type === 'detached'
    }
  }

  const repositoryCount = `${repositories.length} ${labels.repositoriesUnit}`
  return {
    full: repositoryCount,
    compact: `Git ${repositories.length}`,
    title: `${labels.gitBranches}: ${repositoryCount}`,
    diverged: false
  }
}

export function getL3GitChangeBadge(change: L4GitFileChange): string {
  const statuses = [change.indexStatus, change.worktreeStatus]
  if (statuses.includes('unmerged')) return '!'
  if (statuses.includes('deleted')) return 'D'
  if (statuses.includes('renamed')) return 'R'
  if (statuses.includes('added')) return 'A'
  if (statuses.includes('modified')) return 'M'
  return '?'
}

export function listL3GitProjectChanges(
  repositories: readonly L4GitRepository[]
): L3GitProjectChange[] {
  return repositories.flatMap((repository) =>
    repository.state === 'ready'
      ? repository.changes.map((change) => ({
          repositoryRoot: repository.root,
          repository,
          path: change.path,
          projectPath: joinL3GitProjectPath(repository.root, change.path),
          change
        }))
      : []
  )
}
