'use client'

import { XIcon } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger
} from '@client/l4_foundation/ui/shadcn/popover'
import {
  formatL3ConversationCost,
  formatL3ConversationTokenCount,
  type L3ConversationDisplayMessage
} from './l3-conversation-display'
import styles from './l3-conversation-call-summary.module.css'

export function L3ConversationCallSummary({
  messages,
  incomplete,
  children
}: {
  messages: readonly L3ConversationDisplayMessage[]
  incomplete: boolean
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const [open, setOpen] = useState(false)
  const [hoverBlocked, setHoverBlocked] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const hoverPreview = useRef(false)

  return (
    <Popover
      open={open}
      onOpenChange={(next, event) => {
        if (!next && event.reason === 'trigger-press' && hoverPreview.current) {
          hoverPreview.current = false
          event.cancel()
          return
        }
        if (next && event.reason === 'trigger-hover' && hoverBlocked) {
          event.cancel()
          return
        }
        if (
          !next &&
          event.reason === 'trigger-hover' &&
          (!hoverPreview.current || popup.current?.contains(document.activeElement))
        ) {
          event.cancel()
          return
        }
        if (next) hoverPreview.current = event.reason === 'trigger-hover'
        else if (event.reason !== 'trigger-hover') {
          hoverPreview.current = false
          setHoverBlocked(true)
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger
        ref={trigger}
        openOnHover={!hoverBlocked}
        delay={250}
        closeDelay={180}
        onPointerLeave={() => setHoverBlocked(false)}
        className="min-w-0 cursor-pointer rounded-sm text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        ref={popup}
        align="start"
        side="top"
        initialFocus={() => (hoverPreview.current ? false : true)}
        finalFocus={() => (hoverPreview.current ? false : trigger.current)}
        className={cn(styles.panel, 'w-[30rem] gap-0 p-2')}
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-1 pb-1">
          <PopoverTitle className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
            {t(incomplete ? 'calls.loadedTitle' : 'calls.title')}
          </PopoverTitle>
          <button
            type="button"
            aria-label={t('calls.close')}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              hoverPreview.current = false
              setHoverBlocked(true)
              setOpen(false)
            }}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
        {open ? (
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <div className={styles.table}>
              <div className={cn(styles.row, 'text-muted-foreground')}>
                <span>{t('calls.model')}</span>
                <span>{t('calls.input')}</span>
                <span>{t('calls.output')}</span>
                <span>{t('calls.cached')}</span>
                <span>{t('calls.cost')}</span>
              </div>
              {messages.map((message) => {
                const fixed = message.snapshot.fixed
                if (fixed.type !== 'assistant') return null
                const model = message.summary.type === 'assistant' ? message.summary.model : null
                const usage = fixed.usage
                return (
                  <div key={message.durable!.location.entryId} className={styles.row}>
                    <span className="flex min-w-0 items-center gap-1">
                      <span
                        className="min-w-0 truncate"
                        title={model ? `${model.modelId} · ${model.provider}` : undefined}
                      >
                        {model?.modelId || t('calls.unknownModel')}
                        {model?.provider ? (
                          <span className="text-muted-foreground"> · {model.provider}</span>
                        ) : null}
                      </span>
                      {fixed.status === 'error' || fixed.status === 'aborted' ? (
                        <span className="shrink-0 text-destructive">
                          {t(`calls.${fixed.status}`)}
                        </span>
                      ) : null}
                    </span>
                    <span>{formatL3ConversationTokenCount(usage.inputTokens)}</span>
                    <span>{formatL3ConversationTokenCount(usage.outputTokens)}</span>
                    <span>{formatL3ConversationTokenCount(usage.cacheReadTokens)}</span>
                    <span>{formatL3ConversationCost(usage.costUsd)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
