'use client'
import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftIcon, CopyIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react'
import type { L4GitRepository } from '@common/l4_foundation/git/l4-git-contract'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L4ScrollArea } from '@client/l4_foundation/ui/l4-scroll-area'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { L4SearchSelect } from '@client/l4_foundation/ui/l4-search-select'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle
} from '@client/l4_foundation/ui/shadcn/resizable'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import type { L2ProjectHistoryState } from '../runtime/l2-project-history-runtime'
import { L2ProjectHistoryList } from './l2-project-history-list'
import { L2ProjectChangeTree } from './l2-project-change-tree'
import type { L3PathTreeRow } from '@client/l3_modules/project-files/l3-project-path-tree'
import type { L3ProjectRevealTargetType } from '@common/l3_modules/project-files/l3-project-files-contract'

interface Props {
  state: L2ProjectHistoryState
  cwd: string
  changeRows: readonly L3PathTreeRow[]
  onSelectChange: (path: string) => void
  onToggleDirectory: (path: string) => void
  onReveal: (path: string, type: L3ProjectRevealTargetType) => Promise<void>
  repositories: readonly L4GitRepository[]
  projectName: string
  narrow: boolean
  mobilePane: 'log' | 'files'
  onMobilePane: (pane: 'log' | 'files') => void
  scroll: Readonly<{ log: number; changes: number }>
  onScroll: (pane: 'log' | 'changes', value: number) => void
  panelSizes: Readonly<{ log: number; changes: number }>
  onPanelSize: (panel: 'log' | 'changes', value: number) => void
  onRepository: (root: string) => void
  onMode: (mode: 'history' | 'compare') => void
  onRevision: (field: 'tip' | 'base' | 'target', value: string) => void
  onStrategy: (strategy: 'merge-base' | 'direct') => void
  onQuery: (query: string) => void
  onAuthor: (author: string) => void
  onCommit: (oid: string, parent?: string) => void
  onAggregate: () => void
  onMoreLog: () => void
  onMoreChanges: () => void
  onOpenFile: (path: string) => void
  onRefresh: () => void
  onCopy: (text: string) => void
}
export function L2ProjectHistoryView(props: Props): React.JSX.Element {
  const { state, repositories, projectName, narrow, scroll } = props
  const { t } = useTranslation('projectHistory')
  const { locale, timeZone } = useL4Region()
  const time = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
        timeZone,
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }),
    [locale, timeZone]
  )
  const fullTime = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
        timeZone,
        timeZoneName: 'shortOffset',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }),
    [locale, timeZone]
  )
  const authorListId = useId()
  const { mobilePane, onMobilePane: setMobilePane } = props
  const data = state.changes.data
  const context = `${state.repositoryRoot}:${data?.comparison.original}:${data?.comparison.target}`
  const selectedPath = state.selectedChangePath
  const refs = [
    { value: 'HEAD', label: t('currentHead') },
    ...(state.branches.data?.local ?? []).map((name) => ({
      value: `refs/heads/${name}`,
      label: name,
      description: t('localBranch')
    })),
    ...(state.branches.data?.remote ?? []).map((name) => ({
      value: `refs/remotes/${name}`,
      label: name,
      description: t('remoteBranch')
    }))
  ]
  const upstream = state.branches.data?.upstream
  const commit = data?.commit
  const chooseCommit = (oid: string): void => {
    props.onCommit(oid)
    if (narrow) setMobilePane('files')
  }
  const feedback = (error: string | null): React.JSX.Element | null =>
    error ? (
      <div role="alert" className="flex flex-wrap items-center gap-2 p-3 text-sm text-destructive">
        <span className="min-w-0 flex-1 break-words">{error}</span>
        <Button size="sm" variant="outline" onClick={props.onRefresh}>
          {t('retry')}
        </Button>
        {state.mode === 'compare' && state.strategy === 'merge-base' ? (
          <Button size="sm" variant="outline" onClick={() => props.onStrategy('direct')}>
            {t('compareDirect')}
          </Button>
        ) : null}
      </div>
    ) : null

  const log = (
    <div className="flex size-full min-h-0 min-w-0 flex-col">
      {feedback(state.log.error)}
      {state.log.status === 'loading' ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
          {t('loadingCommits')}
        </div>
      ) : null}
      <L2ProjectHistoryList
        key={`${state.repositoryRoot}:${state.mode}:${state.tip}:${state.base}:${state.target}:${state.query}:${state.author}`}
        items={state.log.data?.items ?? []}
        label={t('commitList')}
        scrollTop={scroll.log}
        onScroll={(value) => props.onScroll('log', value)}
        render={(item) => (
          <button
            key={item.oid}
            type="button"
            role="option"
            aria-selected={state.selectedCommit === item.oid}
            className={cn(
              'flex h-9 w-full items-center gap-3 border-b border-border/40 px-3 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              state.selectedCommit === item.oid && 'bg-accent'
            )}
            onClick={() => chooseCommit(item.oid)}
            title={`${item.subject}\n${item.oid}\n${item.author} · ${fullTime.format(item.timestampMs)}`}
          >
            <span className="min-w-0 flex-1 truncate">
              {item.subject || t('noCommitMessage')}
              {item.refs.length ? (
                <span className="ml-2 text-xs text-muted-foreground">{item.refs.join(' · ')}</span>
              ) : null}
            </span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {item.oid.slice(0, 7)}
            </span>
            {!narrow ? (
              <>
                <span className="w-20 truncate text-xs text-muted-foreground">{item.author}</span>
                <time className="w-28 shrink-0 text-right text-xs text-muted-foreground">
                  {time.format(item.timestampMs)}
                </time>
              </>
            ) : null}
          </button>
        )}
      />
      {state.log.status === 'ready' && !state.log.data?.items.length ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          {state.query || state.author ? t('noMatchingCommits') : t('noCommits')}
        </p>
      ) : null}
      {state.log.data?.truncated ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t('scanLimit')}</p>
      ) : null}
      {(state.log.data?.items.length ?? 0) >= 2000 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t('loadedLimit')}</p>
      ) : state.log.data?.hasMore ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={state.log.status === 'loading'}
          onClick={props.onMoreLog}
        >
          {t('loadMoreCommits')}
        </Button>
      ) : null}
    </div>
  )

  const files = (
    <div className="flex size-full min-h-0 min-w-0 flex-col">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1">
        {narrow ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('backCommits')}
            onClick={() => setMobilePane('log')}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
        ) : null}
        <span className="text-sm font-medium">
          {state.selectedCommit ? t('commitChanges') : t('cumulativeChanges')}
        </span>
        {data ? (
          <span className="text-xs text-muted-foreground">
            {t('loadedFiles', { count: data.items.length })}
          </span>
        ) : null}
        {state.mode === 'compare' && state.selectedCommit ? (
          <Button variant="ghost" size="sm" onClick={props.onAggregate}>
            {t('backCumulative')}
          </Button>
        ) : null}
      </div>
      {feedback(state.changes.error)}
      {state.changes.status === 'loading' ? (
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
          {t('loadingChanges')}
        </div>
      ) : null}
      <ResizablePanelGroup
        orientation="vertical"
        defaultLayout={{
          'project-changes': props.panelSizes.changes,
          'project-detail': 100 - props.panelSizes.changes
        }}
        onLayoutChanged={(layout, meta) => {
          if (meta.isUserInteraction && layout['project-changes'] !== undefined)
            props.onPanelSize('changes', layout['project-changes'])
        }}
      >
        <ResizablePanel
          id="project-changes"
          defaultSize={`${props.panelSizes.changes}%`}
          minSize="80px"
        >
          <div className="flex size-full min-h-0 flex-col">
            <L2ProjectChangeTree
              key={context}
              cwd={props.cwd}
              repositoryRoot={state.repositoryRoot ?? ''}
              rows={props.changeRows}
              changes={data?.items ?? []}
              selectedPath={selectedPath}
              scrollTop={scroll.changes}
              onScroll={(value) => props.onScroll('changes', value)}
              onSelect={props.onSelectChange}
              onToggle={props.onToggleDirectory}
              onOpen={props.onOpenFile}
              onReveal={props.onReveal}
            />
            {state.changes.status === 'ready' && !data?.items.length ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">{t('noDiff')}</p>
            ) : null}
            {data?.hasMore ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={state.changes.status === 'loading'}
                onClick={props.onMoreChanges}
              >
                {t('loadMoreFiles')}
              </Button>
            ) : null}
            {data?.truncated ? (
              <p className="p-3 text-xs text-muted-foreground">{t('changesLimit')}</p>
            ) : null}
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel
          id="project-detail"
          defaultSize={`${100 - props.panelSizes.changes}%`}
          minSize="60px"
        >
          <L4ScrollArea
            className="h-full"
            viewportClassName="p-3 text-sm"
            role="region"
            aria-label={t('commitDetails')}
          >
            {commit ? (
              <>
                <pre className="mb-3 whitespace-pre-wrap break-words font-sans leading-relaxed">
                  {commit.message}
                </pre>
                <div className="mb-2 flex items-center gap-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-xs">{commit.oid}</span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('copySha')}
                    onClick={() => props.onCopy(commit.oid)}
                  >
                    <CopyIcon className="size-4" />
                  </Button>
                </div>
                <p className="mb-3 text-xs text-muted-foreground">
                  {commit.author} · {fullTime.format(commit.timestampMs)}
                </p>
                {commit.parents.length > 1 ? (
                  <L4SearchSelect
                    className="mb-3"
                    ariaLabel={t('compareParent')}
                    value={commit.selectedParent ?? ''}
                    options={commit.parents.map((oid, index) => ({
                      value: oid,
                      label: t('parentCommit', { count: index + 1, oid: oid.slice(0, 10) })
                    }))}
                    onChange={(parent) => props.onCommit(commit.oid, parent)}
                  />
                ) : null}
              </>
            ) : data ? (
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>
                  {state.strategy === 'merge-base' ? t('mergeBaseToTarget') : t('baseToTarget')}
                </p>
                <p className="break-all font-mono">
                  {data.comparison.original ?? t('emptyRevision')}
                </p>
                <p className="break-all font-mono">{data.comparison.target}</p>
              </div>
            ) : (
              <p className="text-muted-foreground">{t('selectCommit')}</p>
            )}
            {selectedPath ? (
              <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
                {selectedPath}
              </p>
            ) : null}
          </L4ScrollArea>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )

  return (
    <section
      className="flex size-full min-h-0 min-w-0 flex-col"
      aria-label={t('historyAndCompare')}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="flex gap-1" role="group" aria-label={t('viewMode')}>
          <Button
            size="sm"
            variant={state.mode === 'history' ? 'secondary' : 'ghost'}
            aria-pressed={state.mode === 'history'}
            onClick={() => {
              props.onMode('history')
              setMobilePane('log')
            }}
          >
            {t('historyMode')}
          </Button>
          <Button
            size="sm"
            variant={state.mode === 'compare' ? 'secondary' : 'ghost'}
            aria-pressed={state.mode === 'compare'}
            onClick={() => {
              props.onMode('compare')
              setMobilePane('log')
            }}
          >
            {t('compareMode')}
          </Button>
        </div>
        <L4SearchSelect
          className="w-44"
          ariaLabel={t('selectRepository')}
          value={state.repositoryRoot ?? ''}
          options={repositories.map((repository) => ({
            value: repository.root,
            label: repository.root || projectName,
            description:
              repository.state === 'unavailable'
                ? selectL4LocalizedText(repository.message, locale)
                : undefined
          }))}
          onChange={props.onRepository}
        />
        {state.mode === 'history' ? (
          <L4SearchSelect
            className="w-48"
            ariaLabel={t('viewBranch')}
            value={state.tip}
            options={refs}
            onChange={(value) => props.onRevision('tip', value)}
          />
        ) : (
          <>
            <L4SearchSelect
              className="w-44"
              ariaLabel={t('baseBranch')}
              placeholder={t('chooseBase')}
              value={state.base}
              options={refs}
              onChange={(value) => props.onRevision('base', value)}
            />
            <span className="text-xs text-muted-foreground">→</span>
            <L4SearchSelect
              className="w-44"
              ariaLabel={t('targetBranch')}
              value={state.target}
              options={refs}
              onChange={(value) => props.onRevision('target', value)}
            />
            <L4SearchSelect
              className="w-48"
              ariaLabel={t('comparison')}
              value={state.strategy}
              options={[
                { value: 'merge-base', label: t('introducedChanges') },
                { value: 'direct', label: t('directComparison') }
              ]}
              onChange={(value) => props.onStrategy(value === 'direct' ? 'direct' : 'merge-base')}
            />
            {narrow ? (
              <Button size="sm" variant="outline" onClick={() => setMobilePane('files')}>
                {t('cumulativeChanges')}
              </Button>
            ) : null}
          </>
        )}
        <Input
          className="w-40 shrink-0"
          aria-label={t('filterAuthor')}
          placeholder={t('author')}
          list={authorListId}
          value={state.author}
          onChange={(event) => props.onAuthor(event.target.value)}
        />
        <datalist id={authorListId}>
          {state.authorSuggestions.map((author) => (
            <option key={author} value={author} />
          ))}
        </datalist>
        <Input
          className="min-w-32 flex-1 basis-40"
          aria-label={t('searchCommits')}
          placeholder={t('searchCommits')}
          value={state.query}
          onChange={(event) => props.onQuery(event.target.value)}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('refreshGit')}
          onClick={props.onRefresh}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
      </div>
      {state.branches.error ? feedback(state.branches.error) : null}
      {upstream ? (
        <p
          className="shrink-0 truncate border-b px-3 py-1 text-xs text-muted-foreground"
          title={upstream.ref}
        >
          {upstream.ref.replace('refs/remotes/', '')} · {t('localRecord')} ·{' '}
          {upstream.ahead === null || upstream.behind === null
            ? t('refUnavailable')
            : t('aheadBehind', { ahead: upstream.ahead, behind: upstream.behind })}
        </p>
      ) : null}
      {state.mode === 'compare' && !state.base ? (
        <p className="p-4 text-sm text-muted-foreground">{t('chooseBaseBranch')}</p>
      ) : narrow ? (
        mobilePane === 'log' ? (
          log
        ) : (
          files
        )
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={{
            'project-log': props.panelSizes.log,
            'project-files': 100 - props.panelSizes.log
          }}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction && layout['project-log'] !== undefined)
              props.onPanelSize('log', layout['project-log'])
          }}
        >
          <ResizablePanel id="project-log" defaultSize={`${props.panelSizes.log}%`} minSize="30%">
            {log}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel
            id="project-files"
            defaultSize={`${100 - props.panelSizes.log}%`}
            minSize="25%"
          >
            {files}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </section>
  )
}
