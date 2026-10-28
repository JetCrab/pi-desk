'use client'

import { XIcon } from 'lucide-react'
import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L4FileIcon } from '@client/l4_foundation/ui/file-icons/l4-file-icon'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@client/l4_foundation/ui/shadcn/context-menu'
import {
  getL3FileDiffKey,
  type L3FileDiffTarget,
  type L3FileTabTarget,
  type L3FileTabCloseScope
} from './l3-project-file-runtime'
import { L3FileContextMenuContent } from './l3-file-context-menu-content'
import type { L3ProjectGitBrowser } from './l3-project-git-runtime'
import { findL3GitFile, getL3GitChangeBadge, getL3GitChangeClass } from './l3-project-git-model'

interface L3ProjectFileTabsProps {
  cwd: string
  gitRuntime: L3ProjectGitBrowser
  paths: readonly string[]
  activePath: string | null
  diffs: readonly L3FileDiffTarget[]
  activeDiff: L3FileDiffTarget | null
  mobile: boolean
  actions?: ReactNode
  onActivate: (target: L3FileTabTarget) => void
  onClose: (target: L3FileTabTarget | null, scope: L3FileTabCloseScope) => void
}

const CLOSE_ACTIONS: readonly { scope: L3FileTabCloseScope; label: string }[] = [
  { scope: 'current', label: 'closeTab' },
  { scope: 'others', label: 'closeOtherTabs' },
  { scope: 'right', label: 'closeRightTabs' },
  { scope: 'left', label: 'closeLeftTabs' },
  { scope: 'all', label: 'closeAllTabs' }
]

function fileLabel(path: string, paths: readonly string[]): string {
  const segments = path.replaceAll('\\', '/').split('/')
  const others = paths
    .map((other) => other.replaceAll('\\', '/'))
    .filter((other) => other !== segments.join('/'))
  for (let length = 1; length < segments.length; length++) {
    const label = segments.slice(-length).join('/')
    if (!others.some((other) => other.split('/').slice(-length).join('/') === label)) return label
  }
  return segments.join('/')
}

function revealTab(rows: HTMLDivElement, tab: HTMLElement): void {
  const left = tab.offsetLeft
  const right = left + tab.offsetWidth
  if (left < rows.scrollLeft) rows.scrollLeft = left
  else if (right > rows.scrollLeft + rows.clientWidth) rows.scrollLeft = right - rows.clientWidth
}

export function L3ProjectFileTabs({
  cwd,
  gitRuntime,
  paths,
  activePath,
  diffs,
  activeDiff,
  mobile,
  actions,
  onActivate,
  onClose
}: L3ProjectFileTabsProps): React.JSX.Element | null {
  const { t } = useTranslation('projectFiles')
  useSyncExternalStore(gitRuntime.subscribe, gitRuntime.getRevision, gitRuntime.getRevision)
  const snapshot = gitRuntime.getWorkspace(cwd)?.snapshot
  const rowsRef = useRef<HTMLDivElement>(null)
  const suppressTouchClickRef = useRef(false)
  const allPaths = [
    ...paths,
    ...diffs.map((diff) => [diff.repositoryRoot, diff.path].filter(Boolean).join('/'))
  ]
  const tabs: {
    target: L3FileTabTarget
    key: string
    path: string
    label: string
    revisions?: string
    title: string
    testId: string
  }[] = paths.map((path) => ({
    target: path,
    key: `file:${path}`,
    path,
    label: fileLabel(path, allPaths),
    title: path,
    testId: `file-tab-${path}`
  }))
  for (const diff of diffs) {
    const path = [diff.repositoryRoot, diff.path].filter(Boolean).join('/')
    const comparison = diff.comparison
    const revisions = comparison
      ? `${comparison.baseCommit?.slice(0, 7) ?? '∅'} → ${comparison.targetCommit.slice(0, 7)}`
      : ''
    const key = getL3FileDiffKey(diff)
    tabs.push({
      target: diff,
      key: `diff:${key}`,
      path,
      label: `${fileLabel(path, allPaths)} · Diff`,
      revisions,
      title: [
        path,
        comparison?.oldPath,
        comparison ? `${comparison.baseCommit ?? '∅'} → ${comparison.targetCommit}` : null
      ]
        .filter(Boolean)
        .join('\n'),
      testId: `file-diff-tab-${path}${comparison ? `-${key}` : ''}`
    })
  }
  const active = activeDiff ? `diff:${getL3FileDiffKey(activeDiff)}` : `file:${activePath}`

  useLayoutEffect(() => {
    const rows = rowsRef.current
    if (!rows) return
    const inspect = (): void => {
      const selected = rows
        .querySelector<HTMLElement>('[aria-selected="true"]')
        ?.closest<HTMLElement>('[data-file-tab]')
      if (selected) revealTab(rows, selected)
    }
    inspect()
    const observer = new ResizeObserver(inspect)
    observer.observe(rows)
    return () => observer.disconnect()
  }, [active, diffs, paths])

  if (tabs.length === 0) return null
  return (
    <div
      className="flex min-w-0 max-w-full shrink-0 flex-col border-b bg-muted"
      data-testid="file-tabs"
    >
      <div className="min-w-0 max-w-full">
        <div
          ref={rowsRef}
          role="tablist"
          aria-label={t('openFiles')}
          aria-orientation="horizontal"
          className="relative flex min-w-0 flex-nowrap items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]"
        >
          {tabs.map((tab, index) => {
            const selected = tab.key === active
            const isDiff = typeof tab.target !== 'string'
            const change =
              !isDiff && snapshot?.status === 'ready'
                ? findL3GitFile(cwd, tab.path, snapshot.repositories)?.change
                : undefined
            const closeLabel = isDiff
              ? t('closeDiff', {
                  name: `${tab.path.split('/').at(-1)}${tab.revisions ? ` · ${tab.revisions}` : ''}`
                })
              : t('closeFile', { name: tab.path.split('/').at(-1) })
            return (
              <ContextMenu
                key={tab.key}
                onOpenChange={(open, details) => {
                  if (
                    open &&
                    'pointerType' in details.event &&
                    details.event.pointerType === 'touch'
                  )
                    suppressTouchClickRef.current = true
                }}
              >
                <ContextMenuTrigger
                  render={
                    <div
                      data-file-tab
                      data-testid={tab.testId}
                      title={tab.title}
                      className={cn(
                        'flex shrink-0 items-center border-r text-sm transition-colors',
                        mobile ? 'h-9' : 'h-8',
                        tab.revisions ? 'max-w-[min(100%,20rem)]' : 'max-w-[min(100%,15rem)]',
                        selected
                          ? 'bg-background text-foreground shadow-[inset_0_-2px_0_var(--foreground)]'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                      )}
                      onPointerDown={(event) => {
                        if (event.pointerType === 'touch') suppressTouchClickRef.current = false
                      }}
                    />
                  }
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 pl-3 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    onFocus={(event) => {
                      const tab = event.currentTarget.closest<HTMLElement>('[data-file-tab]')
                      if (rowsRef.current && tab) revealTab(rowsRef.current, tab)
                    }}
                    onClick={() => {
                      if (suppressTouchClickRef.current) {
                        suppressTouchClickRef.current = false
                        return
                      }
                      onActivate(tab.target)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'F10' && event.shiftKey) {
                        event.preventDefault()
                        event.stopPropagation()
                        const trigger = event.currentTarget.closest<HTMLElement>(
                          '[data-slot="context-menu-trigger"]'
                        )
                        if (trigger) {
                          const rect = trigger.getBoundingClientRect()
                          trigger.dispatchEvent(
                            new MouseEvent('contextmenu', {
                              bubbles: true,
                              cancelable: true,
                              clientX: rect.left + rect.width / 2,
                              clientY: rect.top + rect.height / 2
                            })
                          )
                        }
                        return
                      }
                      const direction =
                        event.key === 'ArrowRight' || event.key === 'ArrowDown'
                          ? 1
                          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                            ? -1
                            : 0
                      if (!direction) return
                      event.preventDefault()
                      const next = (index + direction + tabs.length) % tabs.length
                      const buttons =
                        rowsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                      buttons?.[next]?.focus({ preventScroll: true })
                    }}
                  >
                    <L4FileIcon path={tab.path} className="size-4 shrink-0" />
                    <span className={cn('truncate', change && getL3GitChangeClass(change))}>
                      {tab.label}
                    </span>
                    {tab.revisions ? (
                      <span className="max-w-36 truncate font-mono text-xs">{tab.revisions}</span>
                    ) : null}
                    {change ? (
                      <span
                        className={cn('shrink-0 text-xs', getL3GitChangeClass(change))}
                        aria-label={t('gitStatus', { status: getL3GitChangeBadge(change) })}
                      >
                        {getL3GitChangeBadge(change)}
                      </span>
                    ) : null}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn('shrink-0 rounded-none', mobile && 'size-9')}
                    data-testid={
                      isDiff
                        ? tab.testId.replace('file-diff-tab-', 'file-diff-tab-close-')
                        : `file-tab-close-${tab.path}`
                    }
                    aria-label={closeLabel}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (suppressTouchClickRef.current) {
                        suppressTouchClickRef.current = false
                        return
                      }
                      onClose(tab.target, 'current')
                    }}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </ContextMenuTrigger>
                <L3FileContextMenuContent>
                  {CLOSE_ACTIONS.map(({ scope, label }) => (
                    <span key={scope}>
                      {scope === 'all' ? <ContextMenuSeparator /> : null}
                      <ContextMenuItem
                        disabled={
                          scope === 'others'
                            ? tabs.length <= 1
                            : scope === 'left'
                              ? index === 0
                              : scope === 'right'
                                ? index === tabs.length - 1
                                : false
                        }
                        onClick={() => {
                          suppressTouchClickRef.current = false
                          onClose(tab.target, scope)
                        }}
                      >
                        {t(label)}
                      </ContextMenuItem>
                    </span>
                  ))}
                </L3FileContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      </div>
      {actions ? (
        <div
          className={cn(
            'flex min-h-9 min-w-0 max-w-full flex-wrap items-center justify-end gap-1 overflow-x-auto border-t bg-background p-1 [&>*]:min-w-0 [&>*]:max-w-full [&>span]:break-all [&>[role=group]]:flex-wrap',
            mobile && '[&_button]:min-h-9 [&_button]:min-w-9'
          )}
          role="group"
          aria-label={t('fileActions')}
        >
          {actions}
        </div>
      ) : null}
    </div>
  )
}
