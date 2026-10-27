'use client'

import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ChevronsUpDownIcon } from 'lucide-react'
import type { L4GitReadBranches } from '@common/l4_foundation/git/l4-git-history-contract'
import {
  buildL3GitBranchTree,
  type L3GitBranchTreeNode
} from '@client/l3_modules/project-files/l3-project-git-model'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { Popover, PopoverContent, PopoverTrigger } from '@client/l4_foundation/ui/shadcn/popover'

interface Props {
  branches: L4GitReadBranches | null
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  placeholder?: string
  className?: string
}

interface BranchRow {
  key: string
  label: string
  fullName: string
  parentKey: string | null
  level: number
  position: number
  siblingCount: number
  expandable: boolean
}

function branchAncestors(value: string): string[] {
  const result: string[] = []
  let parent = value
  while (parent.includes('/')) {
    parent = parent.slice(0, parent.lastIndexOf('/'))
    if (parent === 'refs') break
    result.push(parent)
  }
  return result
}

export function L2ProjectBranchSelect({
  branches,
  value,
  onChange,
  ariaLabel,
  placeholder,
  className
}: Props): React.JSX.Element {
  const { t } = useTranslation('projectHistory')
  const { t: common } = useTranslation('common')
  const treeId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState(value)
  const [expanded, setExpanded] = useState(
    () => new Set(['refs/heads', 'refs/remotes', ...branchAncestors(value)])
  )
  const search = query.trim().toLocaleLowerCase()
  const selectedLabel =
    value === 'HEAD' ? t('currentHead') : value.replace(/^refs\/(heads|remotes)\//, '')

  const rows = useMemo((): BranchRow[] => {
    const result: BranchRow[] = []
    const groups = [
      { key: 'refs/heads', label: t('localBranch'), names: branches?.local ?? [] },
      { key: 'refs/remotes', label: t('remoteBranch'), names: branches?.remote ?? [] }
    ]
      .map((group) => ({
        ...group,
        nodes: buildL3GitBranchTree(
          group.names.filter((name) => name.toLocaleLowerCase().includes(search))
        )
      }))
      .filter((group) => group.nodes.length > 0)
    const showHead = `HEAD ${t('currentHead')}`.toLocaleLowerCase().includes(search)
    const rootCount = groups.length + Number(showHead)
    if (showHead) {
      result.push({
        key: 'HEAD',
        label: t('currentHead'),
        fullName: t('currentHead'),
        parentKey: null,
        level: 1,
        position: 1,
        siblingCount: rootCount,
        expandable: false
      })
    }
    const append = (
      nodes: readonly L3GitBranchTreeNode[],
      prefix: string,
      parentKey: string,
      level: number
    ): void => {
      nodes.forEach((node, index) => {
        const key = `${prefix}/${node.path}`
        result.push({
          key,
          label: node.name,
          fullName: node.path,
          parentKey,
          level,
          position: index + 1,
          siblingCount: nodes.length,
          expandable: node.children.length > 0
        })
        if (expanded.has(key)) append(node.children, prefix, key, level + 1)
      })
    }
    groups.forEach((group, index) => {
      result.push({
        key: group.key,
        label: group.label,
        fullName: group.label,
        parentKey: null,
        level: 1,
        position: index + Number(showHead) + 1,
        siblingCount: rootCount,
        expandable: true
      })
      if (expanded.has(group.key)) append(group.nodes, group.key, group.key, 2)
    })
    return result
  }, [branches, expanded, search, t])

  const activeRow =
    rows.find((row) => row.key === activeKey) ??
    rows.find((row) => row.key === value) ??
    rows.find((row) => !row.expandable) ??
    rows[0]

  const changeOpen = (next: boolean): void => {
    if (next) {
      setQuery('')
      setActiveKey(value)
      setExpanded((previous) => new Set([...previous, ...branchAncestors(value)]))
    }
    setOpen(next)
  }

  const changeSearch = (text: string): void => {
    setQuery(text)
    setActiveKey('')
    const filter = text.trim().toLocaleLowerCase()
    if (!filter) return
    const keys = [
      ...(branches?.local ?? [])
        .filter((name) => name.toLocaleLowerCase().includes(filter))
        .map((name) => `refs/heads/${name}`),
      ...(branches?.remote ?? [])
        .filter((name) => name.toLocaleLowerCase().includes(filter))
        .map((name) => `refs/remotes/${name}`)
    ]
    setExpanded((previous) => new Set([...previous, ...keys.flatMap(branchAncestors)]))
  }

  const focusRow = (row: BranchRow | undefined): void => {
    if (!row) return
    setActiveKey(row.key)
    const element = rowRefs.current.get(row.key)
    element?.focus({ preventScroll: true })
    element?.scrollIntoView({ block: 'nearest' })
  }

  const toggle = (row: BranchRow): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(row.key)) next.delete(row.key)
      else next.add(row.key)
      return next
    })
  }

  const handleTreeKey = (event: KeyboardEvent<HTMLButtonElement>, row: BranchRow): void => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    const index = rows.indexOf(row)
    switch (event.key) {
      case 'ArrowDown':
        focusRow(rows[Math.min(index + 1, rows.length - 1)])
        break
      case 'ArrowUp':
        focusRow(rows[Math.max(index - 1, 0)])
        break
      case 'Home':
        focusRow(rows[0])
        break
      case 'End':
        focusRow(rows.at(-1))
        break
      case 'ArrowRight':
        if (row.expandable) {
          if (expanded.has(row.key)) focusRow(rows[index + 1])
          else toggle(row)
        }
        break
      case 'ArrowLeft':
        if (row.expandable && expanded.has(row.key)) toggle(row)
        else focusRow(rows.find((candidate) => candidate.key === row.parentKey))
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <Popover
      open={open}
      onOpenChange={changeOpen}
      onOpenChangeComplete={(next) => {
        if (next && document.activeElement === searchRef.current) {
          rowRefs.current.get(value)?.scrollIntoView({ block: 'nearest' })
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            role="combobox"
            aria-haspopup="dialog"
            aria-label={ariaLabel}
            aria-expanded={open}
            title={selectedLabel || placeholder}
            className={cn(
              'w-full min-w-0 justify-between border-input px-2.5 font-normal focus-visible:-outline-offset-2',
              className
            )}
          >
            <span className={cn('min-w-0 truncate', !value && 'text-muted-foreground')}>
              {selectedLabel || placeholder || common('selectPlaceholder')}
            </span>
            <ChevronsUpDownIcon className="text-muted-foreground" />
          </Button>
        }
      />
      <PopoverContent
        align="start"
        aria-label={ariaLabel}
        initialFocus={searchRef}
        finalFocus={triggerRef}
        positionerClassName="z-[120]"
        className="max-h-[min(30rem,var(--available-height))] w-[max(26rem,calc(var(--anchor-width)+8rem))] max-w-[min(calc(100vw-2rem),var(--available-width))] gap-0 overflow-hidden p-0"
      >
        <div className="shrink-0 border-b p-2">
          <Input
            ref={searchRef}
            type="search"
            aria-label={common('searchPlaceholder')}
            aria-controls={treeId}
            placeholder={common('searchPlaceholder')}
            value={query}
            onChange={(event) => changeSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey)
                return
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              event.stopPropagation()
              focusRow(event.key === 'ArrowDown' ? activeRow : rows.at(-1))
            }}
          />
        </div>
        <div
          id={treeId}
          role="tree"
          aria-label={ariaLabel}
          className="min-h-0 overflow-y-auto overscroll-contain p-1"
        >
          {rows.map((row) => {
            const selected = !row.expandable && row.key === value
            const expandedRow = row.expandable ? expanded.has(row.key) : undefined
            return (
              <button
                key={row.key}
                ref={(element) => {
                  if (element) rowRefs.current.set(row.key, element)
                  else rowRefs.current.delete(row.key)
                }}
                type="button"
                role="treeitem"
                aria-label={row.fullName}
                aria-level={row.level}
                aria-posinset={row.position}
                aria-setsize={row.siblingCount}
                aria-selected={row.expandable ? undefined : selected}
                aria-expanded={expandedRow}
                tabIndex={activeRow?.key === row.key ? 0 : -1}
                title={row.fullName}
                className={cn(
                  'flex min-h-8 w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(pointer:coarse)]:min-h-10',
                  selected && 'bg-accent text-accent-foreground',
                  row.level === 1 && row.expandable && 'font-medium text-muted-foreground'
                )}
                style={{ paddingLeft: 8 + Math.min(row.level - 1, 8) * 12 }}
                onFocus={() => setActiveKey(row.key)}
                onKeyDown={(event) => handleTreeKey(event, row)}
                onClick={() => {
                  setActiveKey(row.key)
                  if (row.expandable) toggle(row)
                  else {
                    onChange(row.key)
                    setOpen(false)
                  }
                }}
              >
                {row.expandable ? (
                  expandedRow ? (
                    <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  ) : (
                    <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  )
                ) : (
                  <span aria-hidden="true" className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 break-all">{row.label}</span>
                {selected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
              </button>
            )
          })}
        </div>
        {!rows.length ? (
          <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
            {common('noMatches')}
          </p>
        ) : null}
        {activeRow && activeRow.fullName !== activeRow.label ? (
          <div className="max-h-24 shrink-0 overflow-y-auto border-t px-3 py-2 text-xs break-all text-muted-foreground">
            {activeRow.fullName}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
