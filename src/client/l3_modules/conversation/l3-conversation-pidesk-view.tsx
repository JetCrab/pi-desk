'use client'

import { ChevronDownIcon, MonitorIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  readL3ConversationPiDeskOutput,
  type L3ConversationPiDeskCommand,
  type L3ConversationPiDeskOutput,
  type L3ConversationPiDeskPlugin
} from '@common/l3_modules/conversation/l3-conversation-pidesk'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'

function PluginResult({ plugin }: { plugin: L3ConversationPiDeskPlugin }): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const { locale } = useL4Region()
  return (
    <div className="min-w-0 space-y-1 py-2 first:pt-0 last:pb-0" role="listitem">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{plugin.name}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {plugin.version ?? t('pidesk.unknownVersion')}
        </span>
        <span className="text-xs text-muted-foreground">{t(`pidesk.status.${plugin.status}`)}</span>
      </div>
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {t(`pidesk.kind.${plugin.kind}`)}
        {' · '}
        <span className="font-mono">{plugin.source}</span>
      </p>
      {plugin.updateTag || plugin.availableVersion ? (
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {plugin.updateTag ? (
            <span>{t('pidesk.updateChannel', { tag: plugin.updateTag })}</span>
          ) : null}
          {plugin.availableVersion ? (
            <span>{t('pidesk.targetVersion', { version: plugin.availableVersion })}</span>
          ) : null}
        </p>
      ) : null}
      {plugin.updateError ? (
        <p className="text-destructive [overflow-wrap:anywhere]">{plugin.updateError}</p>
      ) : null}
      {plugin.operation ? (
        <p className="[overflow-wrap:anywhere]">
          {t(`pidesk.action.${plugin.operation.action}`)}
          {' · '}
          {t(`pidesk.phase.${plugin.operation.phase}`)}
          {plugin.operation.message ? ` · ${plugin.operation.message}` : ''}
        </p>
      ) : null}
      {plugin.error ? (
        <p className="text-destructive [overflow-wrap:anywhere]">
          {t(`pidesk.errorPhase.${plugin.error.phase}`)}
          {' · '}
          {selectL4LocalizedText(plugin.error.message, locale)}
        </p>
      ) : null}
    </div>
  )
}

function KnownResult({ result }: { result: L3ConversationPiDeskOutput }): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const { locale } = useL4Region()
  if (result.kind === 'info') {
    return (
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2">
        {Object.entries(result.data).map(([key, value]) => (
          <div className="contents" key={key}>
            <dt className="text-muted-foreground">{t(`pidesk.info.${key}`)}</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">
              {key === 'environment' ? (
                t(`pidesk.environment.${value}`)
              ) : key === 'mode' ? (
                t(`pidesk.mode.${value}`)
              ) : (
                <span className="font-mono">{value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    )
  }
  if (result.kind === 'plugin') {
    return (
      <>
        <div role="list">
          <PluginResult plugin={result.data} />
        </div>
        <p className="mt-3 mb-2 font-medium">{t('pidesk.pluginDetail')}</p>
        <pre className="whitespace-pre-wrap break-words font-mono leading-relaxed">
          {JSON.stringify(result.data.detail, null, 2)}
        </pre>
      </>
    )
  }
  return (
    <>
      {result.data.restartRequired ? <p className="mb-2">{t('pidesk.restartRequired')}</p> : null}
      {result.data.loadError ? (
        <p className="mb-2 text-destructive [overflow-wrap:anywhere]">
          {selectL4LocalizedText(result.data.loadError, locale)}
        </p>
      ) : null}
      {result.data.plugins.length > 0 ? (
        <div className="divide-y divide-border" role="list">
          {result.data.plugins.map((plugin, index) => (
            <PluginResult key={`${plugin.source}:${index}`} plugin={plugin} />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground">{t('pidesk.noPlugins')}</p>
      )}
    </>
  )
}

export function L3ConversationPiDeskView({
  identity,
  command,
  output,
  expandable,
  open,
  loading,
  error,
  onOpenChange,
  commandAction,
  outputAction
}: {
  identity: string
  command: L3ConversationPiDeskCommand
  output: string | null
  expandable: boolean
  open: boolean
  loading: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  commandAction: ReactNode
  outputAction: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const title = command.label
    ? [t(command.label), command.name, command.version].filter(Boolean).join(' · ')
    : command.command
  const result = output === null ? null : readL3ConversationPiDeskOutput(command.label, output)
  return (
    <Collapsible
      open={expandable && open}
      onOpenChange={onOpenChange}
      className="w-full min-w-0 overflow-hidden rounded-lg border border-border bg-card text-sm leading-relaxed"
      data-message-id={identity}
      data-chat-scroll-anchor={`${identity}:tool`}
    >
      <CollapsibleTrigger
        disabled={!expandable}
        aria-label={expandable ? t(open ? 'collapseTool' : 'expandTool', { name: title }) : title}
        className={cn(
          'flex min-h-9 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left',
          expandable &&
            'cursor-pointer hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
        )}
      >
        <MonitorIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span
          className={cn('min-w-0 flex-1 truncate font-medium', !command.label && 'font-mono')}
          title={title}
        >
          {title}
        </span>
        {expandable ? (
          <ChevronDownIcon
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180'
            )}
            aria-hidden="true"
          />
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height,opacity] duration-200 ease-out data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-none">
        <div className="border-t">
          <section className="border-b px-3 py-2" aria-label={t('pidesk.command')}>
            <div className="mb-1 flex min-h-7 items-center justify-between gap-2">
              <h4 className="font-medium text-muted-foreground">{t('pidesk.command')}</h4>
              {commandAction}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono leading-relaxed">
              {command.command}
            </pre>
          </section>
          <section aria-label={t('pidesk.output')}>
            <div className="flex min-h-9 items-center justify-between gap-2 px-3 pt-2">
              <h4 className="font-medium text-muted-foreground">{t('pidesk.output')}</h4>
              {outputAction}
            </div>
            <div
              className="max-h-[min(24rem,50dvh)] overflow-auto px-3 pt-1 pb-3"
              role="region"
              aria-label={t('pidesk.output')}
              tabIndex={0}
            >
              {loading ? (
                <p className="text-muted-foreground">{t('loadingResult')}</p>
              ) : error ? (
                <p className="text-destructive [overflow-wrap:anywhere]">{error}</p>
              ) : !output ? (
                <p className="text-muted-foreground">{t('pidesk.empty')}</p>
              ) : result ? (
                <KnownResult result={result} />
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono leading-relaxed">
                  {output}
                </pre>
              )}
            </div>
          </section>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
