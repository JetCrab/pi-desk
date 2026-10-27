'use client'

import { ChevronDownIcon, ChevronUpIcon, FileCode2Icon, XIcon } from 'lucide-react'
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
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
  const name = segments.at(-1) ?? path
  const sameName = paths.some((other) => other !== path && other.split('/').at(-1) === name)
  return sameName && segments.length > 1 ? segments.slice(-2).join('/') : name
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
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const [clippedIndexes, setClippedIndexes] = useState<readonly number[]>([])
  const merged = actions !== undefined
  const rowHeight = merged && !mobile ? 32 : 36
  const maxHeight = (mobile ? 2 : 3) * rowHeight
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
      const items = Array.from(rows.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement
      )
      const clipped = items.flatMap((item, index) => (item.offsetTop >= maxHeight ? [index] : []))
      setClippedIndexes((previous) =>
        previous.join(',') === clipped.join(',') ? previous : clipped
      )
      setOverflow(rows.scrollHeight > maxHeight)
      const selected = rows
        .querySelector<HTMLElement>('[aria-selected="true"]')
        ?.closest<HTMLElement>('[data-file-tab]')
      if (selected && selected.offsetTop >= maxHeight) setExpanded(true)
    }
    inspect()
    const observer = new ResizeObserver(inspect)
    observer.observe(rows)
    return () => observer.disconnect()
  }, [active, diffs, maxHeight, paths])

  if (tabs.length === 0) return null
  return (
    <div
      className={cn('shrink-0 bg-muted', merged ? 'flex flex-wrap items-start' : 'border-b')}
      data-testid="file-tabs"
    >
      <div
        className={cn('overflow-hidden', merged && 'min-w-0 flex-[1_1_12rem]')}
        style={{ maxHeight: expanded ? undefined : maxHeight }}
      >
        <div
          ref={rowsRef}
          role="tablist"
          aria-label={t('openFiles')}
          className="relative flex flex-wrap content-start items-start"
        >
          {tabs.map((tab, index) => {
            const clipped = !expanded && clippedIndexes.includes(index)
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
                      aria-hidden={clipped || undefined}
                      inert={clipped || undefined}
                      title={tab.title}
                      className={cn(
                        'flex max-w-full items-center text-sm',
                        merged ? (mobile ? 'h-9' : 'h-8') : 'h-9 border-r border-b',
                        mobile
                          ? tab.revisions
                            ? 'w-full'
                            : 'w-[min(50%,12rem)]'
                          : tab.revisions
                            ? 'max-w-80'
                            : 'max-w-60',
                        clipped && 'invisible',
                        selected
                          ? 'bg-background text-foreground shadow-[inset_0_-2px_0_var(--primary)]'
                          : 'text-muted-foreground'
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
                      setExpanded(true)
                      const buttons =
                        rowsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                      buttons?.[next]?.focus({ preventScroll: true })
                    }}
                  >
                    <FileCode2Icon className="size-3.5 shrink-0" />
                    <span className={cn('truncate', change && getL3GitChangeClass(change))}>
                      {tab.label}
                    </span>
                    {tab.revisions ? (
                      <span className="shrink-0 font-mono text-xs">{tab.revisions}</span>
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
      {merged && actions ? (
        <div
          className="ml-auto flex min-h-8 max-w-full flex-wrap items-center justify-end gap-1 px-1"
          role="group"
          aria-label={t('fileActions')}
        >
          {actions}
        </div>
      ) : null}
      {overflow ? (
        <Button
          variant="ghost"
          className="w-full rounded-none text-muted-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronUpIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
          {expanded ? t('collapseTabs') : t('expandTabs', { count: tabs.length })}
        </Button>
      ) : null}
    </div>
  )
}
