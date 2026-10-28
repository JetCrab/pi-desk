'use client'

import { ChevronRightIcon, LoaderCircleIcon, SearchIcon } from 'lucide-react'
import { useId, useState, type ReactElement, type ReactNode, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L4ProjectContentMatch,
  L4ProjectFileSearch,
  L4ProjectSearchInput,
  L4ProjectSearchRange
} from '@common/l4_foundation/file/l4-project-file-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { L4ScrollArea } from '@client/l4_foundation/ui/l4-scroll-area'
import { Button } from '@client/l4_foundation/ui/shadcn/button'

interface L3ProjectSearchResultsProps {
  search: L4ProjectSearchInput &
    L4ProjectFileSearch & {
      status: 'idle' | 'loading' | 'ready' | 'error'
      error: string | null
    }
  resultsRef: Ref<HTMLDivElement>
  activePath: string | null
  onOpen: (path: string, line?: number) => void
  wrapFile: (path: string, line: number | undefined, trigger: ReactElement) => ReactNode
  renderFileIcon: (path: string) => ReactNode
  fileDecoration: (path: string) => { className?: string; badge?: string }
}

function highlight(text: string, ranges: L4ProjectSearchRange[], offset = 0): ReactNode {
  const parts: ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    const start = Math.max(cursor, range.start - offset, 0)
    const end = Math.min(range.end - offset, text.length)
    if (end <= start) continue
    parts.push(text.slice(cursor, start))
    parts.push(
      <mark key={`${start}:${end}`} className="rounded-sm bg-foreground/15 text-inherit">
        {text.slice(start, end)}
      </mark>
    )
    cursor = end
  }
  parts.push(text.slice(cursor))
  return parts
}

export function L3ProjectSearchResults({
  search,
  resultsRef,
  activePath,
  onOpen,
  wrapFile,
  renderFileIcon,
  fileDecoration
}: L3ProjectSearchResultsProps): React.JSX.Element {
  const { t } = useTranslation('projectFiles')
  const id = useId()
  const [expandedFiles, setExpandedFiles] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<{ path: string; line: number } | null>(null)
  const groups = new Map<string, L4ProjectContentMatch[]>()
  for (const match of search.contentMatches) {
    const group = groups.get(match.path)
    if (group) group.push(match)
    else groups.set(match.path, [match])
  }
  const hasQuery = Boolean(search.query.trim())
  const ready = hasQuery && search.status === 'ready'
  const fileCount = search.fileMatches.length
  const lineCount = search.contentMatches.length
  const compact = search.scope === 'all' && fileCount > 3 && lineCount > 0 && !expandedFiles
  const files = compact ? search.fileMatches.slice(0, 3) : search.fileMatches
  const matchedFileCount = new Set([
    ...search.fileMatches.map((match) => match.path),
    ...groups.keys()
  ]).size
  const count = t('searchCounts', { files: matchedFileCount, lines: lineCount })
  const toggleGroup = (path: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex min-h-6 flex-wrap items-center justify-between gap-x-2 px-2 text-xs text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <span>{t('searchResults')}</span>
        {ready ? (
          <span className="tabular-nums">
            {search.truncated ? t('searchShownCounts', { counts: count }) : count}
          </span>
        ) : null}
      </div>
      <L4ScrollArea className="min-h-0 flex-1" viewportClassName="pb-2">
        <div
          ref={resultsRef}
          role="region"
          aria-label={t('searchResults')}
          aria-busy={hasQuery && search.status === 'loading'}
          onKeyDown={(event) => {
            if (
              event.key !== 'ArrowDown' &&
              event.key !== 'ArrowUp' &&
              event.key !== 'Home' &&
              event.key !== 'End'
            )
              return
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')
            ].filter((button) => !button.disabled && !button.closest('[hidden]'))
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (current < 0) return
            event.preventDefault()
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : Math.max(
                      0,
                      Math.min(buttons.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))
                    )
            buttons[next]?.focus()
          }}
        >
          {!hasQuery ? (
            <div className="px-5 py-9 text-center text-sm text-muted-foreground">
              <SearchIcon className="mx-auto mb-3 size-6" />
              <p>{t('searchStart')}</p>
              <p className="mt-2 text-xs">
                {t(
                  search.scope === 'files'
                    ? 'searchFiles'
                    : search.scope === 'content'
                      ? 'searchContent'
                      : 'searchAll'
                )}
              </p>
            </div>
          ) : search.status === 'loading' ? (
            <div className="flex min-h-10 items-center gap-2 px-3 text-xs text-muted-foreground">
              <LoaderCircleIcon className="size-3.5 animate-spin" />
              {t('searching')}
            </div>
          ) : search.status === 'error' ? (
            <p
              role="alert"
              className="mx-3 my-2 break-words rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {search.error || t('searchFailed')}
            </p>
          ) : ready && fileCount === 0 && lineCount === 0 ? (
            <div className="px-5 py-9 text-center text-sm text-muted-foreground">
              <SearchIcon className="mx-auto mb-3 size-6" />
              <p>{t(search.truncated ? 'resultLimit' : 'noMatches')}</p>
              <p className="mt-2 text-xs">{t('searchTryOptions')}</p>
            </div>
          ) : ready ? (
            <>
              {fileCount > 0 ? (
                <section>
                  {search.scope === 'all' ? (
                    <h3 className="flex min-h-6 items-center gap-2 px-2 text-xs text-muted-foreground">
                      {t('searchFileHeading')}
                      <span className="tabular-nums">{fileCount}</span>
                    </h3>
                  ) : null}
                  {files.map(({ path, ranges }) => {
                    const slash = path.lastIndexOf('/')
                    const decoration = fileDecoration(path)
                    return wrapFile(
                      path,
                      undefined,
                      <Button
                        key={path}
                        type="button"
                        variant="ghost"
                        data-testid={`project-search-result-${path}`}
                        data-search-result="true"
                        className={cn(
                          'mx-1 flex min-h-6 w-[calc(100%-0.5rem)] justify-start gap-1 px-1 py-0 text-left font-normal [@media(pointer:coarse)]:min-h-9',
                          activePath === path && 'bg-accent'
                        )}
                        title={path}
                        onClick={() => onOpen(path)}
                      >
                        <span className="shrink-0">{renderFileIcon(path)}</span>
                        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                          <span className={cn('truncate text-sm', decoration.className)}>
                            {highlight(path.slice(slash + 1), ranges, slash + 1)}
                          </span>
                          {slash >= 0 ? (
                            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                              {highlight(path.slice(0, slash), ranges)}
                            </span>
                          ) : null}
                        </span>
                        {decoration.badge ? (
                          <span
                            className={cn('text-xs', decoration.className)}
                            aria-label={t('gitStatus', { status: decoration.badge })}
                          >
                            {decoration.badge}
                          </span>
                        ) : null}
                      </Button>
                    )
                  })}
                  {compact ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-5 min-h-6 py-0 text-xs text-muted-foreground [@media(pointer:coarse)]:min-h-9"
                      onClick={() => setExpandedFiles(true)}
                    >
                      {t('searchExpandFiles', { count: fileCount - 3 })}
                    </Button>
                  ) : null}
                </section>
              ) : null}
              {lineCount > 0 ? (
                <section className={cn(fileCount > 0 && 'mt-1')}>
                  {search.scope === 'all' ? (
                    <h3 className="flex min-h-6 flex-wrap items-center gap-x-2 px-2 text-xs text-muted-foreground">
                      {t('searchContentHeading')}
                      <span>
                        {t('searchContentCounts', { lines: lineCount, files: groups.size })}
                      </span>
                    </h3>
                  ) : null}
                  {[...groups].map(([path, matches], index) => {
                    const slash = path.lastIndexOf('/')
                    const expanded = !collapsed.has(path)
                    const groupId = `${id}-${index}`
                    return (
                      <section key={path} className="mb-1">
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-6 w-full justify-start gap-1 rounded-none px-2 py-0 text-left font-normal [@media(pointer:coarse)]:min-h-9"
                          title={path}
                          aria-expanded={expanded}
                          aria-controls={groupId}
                          onClick={() => toggleGroup(path)}
                          onKeyDown={(event) => {
                            if (
                              (event.key === 'ArrowLeft' && expanded) ||
                              (event.key === 'ArrowRight' && !expanded)
                            ) {
                              event.preventDefault()
                              toggleGroup(path)
                            }
                          }}
                        >
                          <ChevronRightIcon
                            className={cn(
                              'size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                              expanded && 'rotate-90'
                            )}
                          />
                          <span className="shrink-0">{renderFileIcon(path)}</span>
                          <span className="min-w-0 truncate text-sm">
                            {path.slice(slash + 1)}
                            <span className="ml-1.5 text-xs text-muted-foreground">
                              {path.slice(0, Math.max(0, slash))}
                            </span>
                          </span>
                          <span className="ml-auto shrink-0 rounded bg-muted px-1 text-xs text-muted-foreground tabular-nums">
                            {matches.length}
                          </span>
                        </Button>
                        <div id={groupId} hidden={!expanded}>
                          {matches.map(({ line, text, ranges }) =>
                            wrapFile(
                              path,
                              line,
                              <Button
                                key={`${path}:${line}`}
                                type="button"
                                variant="ghost"
                                data-testid={`project-search-line-${path}-${line}`}
                                data-search-result="true"
                                className={cn(
                                  'min-h-6 w-full justify-start gap-1 rounded-none border-l-2 border-transparent py-0 pr-2 pl-5 text-left font-mono font-normal [@media(pointer:coarse)]:min-h-9',
                                  selected?.path === path &&
                                    selected.line === line &&
                                    'border-l-foreground/50 bg-accent'
                                )}
                                title={text}
                                aria-label={t('searchOpenLine', { path, line })}
                                onClick={() => {
                                  setSelected({ path, line })
                                  onOpen(path, line)
                                }}
                              >
                                <span className="min-w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                                  {line}
                                </span>
                                <span className="min-w-0 truncate whitespace-pre text-sm">
                                  {highlight(text, ranges)}
                                </span>
                              </Button>
                            )
                          )}
                        </div>
                      </section>
                    )
                  })}
                </section>
              ) : null}
              {search.truncated ? (
                <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">
                  {t('resultLimit')}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </L4ScrollArea>
      {search.scope !== 'files' ? (
        <p className="shrink-0 px-2 py-1 text-xs leading-5 text-muted-foreground">
          {t('searchTextLimit')}
        </p>
      ) : null}
    </div>
  )
}
