import { ChevronRightIcon, GlobeIcon, TerminalIcon } from 'lucide-react'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { useL2PiSettingsText } from '../l2-pi-settings-locale'
import { l2McpConnectionLabel, type L2McpSettingsRow } from '../l2-pi-settings-model'

export function L2McpSettingsList({
  rows,
  selectedName,
  pending,
  onSelect
}: {
  rows: readonly L2McpSettingsRow[]
  selectedName: string | null
  pending: boolean
  onSelect: (row: L2McpSettingsRow) => void
}): React.JSX.Element {
  const t = useL2PiSettingsText()
  return (
    <ul aria-label={t('服务列表')} className="divide-y">
      {rows.map((row) => {
        const Icon = typeof row.config.url === 'string' ? GlobeIcon : TerminalIcon
        return (
          <li key={row.name}>
            <button
              type="button"
              aria-label={`${t('配置服务')} · ${row.name}`}
              aria-current={selectedName === row.name ? 'true' : undefined}
              disabled={pending}
              onClick={() => onSelect(row)}
              className={cn(
                'flex w-full min-w-0 cursor-pointer items-center gap-3 p-4 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
                selectedName === row.name && 'bg-accent'
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="min-w-0 break-all text-sm font-medium">{row.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t(row.config.enabled === false ? '已停用' : '已启用')}
                  </span>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(row.source)} ·{' '}
                  {t(typeof row.config.url === 'string' ? 'HTTP 地址' : '本地程序')}
                </span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {l2McpConnectionLabel(row.config)}
                </span>
              </span>
              <ChevronRightIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
