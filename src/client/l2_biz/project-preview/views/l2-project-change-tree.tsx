'use client'

import { ChevronRightIcon, Columns2Icon, FolderIcon, FolderOpenIcon } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { L4GitChanges } from '@common/l4_foundation/git/l4-git-history-contract'
import type { L3ProjectRevealTargetType } from '@common/l3_modules/project-files/l3-project-files-contract'
import { L3ProjectPathMenu } from '@client/l3_modules/project-files/l3-project-path-menu'
import {
  joinL3ProjectPath,
  type L3PathTreeRow
} from '@client/l3_modules/project-files/l3-project-path-tree'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L2ProjectHistoryList } from './l2-project-history-list'

const statuses = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  'type-changed': 'T'
} as const
interface Props {
  cwd: string
  repositoryRoot: string
  rows: readonly L3PathTreeRow[]
  changes: L4GitChanges['items']
  selectedPath: string | null
  scrollTop: number
  onScroll: (value: number) => void
  onSelect: (path: string) => void
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  onReveal: (path: string, type: L3ProjectRevealTargetType) => Promise<void>
}

export function L2ProjectChangeTree({
  cwd,
  repositoryRoot,
  rows,
  changes,
  selectedPath,
  scrollTop,
  onScroll,
  onSelect,
  onToggle,
  onOpen,
  onReveal
}: Props): React.JSX.Element {
  const { t } = useTranslation('projectHistory')
  const changesByPath = new Map(changes.map((change) => [change.path, change]))
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return
    const element =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tree-key]') : null
    // 行内差异按钮保留自己的 Enter 行为；菜单 Portal 不属于树的键盘域。
    if (event.target instanceof Element && event.target.closest('button')) return
    const index = element ? rows.findIndex((row) => row.key === element.dataset.treeKey) : -1
    const row = rows[index]
    let next = index
    if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else if (event.key === 'ArrowRight' && row?.directory) {
      if (!row.expanded) onToggle(row.directory.path)
      else next = Math.min(rows.length - 1, index + 1)
    } else if (event.key === 'ArrowLeft' && row) {
      if (row.expanded && row.directory) onToggle(row.directory.path)
      else
        for (let parent = index - 1; parent >= 0; parent -= 1) {
          if (rows[parent]!.depth < row.depth) {
            next = parent
            break
          }
        }
    } else if ((event.key === 'Enter' || event.key === ' ') && row) {
      if (row.directory) onToggle(row.directory.path)
      else if (event.key === 'Enter') onOpen(row.path)
      else onSelect(row.path)
    } else return
    event.preventDefault()
    const target = rows[next]
    if (!target) return
    const viewport = event.currentTarget
    if (next * 36 < viewport.scrollTop) viewport.scrollTop = next * 36
    else if ((next + 1) * 36 > viewport.scrollTop + viewport.clientHeight)
      viewport.scrollTop = (next + 1) * 36 - viewport.clientHeight
    requestAnimationFrame(() => {
      ;[...viewport.querySelectorAll<HTMLElement>('[data-tree-key]')]
        .find((item) => item.dataset.treeKey === target.key)
        ?.focus()
    })
  }

  return (
    <L2ProjectHistoryList
      role="tree"
      label={t('changeFiles')}
      items={rows}
      scrollTop={scrollTop}
      onScroll={onScroll}
      onKeyDown={keyDown}
      render={(row) => {
        const change = changesByPath.get(row.path)
        const projectPath = joinL3ProjectPath(repositoryRoot, row.path)
        const directory = row.directory
        return (
          <L3ProjectPathMenu
            key={row.key}
            cwd={cwd}
            path={projectPath}
            type={row.type}
            historical
            expanded={row.expanded}
            onToggle={directory ? () => onToggle(directory.path) : undefined}
            onOpen={row.type === 'file' ? () => onOpen(row.path) : undefined}
            openLabel={t('viewDiff')}
            oldPath={
              row.type === 'file' && change?.oldPath
                ? joinL3ProjectPath(repositoryRoot, change.oldPath)
                : undefined
            }
            onReveal={onReveal}
            trigger={
              <div
                role="treeitem"
                tabIndex={0}
                aria-level={row.depth + 1}
                aria-expanded={row.expanded}
                aria-selected={row.type === 'file' && selectedPath === row.path}
                data-tree-key={row.key}
                className={cn(
                  'flex h-9 min-w-0 cursor-pointer items-center gap-2 pr-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  row.type === 'file' && selectedPath === row.path && 'bg-accent'
                )}
                style={{ paddingLeft: 8 + row.depth * 16 }}
                title={
                  change?.oldPath && row.type === 'file'
                    ? `${joinL3ProjectPath(repositoryRoot, change.oldPath)} → ${projectPath}`
                    : projectPath
                }
                onClick={(event) => {
                  if (directory) {
                    if (event.detail < 2) onToggle(directory.path)
                  } else onSelect(row.path)
                }}
                onDoubleClick={() => {
                  if (row.type === 'file') onOpen(row.path)
                }}
              >
                {directory ? (
                  <>
                    <ChevronRightIcon
                      className={cn(
                        'size-4 shrink-0 text-muted-foreground',
                        row.expanded && 'rotate-90'
                      )}
                    />
                    {row.expanded ? (
                      <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                  </>
                ) : (
                  <>
                    <span className="w-4 shrink-0" />
                    <span
                      className={cn(
                        'w-4 shrink-0 font-mono text-xs',
                        change?.status === 'added'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : change?.status === 'deleted'
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-blue-600 dark:text-blue-400'
                      )}
                      aria-label={t('gitStatus', { status: change ? statuses[change.status] : '' })}
                    >
                      {change ? statuses[change.status] : ''}
                    </span>
                  </>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {row.label}
                  {row.type === 'directory' && changesByPath.has(row.path) ? '/' : ''}
                </span>
                {row.type === 'file' ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('viewDiffPath', { path: row.path })}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpen(row.path)
                    }}
                  >
                    <Columns2Icon className="size-4" />
                  </Button>
                ) : null}
              </div>
            }
          />
        )
      }}
    />
  )
}
