'use client'

import { ImageIcon, ListOrderedIcon, RotateCcwIcon } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2ChatQueuedInput, L2ChatRuntime } from '@common/l2_biz/chat/l2-chat-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger
} from '@client/l4_foundation/ui/shadcn/hover-card'

interface L2WorkbenchQueuePreviewProps {
  queues: L2ChatRuntime['queues']
  disabled: boolean
  onRestore: () => void
}

interface QueueSectionProps {
  label: string
  description: string
  markerClass: string
  countClass: string
  inputs: readonly L2ChatQueuedInput[]
}

function QueueSection({
  label,
  description,
  markerClass,
  countClass,
  inputs
}: QueueSectionProps): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  if (inputs.length === 0) return null

  return (
    <section className="space-y-2">
      <div className="flex items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`size-1.5 shrink-0 rounded-full ${markerClass}`} />
            <h3 className="text-sm font-medium text-foreground">{label}</h3>
          </div>
          <p className="mt-1 pl-3.5 text-sm leading-5 text-muted-foreground">{description}</p>
        </div>
        <span
          className={`shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums ${countClass}`}
        >
          {t('queueItems', { count: inputs.length })}
        </span>
      </div>

      <ol className="divide-y divide-border overflow-hidden">
        {inputs.map((input, index) => {
          const text = input.text.trim()
          return (
            <li
              key={input.tempId}
              className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2.5 px-3 py-2.5"
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-xs tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0 space-y-1">
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                  {text || t(input.images.length > 0 ? 'imageOnly' : 'noMessageText')}
                </p>
                {input.images.length > 0 ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <ImageIcon className="size-3" />
                    {t('queueImages', { count: input.images.length })}
                  </span>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export function L2WorkbenchQueuePreview({
  queues,
  disabled,
  onRestore
}: L2WorkbenchQueuePreviewProps): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const triggerId = useId()
  const touchPressRef = useRef(false)
  const [open, setOpen] = useState(false)
  const queueCount = queues.steering.length + queues.followUp.length

  if (queueCount === 0) return null

  return (
    <HoverCard
      open={open}
      triggerId={triggerId}
      onOpenChange={(nextOpen, eventDetails) => {
        if (touchPressRef.current && eventDetails.reason === 'trigger-focus') return
        setOpen(nextOpen)
      }}
    >
      <HoverCardTrigger
        id={triggerId}
        delay={100}
        closeDelay={120}
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={t('viewQueued', { count: queueCount })}
            aria-expanded={open}
            onPointerDown={(event) => {
              touchPressRef.current = event.pointerType !== 'mouse'
            }}
            onPointerCancel={() => {
              touchPressRef.current = false
            }}
            onClick={(event) => {
              if (!touchPressRef.current) return
              event.preventDefault()
              setOpen((current) => !current)
              queueMicrotask(() => {
                touchPressRef.current = false
              })
            }}
          >
            {t('queuedCount', { count: queueCount })}
          </Button>
        }
      />

      <HoverCardContent
        side="top"
        align="end"
        sideOffset={6}
        aria-label={t('queueCurrent')}
        className="w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        <div className="border-b px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
              <ListOrderedIcon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold tracking-tight text-foreground">
                {t('queueCurrent')}
              </h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                {t('queuePendingDescription')}
              </p>
            </div>
            <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs tabular-nums text-foreground">
              {t('queueItems', { count: queueCount })}
            </span>
          </div>
        </div>

        <div className="pi-desk-chat-scrollbar max-h-[min(24rem,55dvh)] space-y-4 overflow-y-auto p-4">
          <QueueSection
            label={t('queueSteer')}
            description={t('queueSteerDescription')}
            markerClass="bg-foreground"
            countClass="bg-muted text-muted-foreground"
            inputs={queues.steering}
          />
          <QueueSection
            label={t('queueFollowUp')}
            description={t('queueFollowUpDescription')}
            markerClass="bg-muted-foreground"
            countClass="bg-muted text-muted-foreground"
            inputs={queues.followUp}
          />
        </div>

        <div className="border-t border-border/60 bg-muted/15 p-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground hover:text-foreground"
            disabled={disabled}
            onClick={onRestore}
          >
            <RotateCcwIcon />
            {t('queueRestore')}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
