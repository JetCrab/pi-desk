import { GlobeIcon, SearchIcon, ShieldCheckIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  l3CapabilityModeNames,
  type L3CapabilityModeNames
} from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import {
  l2CapabilityModeDirty,
  l2PromptDirty,
  type L2CapabilityDrafts,
  type L2CapabilitySelection
} from '../l2-capability-modes-drafts'

export function L2CapabilityModeList({
  drafts,
  modeNames,
  selected,
  query,
  disabled,
  onQuery,
  onSelect
}: {
  drafts: L2CapabilityDrafts
  modeNames: L3CapabilityModeNames
  selected: L2CapabilitySelection
  query: string
  disabled: boolean
  onQuery: (query: string) => void
  onSelect: (selection: L2CapabilitySelection) => void
}): React.JSX.Element {
  const { t } = useTranslation('capabilityModes')
  const names = drafts.saved === null ? modeNames : l3CapabilityModeNames(drafts.modes)
  const filtered = Object.entries(names).filter(([, name]) =>
    name.toLowerCase().includes(query.trim().toLowerCase())
  )
  const row = (
    item: L2CapabilitySelection,
    name: string,
    description: string,
    dirty: boolean
  ): React.JSX.Element => {
    const active =
      item.kind === selected.kind &&
      (item.kind !== 'mode' || (selected.kind === 'mode' && item.key === selected.key))
    const Icon = item.kind === 'global' ? GlobeIcon : ShieldCheckIcon
    return (
      <button
        type="button"
        disabled={disabled}
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelect(item)}
        className={cn(
          'flex w-full cursor-pointer gap-2 rounded-lg px-3 py-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
          active && 'bg-accent text-accent-foreground'
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 break-words text-sm font-medium">
              {name || t('unnamedMode')}
            </span>
            {dirty && (
              <span
                aria-label={t('unsaved')}
                className="size-1.5 shrink-0 rounded-full bg-foreground"
              />
            )}
          </span>
          {description && (
            <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
          )}
        </span>
      </button>
    )
  }
  return (
    <aside aria-label={t('modeList')} className="flex min-h-0 flex-col bg-sidebar/40">
      <div className="relative m-3 shrink-0">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={t('searchModes')}
          placeholder={t('searchModes')}
          className="pl-9"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 pt-0">
        {row(
          { kind: 'global' },
          t('globalPrompt'),
          t('globalShared'),
          l2PromptDirty(drafts.global)
        )}
        <p className="px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground">
          {t('workingModes')}
        </p>
        {(!query.trim() || t('allEnabled').toLowerCase().includes(query.trim().toLowerCase())) &&
          row({ kind: 'all' }, t('allEnabled'), t('builtin'), false)}
        {filtered.map(([key, name]) => {
          const mode = drafts.modes[key]
          return (
            <div key={key}>
              {row(
                { kind: 'mode', key },
                name,
                drafts.saved === null
                  ? ''
                  : t(
                      mode?.promptSource === 'none'
                        ? 'sourceNone'
                        : mode?.promptSource === 'custom'
                          ? 'sourceCustom'
                          : 'sourceGlobal'
                    ),
                drafts.saved !== null && l2CapabilityModeDirty(drafts, key)
              )}
            </div>
          )
        })}
        {query.trim() &&
          filtered.length === 0 &&
          !t('allEnabled').toLowerCase().includes(query.trim().toLowerCase()) && (
            <p className="px-3 py-4 text-sm text-muted-foreground">{t('noModeMatches')}</p>
          )}
      </div>
    </aside>
  )
}
