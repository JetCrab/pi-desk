'use client'

import {
  BracesIcon,
  ChevronRightIcon,
  FileCode2Icon,
  FileIcon,
  FileTextIcon,
  FolderGit2Icon,
  FolderIcon,
  GitBranchIcon,
  ImageIcon,
  ListFilterIcon,
  LoaderCircleIcon,
  SearchIcon,
  XIcon
} from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { L4GitRepository } from '@common/l4_foundation/git/l4-git-contract'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName
} from '@client/l4_foundation/ui/ai-elements/file-tree'
import { L4ScrollArea } from '@client/l4_foundation/ui/l4-scroll-area'
import { buttonVariants } from '@client/l4_foundation/ui/shadcn/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@client/l4_foundation/ui/shadcn/input-group'
import type { L3ProjectGitBrowser } from './l3-project-git-runtime'
import {
  getL3GitChangeBadge,
  getL3GitHeadLabel,
  getL3GitRepositoryName,
  joinL3GitProjectPath,
  listL3GitProjectChanges,
  type L3GitProjectChange
} from './l3-project-git-model'
import type { L3DirectoryState, L3ProjectFileRuntime } from './l3-project-file-runtime'
import { L3ProjectPathMenu } from './l3-project-path-menu'
import {
  buildL3ProjectPathTree,
  compactL3PathTreeDirectory,
  compareL3ProjectNames,
  keyL3ProjectTree,
  joinL3ProjectPath as joinPath,
  type L3CompactDirectory
} from './l3-project-path-tree'

interface L3ProjectFileBrowserProps {
  cwd: string
  projectName: string
  runtime: L3ProjectFileRuntime
  gitRuntime: L3ProjectGitBrowser
  onOpenGitBranches: (repositoryRoot: string) => void
  onFileOpened?: () => void
}

const EMPTY_GIT_REPOSITORIES: readonly L4GitRepository[] = []

function compactPath(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

function fileIcon(path: string): React.JSX.Element {
  const name = path.split('/').at(-1)?.toLocaleLowerCase() ?? ''
  const extension = name.includes('.') ? (name.split('.').at(-1) ?? '') : ''
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) {
    return <ImageIcon className="size-4 text-muted-foreground" />
  }
  if (extension === 'json' || extension === 'jsonl') {
    return <BracesIcon className="size-4 text-muted-foreground" />
  }
  if (['md', 'mdx', 'txt'].includes(extension)) {
    return <FileTextIcon className="size-4 text-muted-foreground" />
  }
  if (
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'py',
      'go',
      'rs',
      'java',
      'c',
      'cpp',
      'h',
      'hpp',
      'css',
      'scss',
      'html',
      'xml',
      'yaml',
      'yml',
      'toml',
      'sql',
      'sh'
    ].includes(extension)
  ) {
    return <FileCode2Icon className="size-4 text-muted-foreground" />
  }
  return <FileIcon className="size-4 text-muted-foreground" />
}

function changedFileNameClass(change: L3GitProjectChange | null): string | undefined {
  if (!change) return undefined
  const badge = getL3GitChangeBadge(change.change)
  if (badge === 'D') return 'text-muted-foreground'
  if (badge === '?') return 'text-red-600 dark:text-red-400'
  if (badge === 'A') return 'text-emerald-600 dark:text-emerald-400'
  if (badge === '!') return 'text-violet-600 dark:text-violet-400'
  return 'text-blue-600 dark:text-blue-400'
}

function DirectoryFeedback({
  state,
  onRetry
}: {
  state: L3DirectoryState | undefined
  onRetry: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation('projectFiles')
  if (!state || state.status === 'idle' || state.status === 'loading') {
    return (
      <div className="flex min-h-8 items-center gap-2 px-2 text-xs text-muted-foreground">
        <LoaderCircleIcon className="size-3.5 animate-spin" /> {t('reading')}
      </div>
    )
  }
  if (state.status !== 'error') return null
  return (
    <button
      type="button"
      onClick={onRetry}
      className="min-h-8 w-full rounded px-2 text-left text-xs text-destructive hover:bg-destructive/10"
    >
      {t('retryReading', { error: state.error })}
    </button>
  )
}

export function L3ProjectFileBrowser({
  cwd,
  projectName,
  runtime,
  gitRuntime,
  onOpenGitBranches,
  onFileOpened
}: L3ProjectFileBrowserProps): React.JSX.Element {
  const { t } = useTranslation('projectFiles')
  const { locale } = useL4Region()
  useSyncExternalStore(runtime.subscribe, runtime.getRevision, runtime.getRevision)
  useSyncExternalStore(gitRuntime.subscribe, gitRuntime.getRevision, gitRuntime.getRevision)
  const workspace = runtime.state
  const gitWorkspace = gitRuntime.getWorkspace(cwd)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [visibleEntries, setVisibleEntries] = useState<Record<string, number>>({})
  const moreEntries = (key: string, total: number): React.ReactNode => {
    const count = visibleEntries[key] ?? 300
    return count < total ? (
      <button
        type="button"
        className="min-h-8 px-3 text-sm text-muted-foreground hover:bg-accent"
        onClick={(event) => {
          event.stopPropagation()
          setVisibleEntries((previous) => ({ ...previous, [key]: count + 300 }))
        }}
      >
        {t('showMore', { visible: count, total })}
      </button>
    ) : null
  }
  const searchQuery = workspace?.search.query ?? ''
  const repositories = gitWorkspace?.snapshot.repositories ?? EMPTY_GIT_REPOSITORIES
  const projectChanges = listL3GitProjectChanges(repositories)
  const changeByProjectPath = new Map(projectChanges.map((change) => [change.projectPath, change]))
  const readyRepositoryRoots = repositories.map((repository) => repository.root).filter(Boolean)

  useEffect(() => {
    void runtime.ensureRoot()
    void gitRuntime.ensureSnapshot(cwd)
  }, [cwd, gitRuntime, runtime])

  useEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement || !workspace) return
    scrollElement.scrollTop = workspace.treeScrollTop
  }, [workspace])

  useEffect(() => {
    if (!searchQuery.trim() || gitWorkspace?.changesOnly) return
    const timer = window.setTimeout(() => void runtime.search(searchQuery), 220)
    return () => window.clearTimeout(timer)
  }, [gitWorkspace?.changesOnly, runtime, searchQuery])

  const expandedRepositoryRootsKey = [...(gitWorkspace?.expandedRepositories ?? [])].join('\u0000')
  useEffect(() => {
    if (!gitWorkspace || gitWorkspace.layout !== 'repository') return
    for (const root of gitWorkspace.expandedRepositories) {
      void runtime.ensureDirectory(root)
    }
  }, [expandedRepositoryRootsKey, gitWorkspace, runtime])

  const boundaries = new Set(readyRepositoryRoots)
  const displayedDirectories = new Map<string, L3CompactDirectory>()
  const expandedKeys = new Set(
    [...workspace.expandedPaths].map((path) => keyL3ProjectTree('directory', path))
  )
  const toggleDirectory = (directory: L3CompactDirectory, expanded: boolean): void => {
    const next = new Set(workspace.expandedPaths)
    for (const path of directory.paths) {
      if (expanded) next.add(path)
      else next.delete(path)
    }
    runtime.setExpandedPaths(next, false)
    if (expanded && !gitWorkspace?.changesOnly)
      void runtime.expandDirectoryChain(directory.path, boundaries)
  }
  const applyExpanded = (keys: Set<string>): void => {
    const changed = [...displayedDirectories].filter(
      ([path]) =>
        keys.has(keyL3ProjectTree('directory', path)) !== workspace.expandedPaths.has(path)
    )
    for (const [path, directory] of changed)
      toggleDirectory(directory, keys.has(keyL3ProjectTree('directory', path)))
  }

  const openPreview = (path: string): void => {
    runtime.openFile(path)
    onFileOpened?.()
  }

  const openDiff = (change: L3GitProjectChange): void => {
    runtime.openDiff(change.repositoryRoot, change.path)
    onFileOpened?.()
  }

  const directoryMenu = (
    directory: L3CompactDirectory,
    trigger: React.ReactElement
  ): React.JSX.Element => (
    <L3ProjectPathMenu
      key={keyL3ProjectTree('directory', directory.path)}
      cwd={cwd}
      path={directory.targetPath}
      type="directory"
      trigger={trigger}
      expanded={workspace.expandedPaths.has(directory.path)}
      onToggle={() => toggleDirectory(directory, !workspace.expandedPaths.has(directory.path))}
      onReveal={runtime.canReveal ? (path, type) => runtime.revealFile(path, type) : undefined}
    />
  )
  const fileContextMenu = (
    path: string,
    trigger: React.ReactElement,
    change: L3GitProjectChange | null = null,
    diffOnSelect = false
  ): React.JSX.Element => (
    <L3ProjectPathMenu
      key={keyL3ProjectTree('file', path)}
      cwd={cwd}
      path={path}
      type="file"
      trigger={trigger}
      openLabel={t(diffOnSelect ? 'viewDiff' : 'openPreview')}
      onOpen={() => (diffOnSelect && change ? openDiff(change) : openPreview(path))}
      oldPath={
        change?.change.oldPath ? joinPath(change.repositoryRoot, change.change.oldPath) : undefined
      }
      onReveal={runtime.canReveal ? (path, type) => runtime.revealFile(path, type) : undefined}
    />
  )

  const renderFile = (
    path: string,
    name: string,
    change: L3GitProjectChange | null,
    diffOnSelect: boolean
  ): React.JSX.Element => {
    return fileContextMenu(
      path,
      <FileTreeFile
        path={keyL3ProjectTree('file', path)}
        name={name}
        title={path}
        data-testid={`project-file-${path}`}
        onClick={() => {
          if (diffOnSelect && change) openDiff(change)
          else openPreview(path)
        }}
      >
        <span className="size-6 shrink-0" />
        <FileTreeIcon>{fileIcon(path)}</FileTreeIcon>
        <FileTreeName
          data-testid={`project-file-name-${path}`}
          className={cn('min-w-0 flex-1', changedFileNameClass(change))}
        >
          {name}
        </FileTreeName>
        {change ? (
          <span
            className={cn('text-xs tabular-nums', changedFileNameClass(change))}
            aria-label={t('gitStatus', { status: getL3GitChangeBadge(change.change) })}
          >
            {getL3GitChangeBadge(change.change)}
          </span>
        ) : null}
      </FileTreeFile>,
      change,
      diffOnSelect
    )
  }

  const isNestedRepositoryBoundary = (
    childPath: string,
    currentRepositoryRoot: string | null
  ): boolean =>
    readyRepositoryRoots.some((root) => root !== currentRepositoryRoot && childPath === root)

  const renderDirectory = (
    path: string,
    currentRepositoryRoot: string | null,
    respectRepositoryBoundaries: boolean
  ): React.ReactNode => {
    const state = workspace?.directories.get(path)
    if (state?.status !== 'ready') {
      return <DirectoryFeedback state={state} onRetry={() => void runtime.ensureDirectory(path)} />
    }

    const entries = respectRepositoryBoundaries
      ? state.entries.filter(
          (entry) => !isNestedRepositoryBoundary(joinPath(path, entry.name), currentRepositoryRoot)
        )
      : state.entries

    return (
      <>
        {entries.slice(0, visibleEntries[`directory:${path}`] ?? 300).map((entry) => {
          const childPath = joinPath(path, entry.name)
          if (entry.type === 'file')
            return renderFile(
              childPath,
              entry.name,
              changeByProjectPath.get(childPath) ?? null,
              false
            )
          const directory = runtime.compactDirectory(childPath, boundaries)
          displayedDirectories.set(childPath, directory)
          return directoryMenu(
            directory,
            <FileTreeFolder
              path={keyL3ProjectTree('directory', childPath)}
              name={directory.label}
              title={directory.targetPath}
              data-testid={`project-folder-${childPath}`}
            >
              {renderDirectory(
                directory.targetPath,
                currentRepositoryRoot,
                respectRepositoryBoundaries
              )}
            </FileTreeFolder>
          )
        })}
        {moreEntries(`directory:${path}`, entries.length)}
        {state.truncated ? (
          <p className="px-2 py-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
            {t('directoryLimit')}
          </p>
        ) : null}
        {entries.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t('emptyDirectory')}</p>
        ) : null}
      </>
    )
  }

  const renderChangeNodes = (
    tree: ReturnType<typeof buildL3ProjectPathTree>,
    path: string
  ): React.ReactNode => {
    const node = tree.get(path)
    if (!node) return null
    const directories = [...node.directories.keys()].sort(compareL3ProjectNames)
    const files = [...node.files].sort(compareL3ProjectNames)
    const limit = visibleEntries[`changes:${path}`] ?? 300
    return (
      <>
        {directories.slice(0, limit).map((childPath) => {
          const directory = compactL3PathTreeDirectory(childPath, tree, boundaries)
          displayedDirectories.set(childPath, directory)
          return directoryMenu(
            directory,
            <FileTreeFolder
              path={keyL3ProjectTree('directory', childPath)}
              name={directory.label}
              title={directory.targetPath}
              data-testid={`project-folder-${childPath}`}
            >
              {renderChangeNodes(tree, directory.targetPath)}
            </FileTreeFolder>
          )
        })}
        {files
          .slice(0, Math.max(0, limit - directories.length))
          .map((file) =>
            renderFile(
              file,
              file.slice(file.lastIndexOf('/') + 1),
              changeByProjectPath.get(file) ?? null,
              true
            )
          )}
        {moreEntries(`changes:${path}`, directories.length + files.length)}
      </>
    )
  }

  const selectDirectoryPath = (key: string): void => {
    if (key.startsWith('directory:')) {
      const directory = displayedDirectories.get(key.slice('directory:'.length))
      if (directory) toggleDirectory(directory, !workspace.expandedPaths.has(directory.path))
      return
    }
    const path = key.slice('file:'.length)
    const change = changeByProjectPath.get(path)
    if (gitWorkspace?.changesOnly && change) openDiff(change)
    else openPreview(path)
  }

  const renderDirectoryView = (): React.JSX.Element => {
    if (gitWorkspace?.changesOnly) {
      const root = buildL3ProjectPathTree(projectChanges.map((change) => change.projectPath))
      return (
        <FileTree
          className="rounded-none border-0 bg-transparent"
          expanded={expandedKeys}
          selectedPath={
            workspace?.activeDiff
              ? keyL3ProjectTree(
                  'file',
                  joinL3GitProjectPath(
                    workspace.activeDiff.repositoryRoot,
                    workspace.activeDiff.path
                  )
                )
              : workspace.activePath
                ? keyL3ProjectTree('file', workspace.activePath)
                : undefined
          }
          onExpandedChange={applyExpanded}
          onSelect={selectDirectoryPath}
        >
          {projectChanges.length > 0 ? (
            renderChangeNodes(root, '')
          ) : (
            <p className="px-2 py-5 text-center text-xs text-muted-foreground">
              {repositories.some((item) => item.state === 'unavailable')
                ? t('incompleteRepository')
                : t('noChangedFiles')}
            </p>
          )}
        </FileTree>
      )
    }

    return (
      <FileTree
        className="rounded-none border-0 bg-transparent"
        expanded={expandedKeys}
        selectedPath={
          workspace.activePath ? keyL3ProjectTree('file', workspace.activePath) : undefined
        }
        onExpandedChange={applyExpanded}
        onSelect={selectDirectoryPath}
      >
        {renderDirectory('', null, false)}
      </FileTree>
    )
  }

  const renderRepositorySection = (
    repository: L4GitRepository | null,
    root: string,
    name: string
  ): React.JSX.Element | null => {
    if (gitWorkspace?.changesOnly && !repository) return null
    const expanded = gitWorkspace?.expandedRepositories.has(root) ?? false
    const repositoryChanges =
      repository?.state === 'ready'
        ? projectChanges.filter((change) => change.repositoryRoot === root)
        : []
    const count = repositoryChanges.length
    if (gitWorkspace?.changesOnly && repository?.state === 'ready' && count === 0) return null
    const changeRoot = buildL3ProjectPathTree(
      repositoryChanges.map((change) => change.projectPath),
      root
    )
    return (
      <section
        key={repository ? `git:${root}` : 'workspace'}
        data-testid={`project-git-repository-${root || 'root'}`}
        className="border-b last:border-b-0"
      >
        <div className="flex min-h-8 items-center gap-1 px-1 py-0.5">
          <button
            data-testid={`project-git-repository-toggle-${root || 'root'}`}
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-muted/60"
            aria-expanded={expanded}
            onClick={() => {
              if (expanded) runtime.cancelDirectoryExpansion(root)
              gitRuntime.toggleRepository(cwd, root)
              if (!expanded) void runtime.ensureDirectory(root)
            }}
          >
            <ChevronRightIcon
              className={cn(
                'size-3 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )}
            />
            {repository ? (
              <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span
              className="min-w-0 flex-1 truncate text-sm font-medium"
              title={repository ? root || projectName : projectName}
            >
              {name}
            </span>
          </button>
          {repository ? (
            <button
              data-testid={`project-git-branch-${root || 'root'}`}
              type="button"
              disabled={repository.state !== 'ready'}
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'max-w-28 shrink gap-1 font-mono text-xs text-muted-foreground'
              )}
              title={
                repository.state === 'ready'
                  ? t('gitBranches')
                  : selectL4LocalizedText(repository.message, locale)
              }
              onClick={() => onOpenGitBranches(root)}
            >
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="min-w-0 truncate">
                {repository.state === 'ready'
                  ? getL3GitHeadLabel(repository.head)
                  : t('unavailable')}
              </span>
              {count > 0 ? (
                <span className="rounded-md bg-muted px-1 text-xs text-status-warning">
                  {count}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
        {expanded ? (
          gitWorkspace?.changesOnly ? (
            <FileTree
              className="rounded-none border-0 bg-transparent px-1 pb-1"
              expanded={expandedKeys}
              selectedPath={
                workspace?.activeDiff
                  ? keyL3ProjectTree(
                      'file',
                      joinL3GitProjectPath(
                        workspace.activeDiff.repositoryRoot,
                        workspace.activeDiff.path
                      )
                    )
                  : undefined
              }
              onExpandedChange={applyExpanded}
              onSelect={selectDirectoryPath}
            >
              {count > 0 ? (
                renderChangeNodes(changeRoot, root)
              ) : (
                <p className="px-2 py-3 text-xs text-muted-foreground">{t('noChanges')}</p>
              )}
            </FileTree>
          ) : (
            <FileTree
              className="rounded-none border-0 bg-transparent px-1 pb-1"
              expanded={expandedKeys}
              selectedPath={
                workspace.activePath ? keyL3ProjectTree('file', workspace.activePath) : undefined
              }
              onExpandedChange={applyExpanded}
              onSelect={selectDirectoryPath}
            >
              {renderDirectory(root, repository?.root ?? null, true)}
            </FileTree>
          )
        ) : null}
      </section>
    )
  }

  const renderRepositoryView = (): React.JSX.Element => {
    const hasProjectRootRepository = repositories.some((repository) => repository.root === '')
    const visibleRepositories = gitWorkspace?.changesOnly
      ? repositories.filter(
          (repository) => repository.state === 'unavailable' || repository.changes.length > 0
        )
      : repositories
    return (
      <div className="px-1">
        {!hasProjectRootRepository ? renderRepositorySection(null, '', projectName) : null}
        {visibleRepositories.map((repository) =>
          renderRepositorySection(
            repository,
            repository.root,
            getL3GitRepositoryName(projectName, repository.root)
          )
        )}
        {gitWorkspace?.changesOnly && visibleRepositories.length === 0 ? (
          <p className="px-2 py-5 text-center text-xs text-muted-foreground">
            {t('noChangedFiles')}
          </p>
        ) : null}
      </div>
    )
  }

  const changeSearchResults = projectChanges.filter((change) =>
    change.projectPath.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase())
  )
  const searching = searchOpen && Boolean(searchQuery.trim())
  const singleProjectRootRepository =
    repositories.length === 1 && repositories[0]?.root === '' ? repositories[0] : null
  const showLayoutToggle = repositories.length > 0 && !singleProjectRootRepository
  const effectiveLayout = showLayoutToggle ? (gitWorkspace?.layout ?? 'directory') : 'directory'

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-sidebar"
      aria-label={t('projectFiles', { name: projectName })}
    >
      <div className="space-y-1.5 border-b px-2.5 py-2">
        <div className="flex min-h-7 min-w-0 items-center gap-2">
          <L3ProjectPathMenu
            cwd={cwd}
            path=""
            type="directory"
            onReveal={
              runtime.canReveal ? (path, type) => runtime.revealFile(path, type) : undefined
            }
            trigger={
              <div tabIndex={0} className="flex min-w-0 flex-1 items-baseline gap-1">
                <p className="shrink-0 truncate text-xs font-semibold" title={projectName}>
                  {projectName}
                </p>
                <span className="text-xs text-muted-foreground">·</span>
                <p className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={cwd}>
                  {compactPath(cwd)}
                </p>
              </div>
            }
          />
          {singleProjectRootRepository ? (
            <button
              type="button"
              disabled={singleProjectRootRepository.state !== 'ready'}
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'max-w-32 shrink gap-1 font-mono text-xs text-muted-foreground'
              )}
              title={
                singleProjectRootRepository.state === 'ready'
                  ? t('gitBranches')
                  : selectL4LocalizedText(singleProjectRootRepository.message, locale)
              }
              onClick={() => onOpenGitBranches('')}
            >
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="truncate">
                {singleProjectRootRepository.state === 'ready'
                  ? getL3GitHeadLabel(singleProjectRootRepository.head)
                  : t('unavailable')}
              </span>
            </button>
          ) : null}
        </div>

        {searchOpen ? (
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchInputRef}
              data-testid="project-file-search"
              value={searchQuery}
              onChange={(event) => runtime.setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                runtime.setSearchQuery('')
                setSearchOpen(false)
              }}
              placeholder={t('searchFiles')}
              aria-label={t('searchFiles')}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                onClick={() => {
                  runtime.setSearchQuery('')
                  setSearchOpen(false)
                }}
                aria-label={t('closeSearch')}
              >
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        ) : (
          <div className="flex min-h-8 min-w-0 items-center gap-1.5">
            {showLayoutToggle ? (
              <div
                className="flex shrink-0 rounded-md border bg-background/55 p-0.5"
                role="group"
                aria-label={t('layout')}
              >
                {(['directory', 'repository'] as const).map((layout) => (
                  <button
                    key={layout}
                    data-testid={`project-file-layout-${layout}`}
                    type="button"
                    aria-pressed={effectiveLayout === layout}
                    className={cn(
                      buttonVariants({ variant: 'ghost', size: 'sm' }),
                      effectiveLayout === layout && 'bg-accent text-accent-foreground'
                    )}
                    onClick={() => {
                      runtime.cancelDirectoryExpansion()
                      gitRuntime.setLayout(cwd, layout)
                    }}
                  >
                    {t(layout === 'directory' ? 'directory' : 'repository')}
                  </button>
                ))}
              </div>
            ) : null}
            {repositories.length > 0 ? (
              <button
                data-testid="project-git-changes-toggle"
                type="button"
                aria-pressed={gitWorkspace?.changesOnly ?? false}
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  'min-w-0 gap-1',
                  gitWorkspace?.changesOnly && 'bg-accent text-accent-foreground'
                )}
                onClick={() => {
                  runtime.cancelDirectoryExpansion()
                  gitRuntime.setChangesOnly(cwd, !(gitWorkspace?.changesOnly ?? false))
                }}
              >
                <ListFilterIcon className="size-3 shrink-0" />
                <span className="truncate">{t('changesOnly')}</span>
                <span className="rounded-md bg-muted px-1 font-mono text-xs">
                  {projectChanges.length}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              className={cn(buttonVariants({ variant: 'outline', size: 'icon-sm' }), 'ml-auto')}
              aria-label={t('searchProject')}
              title={t('searchProject')}
              onClick={() => {
                setSearchOpen(true)
                requestAnimationFrame(() => searchInputRef.current?.focus())
              }}
            >
              <SearchIcon className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      <L4ScrollArea
        className="min-h-0 flex-1"
        viewportClassName="py-1.5"
        viewportRef={scrollRef}
        onViewportScroll={(event) => runtime.setTreeScrollTop(event.currentTarget.scrollTop)}
      >
        {repositories
          .filter((item) => item.state === 'unavailable')
          .map((item) =>
            item.state === 'unavailable' ? (
              <p
                key={item.root}
                role="alert"
                className="mx-2 mb-1 break-words rounded-md bg-muted px-2 py-2 text-sm text-destructive"
              >
                {item.root || projectName}：{selectL4LocalizedText(item.message, locale)}
              </p>
            ) : null
          )}
        {gitWorkspace?.snapshot.status === 'error' ? (
          <p className="mx-2 mb-1 rounded-md bg-muted px-2 py-2 text-sm text-destructive">
            {gitWorkspace.snapshot.error}
          </p>
        ) : null}
        {searching ? (
          <div className="space-y-0.5 px-1">
            {gitWorkspace?.changesOnly ? (
              changeSearchResults.length > 0 ? (
                changeSearchResults.map((change) => {
                  return fileContextMenu(
                    change.projectPath,
                    <button
                      type="button"
                      className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-muted/70"
                      onClick={() => {
                        openDiff(change)
                      }}
                      title={change.projectPath}
                    >
                      {fileIcon(change.projectPath)}
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate text-xs font-medium',
                            changedFileNameClass(change)
                          )}
                        >
                          {change.projectPath.split('/').at(-1)}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                          {change.projectPath}
                        </span>
                      </span>
                    </button>,
                    change,
                    true
                  )
                })
              ) : (
                <p className="px-2 py-5 text-center text-xs text-muted-foreground">
                  {t('noMatches')}
                </p>
              )
            ) : (
              <>
                {workspace?.search.status === 'loading' ? (
                  <div className="flex min-h-10 items-center gap-2 px-2 text-xs text-muted-foreground">
                    <LoaderCircleIcon className="size-3.5 animate-spin" /> {t('searching')}
                  </div>
                ) : null}
                {workspace?.search.status === 'error' ? (
                  <p className="px-2 py-2 text-xs text-destructive">{workspace.search.error}</p>
                ) : null}
                {workspace?.search.status === 'ready'
                  ? workspace.search.matches.map((path) => {
                      const change = changeByProjectPath.get(path) ?? null
                      return fileContextMenu(
                        path,
                        <button
                          data-testid={`project-search-result-${path}`}
                          type="button"
                          onClick={() => {
                            openPreview(path)
                          }}
                          className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-muted/70"
                          title={path}
                        >
                          <span className="shrink-0">{fileIcon(path)}</span>
                          <span className="min-w-0 flex-1">
                            <span
                              className={cn(
                                'block truncate text-xs font-medium',
                                changedFileNameClass(change)
                              )}
                            >
                              {path.split('/').at(-1)}
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                              {path}
                            </span>
                          </span>
                        </button>
                      )
                    })
                  : null}
                {workspace?.search.status === 'ready' && workspace.search.matches.length === 0 ? (
                  <p className="px-2 py-5 text-center text-xs text-muted-foreground">
                    {t('noMatches')}
                  </p>
                ) : null}
                {workspace?.search.status === 'ready' && workspace.search.truncated ? (
                  <p className="px-2 py-2 text-xs text-amber-600 dark:text-amber-400">
                    {t('resultLimit')}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : effectiveLayout === 'repository' ? (
          renderRepositoryView()
        ) : (
          renderDirectoryView()
        )}
      </L4ScrollArea>
    </section>
  )
}
