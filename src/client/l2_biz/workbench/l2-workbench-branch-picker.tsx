'use client'

import {
  ChevronDownIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  SearchIcon,
  XIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { motion, useIsPresent, useReducedMotion } from 'motion/react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type {
  L2WorkSessionTreeEntryGetResponse,
  L2WorkSessionTreeGetResponse,
  L2WorkSessionTreeNode,
  L2WorkSessionTreeNodeKind
} from '@common/l2_biz/work-session/l2-work-session-tree-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { Button, buttonVariants } from '@client/l4_foundation/ui/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@client/l4_foundation/ui/shadcn/dropdown-menu'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import {
  buildL2WorkbenchBranchTreeRows,
  findNearestL2WorkbenchBranchTreeEntryId,
  type L2WorkbenchBranchTreeFilter
} from './l2-workbench-branch-tree'
import type { L2WorkbenchBranchIntent } from './hooks/l2-workbench-branch-picker'

export interface L2WorkbenchBranchPickerModel {
  workId: string
  tree: L2WorkSessionTreeGetResponse | null
  loading: boolean
  actionsDisabled: boolean
  pending: boolean
  error: string | null
  detail: L2WorkSessionTreeEntryGetResponse | null
  detailLoading: boolean
  detailError: string | null
  runningConfirmation: {
    intent: L2WorkbenchBranchIntent
    reason: 'main' | 'background'
    waiting: boolean
  } | null
}

interface L2WorkbenchBranchPickerProps {
  model: L2WorkbenchBranchPickerModel
  projectName: string
  sessionTitle: string | null
  mobile: boolean
  onClose: () => void
  onRetry: () => void
  onSelectEntry: (entryId: string) => void
  onAction: (entryId: string, action: 'tree' | 'fork') => void
  onConfirmRunning: () => void
  onCancelRunning: () => void
}

interface KindAppearance {
  label: string
  labelClassName: string
  contentClassName: string
  rowClassName: string
}

const EMPTY_TREE_NODES: readonly L2WorkSessionTreeNode[] = []
const OVERSCAN_ROWS = 8

const FILTER_OPTIONS: ReadonlyArray<{
  value: L2WorkbenchBranchTreeFilter
  label: string
}> = [
  { value: 'default', label: 'filterDefault' },
  { value: 'no-tools', label: 'filterNoTools' },
  { value: 'user-only', label: 'filterUserOnly' },
  { value: 'labeled-only', label: 'filterLabeled' },
  { value: 'all', label: 'filterAll' }
]

const KIND_APPEARANCE: Record<L2WorkSessionTreeNodeKind, KindAppearance> = {
  user: {
    label: 'kindUser',
    labelClassName: 'font-semibold text-primary',
    contentClassName: 'font-medium text-foreground',
    rowClassName: ''
  },
  assistant: {
    label: 'AI',
    labelClassName: 'font-medium text-muted-foreground',
    contentClassName: 'text-foreground',
    rowClassName: ''
  },
  tool: {
    label: 'kindTool',
    labelClassName: 'text-muted-foreground',
    contentClassName: 'text-muted-foreground',
    rowClassName: 'text-muted-foreground'
  },
  bash: {
    label: 'Bash',
    labelClassName: 'text-muted-foreground',
    contentClassName: 'text-muted-foreground',
    rowClassName: 'text-muted-foreground'
  },
  custom_message: {
    label: 'kindMessage',
    labelClassName: 'text-muted-foreground',
    contentClassName: 'text-foreground',
    rowClassName: ''
  },
  compaction: {
    label: 'kindCompaction',
    labelClassName: 'font-medium text-muted-foreground',
    contentClassName: 'text-muted-foreground',
    rowClassName: 'bg-primary/[0.025]'
  },
  branch_summary: {
    label: 'kindBranchSummary',
    labelClassName: 'font-medium text-foreground',
    contentClassName: 'text-muted-foreground',
    rowClassName: 'bg-amber-500/[0.025]'
  },
  custom: {
    label: 'kindCustom',
    labelClassName: 'text-muted-foreground',
    contentClassName: 'text-muted-foreground',
    rowClassName: ''
  },
  model_change: {
    label: 'kindModel',
    labelClassName: 'text-muted-foreground',
    contentClassName: 'text-muted-foreground',
    rowClassName: ''
  },
  thinking_level_change: {
    label: 'kindThinking',
    labelClassName: 'text-muted-foreground',
    contentClassName: 'text-muted-foreground',
    rowClassName: ''
  },
  session_info: {
    label: 'kindSession',
    labelClassName: 'text-muted-foreground',
    contentClassName: 'text-muted-foreground',
    rowClassName: ''
  },
  label: {
    label: 'kindLabel',
    labelClassName: 'text-muted-foreground',
    contentClassName: 'text-muted-foreground',
    rowClassName: ''
  }
}

function intentLabel(intent: L2WorkbenchBranchIntent): string {
  switch (intent.action) {
    case 'tree':
      return 'treeIntent'
    case 'fork':
      return 'forkIntent'
    case 'clone':
      return 'cloneIntent'
  }
}

function preventMouseFocus(event: ReactMouseEvent<HTMLElement>): void {
  event.preventDefault()
}

function RunningConfirmation({
  confirmation,
  disabled,
  onConfirm,
  onBack
}: {
  confirmation: NonNullable<L2WorkbenchBranchPickerModel['runningConfirmation']>
  disabled: boolean
  onConfirm: () => void
  onBack: () => void
}): React.JSX.Element {
  const { t } = useTranslation('workbenchPicker')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const buttonRefs = useRef(new Map<number, HTMLButtonElement>())

  useEffect(() => {
    buttonRefs.current.get(0)?.focus()
  }, [])

  const choose = (index: number): void => {
    if (confirmation.waiting || (disabled && index === 0)) return
    if (index === 0) onConfirm()
    else onBack()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onBack()
      return
    }
    if (
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown' ||
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight'
    ) {
      event.preventDefault()
      const next = selectedIndex === 0 ? 1 : 0
      setSelectedIndex(next)
      queueMicrotask(() => buttonRefs.current.get(next)?.focus())
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(selectedIndex)
    }
  }

  return (
    <div className="p-3 sm:p-4" onKeyDown={handleKeyDown}>
      <div className="rounded-lg border bg-muted/25 px-3 py-2.5">
        <p className="text-sm font-semibold">{t('runningTitle')}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {confirmation.reason === 'main'
            ? t('runningStop', { action: t(intentLabel(confirmation.intent)) })
            : t('runningWait', { action: t(intentLabel(confirmation.intent)) })}
        </p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {[
          { label: confirmation.waiting ? t('confirming') : t('confirmContinue'), confirm: true },
          { label: t('back'), confirm: false }
        ].map((option, index) => (
          <button
            key={option.label}
            ref={(element) => {
              if (element) buttonRefs.current.set(index, element)
              else buttonRefs.current.delete(index)
            }}
            type="button"
            disabled={confirmation.waiting || (disabled && option.confirm)}
            tabIndex={selectedIndex === index ? 0 : -1}
            className={cn(
              'flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60',
              selectedIndex === index
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border bg-background hover:bg-muted/60'
            )}
            onFocus={() => setSelectedIndex(index)}
            onClick={() => choose(index)}
          >
            {confirmation.waiting && option.confirm ? (
              <LoaderCircleIcon className="size-4 animate-spin" />
            ) : null}
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">{t('confirmHint')}</p>
    </div>
  )
}

export function L2WorkbenchBranchPicker({
  model,
  projectName,
  sessionTitle,
  mobile,
  onClose,
  onRetry,
  onSelectEntry,
  onAction,
  onConfirmRunning,
  onCancelRunning
}: L2WorkbenchBranchPickerProps): React.JSX.Element {
  const { t } = useTranslation('workbenchPicker')
  const present = useIsPresent()
  const reducedMotion = useReducedMotion()
  const { locale, timeZone } = useL4Region()
  const timestampFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
        timeZone,
        timeZoneName: 'shortOffset',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      }),
    [locale, timeZone]
  )
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<L2WorkbenchBranchTreeFilter>('default')
  const [filterOpen, setFilterOpen] = useState(false)
  const [foldedEntryIds, setFoldedEntryIds] = useState<Set<string>>(() => new Set())
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const restorePreviousFocusRef = useRef(false)
  const nodes = model.tree?.nodes ?? EMPTY_TREE_NODES
  const rows = useMemo(
    () =>
      buildL2WorkbenchBranchTreeRows({
        nodes,
        leafEntryId: model.tree?.leafEntryId ?? null,
        filter,
        query,
        foldedEntryIds
      }),
    [filter, foldedEntryIds, model.tree?.leafEntryId, nodes, query]
  )
  const effectiveSelectedEntryId = findNearestL2WorkbenchBranchTreeEntryId(
    nodes,
    rows,
    selectedEntryId ?? model.tree?.leafEntryId ?? null
  )
  const selectedIndex = rows.findIndex((row) => row.node.entryId === effectiveSelectedEntryId)
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex]! : null
  const rowHeight = 36
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS)
  const endIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN_ROWS
  )
  const renderEndIndex = Math.min(rows.length, Math.max(endIndex, startIndex + OVERSCAN_ROWS))
  const visibleRows = rows.slice(startIndex, renderEndIndex)
  const selectedDetail = model.detail?.entryId === effectiveSelectedEntryId ? model.detail : null
  const filterLabel = t(
    FILTER_OPTIONS.find((option) => option.value === filter)?.label ?? 'filterDefault'
  )
  const confirmation = model.runningConfirmation
  const treeId = `work-session-branch-tree-${model.workId}`
  const selectedRowId = effectiveSelectedEntryId
    ? `${treeId}-entry-${effectiveSelectedEntryId}`
    : undefined

  const focusPickerInput = useCallback((): void => {
    if (mobile) panelRef.current?.focus({ preventScroll: true })
    else searchRef.current?.focus({ preventScroll: true })
  }, [mobile])

  const requestClose = useCallback(
    (restorePreviousFocus: boolean): void => {
      if (model.pending) return
      restorePreviousFocusRef.current = restorePreviousFocus
      onClose()
    },
    [model.pending, onClose]
  )

  useEffect(() => {
    if (!present) return
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    restorePreviousFocusRef.current = false
    queueMicrotask(focusPickerInput)
    return () => {
      if (!restorePreviousFocusRef.current) return
      previousFocusRef.current?.focus({ preventScroll: true })
    }
  }, [focusPickerInput, present])

  useEffect(() => {
    if (!present || confirmation) return
    queueMicrotask(focusPickerInput)
  }, [confirmation, focusPickerInput, present])

  useEffect(() => {
    if (!present) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (model.pending) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (
        target instanceof Element &&
        target.closest('[data-workbench-branch-picker-popup="true"]')
      ) {
        return
      }
      requestClose(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [model.pending, present, requestClose])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const observer = new ResizeObserver(([entry]) => {
      setViewportHeight(entry?.contentRect.height ?? 0)
    })
    observer.observe(list)
    return () => observer.disconnect()
  }, [confirmation])

  useEffect(() => {
    if (!present || !effectiveSelectedEntryId || confirmation) return
    onSelectEntry(effectiveSelectedEntryId)
    const list = listRef.current
    if (!list || selectedIndex < 0) return
    const top = selectedIndex * rowHeight
    const bottom = top + rowHeight
    let nextScrollTop = list.scrollTop
    if (top < list.scrollTop) nextScrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) {
      nextScrollTop = bottom - list.clientHeight
    }
    if (nextScrollTop !== list.scrollTop) list.scrollTop = nextScrollTop
    queueMicrotask(() => setScrollTop(nextScrollTop))
  }, [confirmation, effectiveSelectedEntryId, onSelectEntry, present, rowHeight, selectedIndex])

  const scrollListTo = useCallback((nextScrollTop: number): void => {
    if (listRef.current) listRef.current.scrollTop = nextScrollTop
    setScrollTop(nextScrollTop)
  }, [])

  const selectIndex = useCallback(
    (nextIndex: number): void => {
      if (rows.length === 0) return
      const clamped = Math.max(0, Math.min(rows.length - 1, nextIndex))
      const entryId = rows[clamped]!.node.entryId
      setSelectedEntryId(entryId)
      const list = listRef.current
      if (!list) return
      const top = clamped * rowHeight
      const bottom = top + rowHeight
      let nextScrollTop = list.scrollTop
      if (top < list.scrollTop) nextScrollTop = top
      else if (bottom > list.scrollTop + list.clientHeight) {
        nextScrollTop = bottom - list.clientHeight
      }
      scrollListTo(nextScrollTop)
    },
    [rowHeight, rows, scrollListTo]
  )

  const toggleFold = useCallback((entryId: string, folded?: boolean): void => {
    setFoldedEntryIds((current) => {
      const next = new Set(current)
      const shouldFold = folded ?? !next.has(entryId)
      if (shouldFold) next.add(entryId)
      else next.delete(entryId)
      return next
    })
  }, [])

  const applyFilter = useCallback(
    (nextFilter: L2WorkbenchBranchTreeFilter): void => {
      setFilter(nextFilter)
      setFoldedEntryIds(new Set())
      scrollListTo(0)
      queueMicrotask(focusPickerInput)
    },
    [focusPickerInput, scrollListTo]
  )

  const cycleFilter = useCallback(
    (direction: 1 | -1): void => {
      const currentIndex = FILTER_OPTIONS.findIndex((option) => option.value === filter)
      const nextIndex = (currentIndex + direction + FILTER_OPTIONS.length) % FILTER_OPTIONS.length
      applyFilter(FILTER_OPTIONS[nextIndex]!.value)
    },
    [applyFilter, filter]
  )

  const performAction = useCallback(
    (entryId: string, action: 'tree' | 'fork'): void => {
      if (model.actionsDisabled) return
      restorePreviousFocusRef.current = false
      onAction(entryId, action)
    },
    [model.actionsDisabled, onAction]
  )

  const performTree = useCallback((): void => {
    if (!selectedRow || selectedRow.current || model.pending) return
    performAction(selectedRow.node.entryId, 'tree')
  }, [model.pending, performAction, selectedRow])

  const selectParent = useCallback((): void => {
    if (!selectedRow?.visibleParentEntryId) return
    const parentIndex = rows.findIndex(
      (candidate) => candidate.node.entryId === selectedRow.visibleParentEntryId
    )
    if (parentIndex >= 0) selectIndex(parentIndex)
  }, [rows, selectIndex, selectedRow])

  const selectFirstChild = useCallback((): void => {
    if (!selectedRow) return
    const childIndex = rows.findIndex(
      (candidate) => candidate.visibleParentEntryId === selectedRow.node.entryId
    )
    if (childIndex >= 0) selectIndex(childIndex)
  }, [rows, selectIndex, selectedRow])

  const handleEscape = useCallback((): void => {
    if (confirmation) onCancelRunning()
    else if (query) {
      setQuery('')
      setFoldedEntryIds(new Set())
      scrollListTo(0)
    } else requestClose(true)
  }, [confirmation, onCancelRunning, query, requestClose, scrollListTo])

  useEffect(() => {
    if (!mobile || !present) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        panelRef.current?.closest('[inert]')
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      handleEscape()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleEscape, mobile, present])

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    event.stopPropagation()
    switch (event.key) {
      case 'Tab':
        event.preventDefault()
        cycleFilter(event.shiftKey ? -1 : 1)
        return
      case 'ArrowUp':
        event.preventDefault()
        selectIndex(selectedIndex - 1)
        return
      case 'ArrowDown':
        event.preventDefault()
        selectIndex(selectedIndex + 1)
        return
      case 'PageUp':
        event.preventDefault()
        selectIndex(selectedIndex - Math.max(1, Math.floor(viewportHeight / rowHeight)))
        return
      case 'PageDown':
        event.preventDefault()
        selectIndex(selectedIndex + Math.max(1, Math.floor(viewportHeight / rowHeight)))
        return
      case 'ArrowLeft':
        if (query || !selectedRow) return
        event.preventDefault()
        if (selectedRow.foldable && selectedRow.expanded) {
          toggleFold(selectedRow.node.entryId, true)
        } else selectParent()
        return
      case 'ArrowRight':
        if (query || !selectedRow) return
        event.preventDefault()
        if (selectedRow.foldable && !selectedRow.expanded) {
          toggleFold(selectedRow.node.entryId, false)
        } else selectFirstChild()
        return
      case 'Enter':
        event.preventDefault()
        performTree()
        return
      case 'Escape':
        event.preventDefault()
        handleEscape()
        return
    }
  }

  const selectRow = (entryId: string): void => {
    setSelectedEntryId(entryId)
    queueMicrotask(focusPickerInput)
  }

  const detailNode = selectedRow?.node ?? null
  const detailAppearance = detailNode ? KIND_APPEARANCE[detailNode.kind] : null
  const panelClass = confirmation
    ? mobile
      ? 'inset-x-0 bottom-0 rounded-t-2xl border-x-0 border-b-0'
      : 'inset-x-2 bottom-2 h-auto max-h-[calc(100%-4rem)] rounded-xl'
    : mobile
      ? 'inset-x-0 bottom-0 top-14 rounded-t-2xl border-x-0 border-b-0'
      : 'inset-x-2 bottom-2 h-[min(82%,48rem)] rounded-xl'

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-30"
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.15, ease: 'easeOut' }}
    >
      <div
        aria-hidden="true"
        data-carousel-swipe-lock
        className={cn(
          'absolute inset-x-0 bottom-0 top-14 z-30 bg-background/65',
          present ? 'pointer-events-auto' : 'pointer-events-none'
        )}
      />
      <motion.section
        ref={panelRef}
        initial={{ y: reducedMotion ? 0 : 12 }}
        animate={{ y: 0 }}
        exit={{ y: reducedMotion ? 0 : 8 }}
        transition={{ duration: reducedMotion ? 0 : 0.2, ease: 'easeOut' }}
        tabIndex={-1}
        data-carousel-swipe-lock
        role="region"
        aria-label={t('branchPicker')}
        aria-busy={model.pending || model.loading}
        className={cn(
          'absolute z-40 flex min-h-0 flex-col overflow-hidden border bg-popover text-popover-foreground shadow-lg outline-none',
          present ? 'pointer-events-auto' : 'pointer-events-none',
          panelClass
        )}
      >
        <header className="shrink-0 border-b bg-muted/10">
          <div className="flex min-h-10 items-center gap-2 px-2.5">
            <h2
              className="min-w-0 flex-1 truncate text-sm font-semibold"
              title={`${projectName} · ${sessionTitle ?? t('newSession')}`}
            >
              {t('branchTitle')}
            </h2>
            {!confirmation ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {selectedIndex >= 0 ? selectedIndex + 1 : 0} / {rows.length}
              </span>
            ) : null}
            <button
              type="button"
              disabled={model.pending}
              aria-label={t('closeBranchPicker')}
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              onClick={() => requestClose(true)}
            >
              <XIcon className="size-4" />
            </button>
          </div>
          {!confirmation ? (
            <div className="flex items-center gap-1.5 border-t border-border/60 px-2 py-1.5">
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchRef}
                  role="combobox"
                  value={query}
                  aria-label={t('branchSearch')}
                  aria-controls={treeId}
                  aria-expanded="true"
                  aria-activedescendant={selectedRowId}
                  placeholder={t('branchSearchPlaceholder')}
                  className="pl-7"
                  onChange={(event) => {
                    setQuery(event.currentTarget.value)
                    setFoldedEntryIds(new Set())
                    scrollListTo(0)
                  }}
                  onKeyDown={handleSearchKeyDown}
                />
              </div>
              <DropdownMenu
                open={filterOpen}
                onOpenChange={setFilterOpen}
                onOpenChangeComplete={(open) => {
                  if (!open) queueMicrotask(focusPickerInput)
                }}
              >
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t('branchFilter', { filter: filterLabel })}
                      className={buttonVariants({ variant: 'outline' })}
                    />
                  }
                >
                  {filterLabel}
                  <ChevronDownIcon className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  data-workbench-branch-picker-popup="true"
                  align="end"
                  side="bottom"
                  className="w-32"
                  finalFocus={() => (mobile ? panelRef.current : searchRef.current)}
                >
                  {FILTER_OPTIONS.map((option) => (
                    <DropdownMenuItem key={option.value} onClick={() => applyFilter(option.value)}>
                      <span className="min-w-0 flex-1">{t(option.label)}</span>
                      {filter === option.value ? (
                        <span className="text-xs text-primary">●</span>
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </header>

        {model.error ? (
          <div
            role="alert"
            className="shrink-0 border-b bg-muted px-3 py-2 text-sm text-destructive"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">{model.error}</span>
              {!model.pending && !model.tree ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={model.actionsDisabled}
                  onClick={onRetry}
                >
                  {t('retry')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {confirmation ? (
          <RunningConfirmation
            key={`${confirmation.intent.action}:${'entryId' in confirmation.intent ? confirmation.intent.entryId : ''}`}
            confirmation={confirmation}
            disabled={model.actionsDisabled}
            onConfirm={onConfirmRunning}
            onBack={() => {
              restorePreviousFocusRef.current = true
              onCancelRunning()
            }}
          />
        ) : (
          <>
            <div className="pi-desk-chat-scrollbar h-36 shrink-0 overflow-y-auto border-b bg-muted px-3 py-3">
              {detailNode && detailAppearance ? (
                <>
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className={detailAppearance.labelClassName}>
                      {t(detailAppearance.label)}
                    </span>
                    {detailNode.label ? (
                      <span className="min-w-0 truncate rounded-sm bg-amber-500/10 px-1 text-amber-700 dark:text-amber-300">
                        {detailNode.label}
                      </span>
                    ) : null}
                    <time className="ml-auto shrink-0">
                      {timestampFormatter.format(detailNode.timestampMs)}
                    </time>
                  </div>
                  <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
                    {model.detailLoading || !selectedDetail ? (
                      model.detailError ? (
                        <span className="text-destructive">{model.detailError}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          <LoaderCircleIcon className="size-3.5 animate-spin" />
                          {t('loadingEntry')}
                        </span>
                      )
                    ) : (
                      <>
                        {selectedDetail.content || t('entryEmpty')}
                        {selectedDetail.truncated ? (
                          <span className="mt-1 block text-muted-foreground">
                            {t('entryTruncated')}
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="grid min-h-12 place-items-center text-xs text-muted-foreground">
                  {t('selectEntry')}
                </div>
              )}
            </div>

            {model.pending && !model.runningConfirmation ? (
              <div className="flex shrink-0 items-center gap-2 border-b bg-primary/8 px-2.5 py-1.5 text-xs text-muted-foreground">
                <LoaderCircleIcon className="size-3.5 animate-spin text-primary" />
                {t('branchWorking')}
              </div>
            ) : null}

            {model.loading && !model.tree ? (
              <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <LoaderCircleIcon className="size-4 animate-spin" />
                  {t('branchLoading')}
                </div>
              </div>
            ) : rows.length === 0 ? (
              <div className="grid min-h-0 flex-1 place-items-center px-4 text-center text-sm text-muted-foreground">
                {nodes.length === 0 ? t('branchEmpty') : t('branchNoMatches')}
              </div>
            ) : (
              <div
                ref={listRef}
                id={treeId}
                role="tree"
                aria-label={t('branchTree')}
                className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto px-1 py-1"
                onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              >
                <div style={{ height: `${startIndex * rowHeight}px` }} aria-hidden="true" />
                {visibleRows.map((row) => {
                  const selected = row.node.entryId === effectiveSelectedEntryId
                  const guideDepth = Math.min(row.depth, 10)
                  const appearance = KIND_APPEARANCE[row.node.kind]
                  return (
                    <div
                      key={row.node.entryId}
                      id={`${treeId}-entry-${row.node.entryId}`}
                      role="treeitem"
                      aria-level={row.depth + 1}
                      aria-selected={selected}
                      aria-expanded={row.foldable ? row.expanded : undefined}
                      className={cn(
                        'group relative flex min-w-0 items-center rounded-md outline-none transition-colors',
                        appearance.rowClassName,
                        selected
                          ? 'bg-accent text-accent-foreground'
                          : row.current
                            ? 'bg-primary/[0.055] hover:bg-primary/[0.08]'
                            : 'hover:bg-muted/50'
                      )}
                      style={{ height: `${rowHeight}px`, paddingLeft: `${guideDepth * 10}px` }}
                    >
                      {guideDepth > 0 ? (
                        <span
                          aria-hidden="true"
                          className={cn(
                            'pointer-events-none absolute bottom-0 top-0 w-px',
                            row.active ? 'bg-primary/25' : 'bg-border/60'
                          )}
                          style={{ left: `${guideDepth * 10 - 5}px` }}
                        />
                      ) : null}
                      {row.connector ? (
                        <span
                          aria-hidden="true"
                          className={cn(
                            'pointer-events-none absolute h-px w-2',
                            row.active ? 'bg-primary/25' : 'bg-border/60'
                          )}
                          style={{ left: `${guideDepth * 10 - 5}px` }}
                        />
                      ) : null}
                      <div className="flex w-6 shrink-0 items-center justify-center">
                        {row.foldable ? (
                          <button
                            type="button"
                            aria-label={t(row.expanded ? 'collapseBranch' : 'expandBranch')}
                            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/8 hover:text-foreground"
                            onMouseDown={preventMouseFocus}
                            onClick={() => {
                              toggleFold(row.node.entryId)
                              queueMicrotask(focusPickerInput)
                            }}
                          >
                            <ChevronRightIcon
                              className={cn(
                                'size-3 transition-transform',
                                row.expanded && 'rotate-90'
                              )}
                            />
                          </button>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        tabIndex={-1}
                        className="flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left outline-none"
                        onMouseDown={preventMouseFocus}
                        onClick={() => selectRow(row.node.entryId)}
                        onDoubleClick={() => {
                          if (!mobile && !row.current) performAction(row.node.entryId, 'tree')
                        }}
                      >
                        <span className={cn('w-9 shrink-0 text-xs', appearance.labelClassName)}>
                          {t(appearance.label)}
                        </span>
                        {row.node.label ? (
                          <span className="max-w-24 shrink-0 truncate rounded-md bg-muted px-1 text-xs text-foreground">
                            {row.node.label}
                          </span>
                        ) : null}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-sm',
                            appearance.contentClassName,
                            selected && 'font-semibold text-accent-foreground'
                          )}
                        >
                          {row.node.preview || t('noPreview')}
                        </span>
                      </button>
                      {mobile ? (
                        <div className="ml-2 flex shrink-0 items-center gap-1 border-l border-border/55 py-0.5 pl-1.5 pr-1">
                          <button
                            type="button"
                            disabled={model.actionsDisabled || row.current || model.pending}
                            aria-label={t('switchToMessage', { kind: t(appearance.label) })}
                            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                            onClick={() => performAction(row.node.entryId, 'tree')}
                          >
                            {t('switch')}
                          </button>
                          {row.node.kind === 'user' ? (
                            <button
                              type="button"
                              disabled={model.actionsDisabled || model.pending}
                              aria-label={t('forkFromUser')}
                              className={buttonVariants({ variant: 'outline', size: 'sm' })}
                              onClick={() => performAction(row.node.entryId, 'fork')}
                            >
                              Fork
                            </button>
                          ) : null}
                        </div>
                      ) : row.node.kind === 'user' ? (
                        <div className="ml-2 flex shrink-0 items-center border-l border-border/50 pl-2 pr-1">
                          <button
                            type="button"
                            disabled={model.actionsDisabled || model.pending}
                            aria-label={t('forkFromUser')}
                            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                            onMouseDown={preventMouseFocus}
                            onClick={() => performAction(row.node.entryId, 'fork')}
                          >
                            Fork
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
                <div
                  style={{ height: `${Math.max(0, rows.length - renderEndIndex) * rowHeight}px` }}
                  aria-hidden="true"
                />
              </div>
            )}

            <footer className="flex min-h-9 shrink-0 items-center gap-2 border-t bg-muted/10 px-2">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {selectedIndex >= 0 ? selectedIndex + 1 : 0} / {rows.length}
                {!mobile ? ` · ${t('branchShortcuts')}` : ''}
              </span>
              {!mobile ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    model.actionsDisabled ||
                    !selectedRow ||
                    selectedRow.current ||
                    model.loading ||
                    model.pending
                  }
                  onMouseDown={preventMouseFocus}
                  onClick={performTree}
                >
                  {t('switch')}
                </Button>
              ) : null}
            </footer>
          </>
        )}
      </motion.section>
    </motion.div>
  )
}
