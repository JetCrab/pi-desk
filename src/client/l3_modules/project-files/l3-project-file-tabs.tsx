'use client'

import { ChevronDownIcon, ChevronUpIcon, FileCode2Icon, XIcon } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@client/l4_foundation/ui/shadcn/context-menu'
import type { L3FileTabCloseScope } from './l3-project-file-runtime'
import { L3FileContextMenuContent } from './l3-file-context-menu-content'

interface L3ProjectFileTabsProps {
  paths: readonly string[]
  activePath: string | null
  diffPath: string | null
  mobile: boolean
  onActivate: (path: string) => void
  onClose: (path: string | null, scope: L3FileTabCloseScope) => void
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
  paths,
  activePath,
  diffPath,
  mobile,
  onActivate,
  onClose
}: L3ProjectFileTabsProps): React.JSX.Element | null {
  const { t } = useTranslation('projectFiles')
  const rowsRef = useRef<HTMLDivElement>(null)
  const suppressTouchClickRef = useRef(false)
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const [clippedIndexes, setClippedIndexes] = useState<readonly number[]>([])
  const maxHeight = (mobile ? 2 : 3) * 36
  const tabs: { path: string | null; label: string; title: string }[] = paths.map((path) => ({
    path,
    label: fileLabel(path, paths),
    title: path
  }))
  if (diffPath)
    tabs.push({ path: null, label: `${fileLabel(diffPath, paths)} · Diff`, title: diffPath })
  const active = diffPath ? null : activePath

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
  }, [active, diffPath, maxHeight, paths])

  if (tabs.length === 0) return null
  return (
    <div className="shrink-0 border-b bg-muted" data-testid="file-tabs">
      <div className="overflow-hidden" style={{ maxHeight: expanded ? undefined : maxHeight }}>
        <div
          ref={rowsRef}
          role="tablist"
          aria-label={t('openFiles')}
          className="relative flex flex-wrap content-start items-start"
        >
          {tabs.map((tab, index) => {
            const clipped = !expanded && clippedIndexes.includes(index)
            const selected = tab.path === active
            const closeLabel =
              tab.path === null
                ? t('closeDiff', { name: tab.title.split('/').at(-1) })
                : t('closeFile', { name: tab.title.split('/').at(-1) })
            return (
              <ContextMenu
                key={tab.path ?? 'diff'}
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
                      data-testid={
                        tab.path === null ? `file-diff-tab-${tab.title}` : `file-tab-${tab.path}`
                      }
                      aria-hidden={clipped || undefined}
                      inert={clipped || undefined}
                      title={tab.title}
                      className={cn(
                        'flex h-9 max-w-full items-center border-r border-b text-sm',
                        mobile ? 'w-[min(50%,12rem)]' : 'max-w-60',
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
                    className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 pl-3 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => {
                      if (suppressTouchClickRef.current) {
                        suppressTouchClickRef.current = false
                        return
                      }
                      if (tab.path !== null) onActivate(tab.path)
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
                    <span className="truncate">{tab.label}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-testid={
                      tab.path === null
                        ? `file-diff-tab-close-${tab.title}`
                        : `file-tab-close-${tab.path}`
                    }
                    aria-label={closeLabel}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (suppressTouchClickRef.current) {
                        suppressTouchClickRef.current = false
                        return
                      }
                      onClose(tab.path, 'current')
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
                          onClose(tab.path, scope)
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
