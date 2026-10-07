'use client'

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircleIcon } from 'lucide-react'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import {
  getL2WorkbenchSlashCommandOptionId,
  L2_WORKBENCH_SLASH_COMMAND_MENU_ID,
  type L2WorkbenchSlashCommandGroup
} from './l2-workbench-slash-command'

const GROUP_LABEL_KEYS: Record<L2WorkbenchSlashCommandGroup['source'], string> = {
  builtin: 'slashGroupBuiltin',
  skill: 'slashGroupSkill',
  prompt: 'slashGroupPrompt',
  extension: 'slashGroupExtension'
}

interface L2WorkbenchSlashCommandMenuProps {
  open: boolean
  loading: boolean
  error: string | null
  groups: readonly L2WorkbenchSlashCommandGroup[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (index: number) => void
}

export function L2WorkbenchSlashCommandMenu({
  open,
  loading,
  error,
  groups,
  activeIndex,
  onActiveIndexChange,
  onSelect
}: L2WorkbenchSlashCommandMenuProps): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const activeOptionRef = useRef<HTMLDivElement | null>(null)
  const commandCount = groups.reduce((total, group) => total + group.commands.length, 0)

  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  let optionIndex = 0
  const hasCommands = commandCount > 0
  const status = loading ? t('slashLoadingMore') : error ? t('slashMoreFailed') : null

  return (
    <div
      id={L2_WORKBENCH_SLASH_COMMAND_MENU_ID}
      role="listbox"
      aria-label={t('slashCandidates')}
      aria-busy={loading}
      className="absolute bottom-full left-[-1px] z-20 mb-2 flex w-[calc(100%+2px)] origin-bottom-left flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-100"
    >
      <div className="pi-desk-chat-scrollbar max-h-72 overflow-x-hidden overflow-y-auto overscroll-contain p-1 scroll-py-8 max-sm:max-h-[40dvh]">
        {groups.map((group, groupIndex) => (
          <section
            key={group.source}
            role="group"
            aria-label={t(GROUP_LABEL_KEYS[group.source])}
            className={cn(groupIndex > 0 && 'mt-1 border-t pt-1')}
          >
            <div className="sticky -top-1 z-10 flex h-7 items-center gap-2 bg-popover px-2 text-xs font-medium text-muted-foreground">
              <span className="size-1.5 rounded-full bg-muted-foreground" />
              <span>{t(GROUP_LABEL_KEYS[group.source])}</span>
              <span className="ml-auto font-normal tabular-nums opacity-70">
                {group.commands.length}
              </span>
            </div>
            {group.commands.map((command) => {
              const index = optionIndex++
              const active = index === activeIndex
              return (
                <div
                  key={command.key}
                  id={getL2WorkbenchSlashCommandOptionId(index)}
                  ref={active ? activeOptionRef : undefined}
                  role="option"
                  aria-selected={active}
                  data-active={active ? 'true' : 'false'}
                  className="grid min-h-9 cursor-pointer grid-cols-[minmax(6.75rem,0.9fr)_minmax(0,1.2fr)_0.75rem] items-center gap-2 rounded-md px-2 py-1 text-sm outline-none select-none data-[active=true]:bg-accent sm:grid-cols-[minmax(7rem,0.8fr)_minmax(0,1.5fr)_1rem]"
                  onPointerMove={(event) => {
                    if (event.pointerType === 'mouse') onActiveIndexChange(index)
                  }}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(index)}
                >
                  <span className="min-w-0 truncate font-mono text-sm font-medium">
                    <span className="text-primary">/</span>
                    {command.name}
                  </span>
                  <span className="min-w-0 truncate text-sm text-muted-foreground">
                    {command.source === 'builtin' && command.name === 'reload'
                      ? t('reloadDescription')
                      : command.description}
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'text-right text-sm text-muted-foreground opacity-0',
                      active && 'opacity-80'
                    )}
                  >
                    ↵
                  </span>
                </div>
              )
            })}
          </section>
        ))}

        {!hasCommands ? (
          <div className="flex min-h-20 items-center justify-center gap-2 px-4 text-xs text-muted-foreground">
            {loading ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
            <span>{loading ? t('slashLoading') : error ? t('slashFailed') : t('slashEmpty')}</span>
          </div>
        ) : status ? (
          <div className="flex min-h-7 items-center gap-2 px-2 text-xs text-muted-foreground">
            {loading ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
            <span>{status}</span>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-7 items-center justify-between gap-3 border-t px-2.5 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {groups.length > 0
            ? t('slashSummary', { commands: commandCount, groups: groups.length })
            : t('slashCount', { count: commandCount })}
        </span>
        <span className="flex items-center gap-2 max-sm:hidden" aria-hidden="true">
          <span>{t('slashUpDown')}</span>
          <span>{t('slashEnter')}</span>
          <span>{t('slashEscape')}</span>
        </span>
      </div>
    </div>
  )
}
