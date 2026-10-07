'use client'

import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  Globe2Icon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon
} from 'lucide-react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2WorkSessionGitBranchTarget } from '@common/l2_biz/work-session/l2-work-session-git-contract'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import {
  L4AppDialogContent,
  L4AppDialogDescription,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import type { L2GitWorkspaceRuntime } from './l2-git-workspace-runtime'
import {
  buildL2GitBranchTree,
  getL2GitHeadLabel,
  getL2GitRepositoryName,
  type L2GitBranchPickerTarget,
  type L2GitBranchTreeNode
} from './l2-git-workspace-model'

interface L2GitBranchPickerProps {
  target: L2GitBranchPickerTarget | null
  runtime: L2GitWorkspaceRuntime
  mobile: boolean
  onClose: () => void
}

type SelectedBranch = L2WorkSessionGitBranchTarget

interface BranchGroupState {
  repositoryRoot: string | null
  overrides: ReadonlyMap<string, boolean>
}

const EMPTY_REPOSITORIES: NonNullable<
  ReturnType<L2GitWorkspaceRuntime['getWorkspace']>
>['heads']['repositories'] = []

function branchNames(names: readonly string[], query: string): string[] {
  const normalized = query.trim().toLocaleLowerCase()
  return normalized
    ? names.filter((name) => name.toLocaleLowerCase().includes(normalized))
    : [...names]
}

export function L2GitBranchPicker({
  target,
  runtime,
  mobile,
  onClose
}: L2GitBranchPickerProps): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const { locale } = useL4Region()
  useSyncExternalStore(runtime.subscribe, runtime.getRevision, runtime.getRevision)
  const toast = useL4AppToast()
  const [selectedRepositoryRoot, setSelectedRepositoryRoot] = useState<string | null>(null)
  const [mobileDetail, setMobileDetail] = useState(target?.repositoryRoot !== null)
  const [query, setQuery] = useState('')
  const [branchGroupState, setBranchGroupState] = useState<BranchGroupState>(() => ({
    repositoryRoot: null,
    overrides: new Map()
  }))
  const [selectedBranch, setSelectedBranch] = useState<SelectedBranch | null>(null)
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [newBranchStartPoint, setNewBranchStartPoint] = useState<SelectedBranch | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const workspace = runtime.getWorkspace(target?.cwd ?? null)
  const repositories = workspace?.heads.repositories ?? EMPTY_REPOSITORIES
  const defaultRepositoryRoot = target
    ? target.repositoryRoot !== null &&
      repositories.some((repository) => repository.root === target.repositoryRoot)
      ? target.repositoryRoot
      : (repositories.find((repository) => repository.root === '')?.root ??
        repositories[0]?.root ??
        null)
    : null
  const activeRepositoryRoot = selectedRepositoryRoot ?? defaultRepositoryRoot

  useEffect(() => {
    if (target) void runtime.refreshHeads(target.cwd)
  }, [runtime, target])

  useEffect(() => {
    if (!target || activeRepositoryRoot === null || workspace?.heads.status !== 'ready') {
      return
    }
    const repository = repositories.find((candidate) => candidate.root === activeRepositoryRoot)
    if (repository?.state === 'ready') {
      void runtime.loadBranches(target.cwd, activeRepositoryRoot)
    }
  }, [activeRepositoryRoot, repositories, runtime, target, workspace?.heads.status])

  const selectedRepository =
    repositories.find((repository) => repository.root === activeRepositoryRoot) ?? null
  const branches =
    activeRepositoryRoot === null ? null : (workspace?.branches.get(activeRepositoryRoot) ?? null)
  const branchData = branches?.data ?? null
  const operationPending =
    activeRepositoryRoot !== null && Boolean(workspace?.branchOperations.has(activeRepositoryRoot))
  const localBranches = useMemo(
    () => branchNames(branchData?.local ?? [], query),
    [branchData?.local, query]
  )
  const remoteBranches = useMemo(
    () => branchNames(branchData?.remote ?? [], query),
    [branchData?.remote, query]
  )
  const recentBranches = useMemo(
    () => branchNames(branchData?.recent ?? [], query),
    [branchData?.recent, query]
  )
  const localBranchTree = useMemo(() => buildL2GitBranchTree(localBranches), [localBranches])
  const remoteBranchTree = useMemo(() => buildL2GitBranchTree(remoteBranches), [remoteBranches])
  const currentBranch = branchData?.head.type === 'branch' ? branchData.head.name : null
  const defaultExpandedBranchGroups = useMemo(() => {
    const groups = new Set<string>()
    if (!currentBranch?.includes('/')) return groups
    const segments = currentBranch.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      groups.add(`local:${segments.slice(0, index).join('/')}`)
    }
    return groups
  }, [currentBranch])

  if (!target) return null

  const selectRepository = (root: string): void => {
    setSelectedRepositoryRoot(root)
    setMobileDetail(true)
    setQuery('')
    setBranchGroupState({ repositoryRoot: root, overrides: new Map() })
    setSelectedBranch(null)
    setNewBranchOpen(false)
    setNewBranchStartPoint(null)
    setActionError(null)
  }

  const openNewBranch = (startPoint: SelectedBranch | null): void => {
    setNewBranchStartPoint(startPoint)
    setNewBranchName('')
    setNewBranchOpen(true)
    setSelectedBranch(null)
    setActionError(null)
  }

  const runBranchOperation = async (
    operation: () => Promise<void>,
    success: string
  ): Promise<void> => {
    setActionError(null)
    try {
      await operation()
      toast.success(success)
      onClose()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('gitOperationFailed'))
    }
  }

  const switchBranch = (branch: SelectedBranch): void => {
    if (activeRepositoryRoot === null || operationPending) return
    void runBranchOperation(
      () => runtime.replaceBranch(target.cwd, activeRepositoryRoot, branch),
      t(branch.type === 'remote' ? 'checkedOut' : 'switchedBranch', { name: branch.name })
    )
  }

  const createBranch = (): void => {
    const name = newBranchName.trim()
    if (!name || activeRepositoryRoot === null || operationPending) return
    void runBranchOperation(
      () => runtime.addBranch(target.cwd, activeRepositoryRoot, name, newBranchStartPoint),
      t('branchCreated', { name })
    )
  }

  const showRepositoryList = repositories.length > 1
  const showDetail = !mobile || !showRepositoryList || mobileDetail
  const summary =
    repositories.length === 1
      ? t('repositorySummary', {
          name: getL2GitRepositoryName(target.projectName, repositories[0]!.root),
          branch:
            repositories[0]!.state === 'ready'
              ? getL2GitHeadLabel(repositories[0]!.head)
              : t('repositoryUnavailable')
        })
      : repositories.length > 1
        ? t('repositoryCount', { count: repositories.length })
        : t('readingRepos')

  const renderBranchRow = (
    branch: SelectedBranch,
    section: 'recent' | 'local' | 'remote',
    displayName = branch.name,
    depth = 0
  ): React.JSX.Element => {
    const current = branch.type === 'local' && branch.name === currentBranch
    const selected = selectedBranch?.type === branch.type && selectedBranch.name === branch.name
    return (
      <div key={`${section}:${branch.type}:${branch.name}`}>
        <button
          type="button"
          data-testid={
            section === 'recent'
              ? `git-branch-recent-${branch.name}`
              : `git-branch-${branch.type}-${branch.name}`
          }
          className={cn(
            'grid min-h-9 w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg pr-2 text-left outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring',
            current && 'font-medium text-foreground',
            selected && 'bg-accent'
          )}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          title={branch.name}
          onClick={() => setSelectedBranch(selected ? null : branch)}
        >
          <span className="text-muted-foreground">
            {current ? (
              <CheckIcon className="size-4 text-foreground" />
            ) : branch.type === 'remote' ? (
              <Globe2Icon className="size-3.5" />
            ) : (
              <GitBranchIcon className="size-3.5" />
            )}
          </span>
          <span className="truncate font-mono text-sm">{displayName}</span>
          <span className="text-xs text-muted-foreground">
            {current ? t('current') : section === 'recent' ? t('recent') : ''}
          </span>
        </button>
        {selected ? (
          <div
            className="flex flex-wrap gap-2 border-l-2 border-border py-2 pl-2"
            style={{ marginLeft: `${32 + depth * 16}px` }}
          >
            {current ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={operationPending}
                onClick={() => switchBranch(branch)}
              >
                {t(branch.type === 'remote' ? 'checkoutRemote' : 'switchGitBranch')}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={operationPending}
              onClick={() => openNewBranch(branch)}
            >
              {t('branchFromHere')}
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  const isBranchGroupExpanded = (section: 'local' | 'remote', path: string): boolean => {
    const key = `${section}:${path}`
    const override =
      branchGroupState.repositoryRoot === activeRepositoryRoot
        ? branchGroupState.overrides.get(key)
        : undefined
    return override ?? defaultExpandedBranchGroups.has(key)
  }

  const toggleBranchGroup = (section: 'local' | 'remote', path: string): void => {
    if (query.trim()) return
    const key = `${section}:${path}`
    const expanded = isBranchGroupExpanded(section, path)
    setBranchGroupState((current) => {
      const overrides =
        current.repositoryRoot === activeRepositoryRoot
          ? new Map(current.overrides)
          : new Map<string, boolean>()
      overrides.set(key, !expanded)
      return { repositoryRoot: activeRepositoryRoot, overrides }
    })
  }

  const renderBranchTree = (
    nodes: readonly L2GitBranchTreeNode[],
    section: 'local' | 'remote',
    depth = 0
  ): React.ReactNode =>
    nodes.map((node) => {
      if (node.children.length === 0 && node.branchName) {
        return renderBranchRow({ type: section, name: node.branchName }, section, node.name, depth)
      }

      const key = `${section}:${node.path}`
      const expanded = Boolean(query.trim()) || isBranchGroupExpanded(section, node.path)
      return (
        <div key={key}>
          <button
            type="button"
            data-testid={`git-branch-group-${section}-${node.path}`}
            aria-expanded={expanded}
            className="grid min-h-9 w-full cursor-pointer grid-cols-[1rem_1rem_minmax(0,1fr)] items-center gap-2 rounded-lg pr-2 text-left text-muted-foreground outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            style={{ paddingLeft: `${8 + depth * 16}px` }}
            title={node.path}
            onClick={() => toggleBranchGroup(section, node.path)}
          >
            <ChevronRightIcon
              className={cn('size-3 transition-transform', expanded && 'rotate-90')}
            />
            {expanded ? (
              <FolderOpenIcon className="size-4 text-muted-foreground" />
            ) : (
              <FolderIcon className="size-4 text-muted-foreground" />
            )}
            <span className="truncate font-mono text-sm">{node.name}</span>
          </button>
          {expanded ? renderBranchTree(node.children, section, depth + 1) : null}
        </div>
      )
    })

  return (
    <L4AppDialogRoot open onOpenChange={(open) => !open && onClose()}>
      <L4AppDialogContent
        data-testid="git-branch-picker"
        showCloseButton={false}
        finalFocus={false}
        className="h-[min(40rem,calc(100dvh-2rem))] max-w-[45rem] gap-0"
      >
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
          <div className="min-w-0 flex-1">
            <L4AppDialogTitle>{t('gitBranches')}</L4AppDialogTitle>
            <L4AppDialogDescription className="truncate text-xs">{summary}</L4AppDialogDescription>
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('refreshBranches')}
            disabled={workspace?.heads.status === 'loading'}
            onClick={() => void runtime.refreshHeads(target.cwd)}
          >
            <RefreshCwIcon
              className={cn('size-4', workspace?.heads.status === 'loading' && 'animate-spin')}
            />
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
        </header>

        <div
          className={cn(
            'grid min-h-0 flex-1',
            showRepositoryList && !mobile ? 'grid-cols-[220px_minmax(0,1fr)]' : 'grid-cols-1'
          )}
        >
          {showRepositoryList && (!mobile || !mobileDetail) ? (
            <aside className="pi-desk-chat-scrollbar min-h-0 overflow-y-auto border-r bg-sidebar p-2 max-sm:border-r-0">
              <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {t('repositories')}
              </p>
              {repositories.map((repository) => {
                const name = getL2GitRepositoryName(target.projectName, repository.root)
                const activeRepository = repository.root === activeRepositoryRoot
                return (
                  <button
                    key={repository.root}
                    data-testid={`git-branch-picker-repository-${repository.root || 'root'}`}
                    type="button"
                    className={cn(
                      'grid min-h-12 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 text-left hover:bg-muted/70',
                      activeRepository && 'bg-accent text-accent-foreground'
                    )}
                    onClick={() => selectRepository(repository.root)}
                  >
                    <span className="min-w-0">
                      <strong className="block truncate text-sm font-medium">{name}</strong>
                      <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                        {repository.root || '.'}
                      </span>
                    </span>
                    <span className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
                      <span className="max-w-28 truncate">
                        {repository.state === 'ready'
                          ? getL2GitHeadLabel(repository.head)
                          : t('unavailable')}
                      </span>
                    </span>
                  </button>
                )
              })}
            </aside>
          ) : null}

          {showDetail ? (
            <section className="flex min-h-0 min-w-0 flex-col">
              <div className="flex min-h-13 shrink-0 items-center gap-2 border-b px-3">
                {mobile && showRepositoryList ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('backRepositories')}
                    onClick={() => setMobileDetail(false)}
                  >
                    <ArrowLeftIcon className="size-4" />
                  </Button>
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {selectedRepository
                      ? getL2GitRepositoryName(target.projectName, selectedRepository.root)
                      : t('chooseRepository')}
                    {selectedRepository?.state === 'ready'
                      ? ` · ${getL2GitHeadLabel(selectedRepository.head)}`
                      : ''}
                  </p>
                  <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
                    {selectedRepository?.root || '.'}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={selectedRepository?.state !== 'ready' || operationPending}
                  onClick={() => openNewBranch(null)}
                >
                  <PlusIcon className="size-3.5" /> {t('createBranch')}
                </Button>
              </div>

              {workspace?.heads.status === 'error' ? (
                <p className="border-b bg-muted px-3 py-2 text-sm text-destructive">
                  {workspace.heads.error}
                </p>
              ) : null}
              {actionError ? (
                <p className="border-b bg-muted px-3 py-2 text-sm text-destructive">
                  {actionError}
                </p>
              ) : null}

              <div className="flex shrink-0 items-center gap-2 border-b p-2">
                {newBranchOpen ? (
                  <form
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      createBranch()
                    }}
                  >
                    <Input
                      autoFocus
                      value={newBranchName}
                      onChange={(event) => setNewBranchName(event.currentTarget.value)}
                      placeholder={t('newBranchName')}
                      aria-label={t('newBranchName')}
                      className="min-w-[12rem] flex-1"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!newBranchName.trim() || operationPending}
                    >
                      {operationPending ? (
                        <LoaderCircleIcon className="size-3.5 animate-spin" />
                      ) : null}
                      {t('createAndSwitch')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setNewBranchOpen(false)
                        setNewBranchStartPoint(null)
                      }}
                    >
                      {t('cancel')}
                    </Button>
                  </form>
                ) : (
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder={t('searchBranches')}
                    aria-label={t('searchBranches')}
                  />
                )}
              </div>

              <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
                {selectedRepository?.state === 'unavailable' ? (
                  <p className="p-5 text-center text-xs text-destructive">
                    {selectL4LocalizedText(selectedRepository.message, locale)}
                  </p>
                ) : branches?.status === 'loading' && !branchData ? (
                  <div className="flex min-h-24 items-center justify-center gap-2 text-xs text-muted-foreground">
                    <LoaderCircleIcon className="size-4 animate-spin" /> {t('loadingBranches')}
                  </div>
                ) : branches?.status === 'error' ? (
                  <div className="flex min-h-24 flex-col items-center justify-center gap-2 text-center text-xs text-destructive">
                    <p>{branches.error}</p>
                    {activeRepositoryRoot !== null ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void runtime.loadBranches(target.cwd, activeRepositoryRoot)}
                      >
                        {t('retry')}
                      </Button>
                    ) : null}
                  </div>
                ) : branchData ? (
                  <div className="space-y-3">
                    {recentBranches.length > 0 ? (
                      <section>
                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                          {t('recentlyUsed')}
                        </p>
                        {recentBranches.map((name) =>
                          renderBranchRow({ type: 'local', name }, 'recent')
                        )}
                      </section>
                    ) : null}
                    {localBranches.length > 0 ? (
                      <section>
                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                          {t('localBranches')}
                        </p>
                        {renderBranchTree(localBranchTree, 'local')}
                      </section>
                    ) : null}
                    {remoteBranches.length > 0 ? (
                      <section>
                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                          {t('remoteBranches')}
                        </p>
                        {renderBranchTree(remoteBranchTree, 'remote')}
                      </section>
                    ) : null}
                    {recentBranches.length === 0 &&
                    localBranches.length === 0 &&
                    remoteBranches.length === 0 ? (
                      <p className="p-5 text-center text-xs text-muted-foreground">
                        {t('noBranchMatches')}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
