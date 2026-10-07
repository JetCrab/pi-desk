'use client'

import { CheckIcon, CopyIcon, EraserIcon, Layers3Icon, LoaderCircleIcon } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { copyL4BrowserText } from '@client/l4_foundation/lib/l4-browser-clipboard'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger
} from '@client/l4_foundation/ui/shadcn/hover-card'

interface L2WorkbenchContextUsageProps {
  sessionId: string
  cwd: string
  tokens: number | null
  contextWindow: number
  contextIgnorePlugin?: unknown
  ignoreDisabled: boolean
  ignorePending: boolean
  compactDisabled: boolean
  compactPending: boolean
  onIgnoreContext: () => Promise<void>
  onCompactContext: () => Promise<void>
}

interface L2WorkbenchContextIgnoreState {
  ignoredTokens: number
  potentialTokens: number
  effectiveTokens?: number | null
}

interface L2WorkbenchContextUsageView {
  contextIgnore: L2WorkbenchContextIgnoreState | null
  currentTokens: number | null
  usedPercent: number
  projectedTokens: number | null
  projectedPercent: number | null
  potentialSegmentPercent: number
}

const CONTEXT_RING_RADIUS = 7
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS

function formatTokens(tokens: number | null): string {
  if (tokens === null) return '--'
  const rounded = Math.round(tokens)
  if (rounded < 1000) return String(rounded)
  return `${Math.round(rounded / 100) / 10}K`
}

function parseContextIgnorePlugin(input: unknown): L2WorkbenchContextIgnoreState | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (
    typeof value.ignoredTokens !== 'number' ||
    !Number.isFinite(value.ignoredTokens) ||
    value.ignoredTokens < 0 ||
    typeof value.potentialTokens !== 'number' ||
    !Number.isFinite(value.potentialTokens) ||
    value.potentialTokens < 0 ||
    (value.effectiveTokens !== undefined &&
      value.effectiveTokens !== null &&
      (typeof value.effectiveTokens !== 'number' ||
        !Number.isFinite(value.effectiveTokens) ||
        value.effectiveTokens < 0))
  ) {
    return null
  }
  return {
    ignoredTokens: value.ignoredTokens,
    potentialTokens: value.potentialTokens,
    ...(value.effectiveTokens !== undefined
      ? { effectiveTokens: value.effectiveTokens as number | null }
      : {})
  }
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export function buildL2WorkbenchContextUsageView(
  tokens: number | null,
  contextWindow: number,
  contextIgnorePlugin: unknown
): L2WorkbenchContextUsageView {
  const contextIgnore = parseContextIgnorePlugin(contextIgnorePlugin)
  const currentTokens =
    contextIgnore?.effectiveTokens === undefined ? tokens : contextIgnore.effectiveTokens
  const usedPercent =
    currentTokens === null ? 0 : clampPercent((currentTokens / contextWindow) * 100)
  const projectedTokens =
    currentTokens === null || contextIgnore === null
      ? null
      : Math.max(0, currentTokens - contextIgnore.potentialTokens)
  const projectedPercent =
    projectedTokens === null ? null : clampPercent((projectedTokens / contextWindow) * 100)

  return {
    contextIgnore,
    currentTokens,
    usedPercent,
    projectedTokens,
    projectedPercent,
    potentialSegmentPercent:
      projectedPercent === null ? 0 : Math.max(0, usedPercent - projectedPercent)
  }
}

function ringOffset(percent: number): number {
  return CONTEXT_RING_CIRCUMFERENCE - (percent / 100) * CONTEXT_RING_CIRCUMFERENCE
}

export function L2WorkbenchContextUsage({
  sessionId,
  cwd,
  tokens,
  contextWindow,
  contextIgnorePlugin,
  ignoreDisabled,
  ignorePending,
  compactDisabled,
  compactPending,
  onIgnoreContext,
  onCompactContext
}: L2WorkbenchContextUsageProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const triggerId = useId()
  const touchPressRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [sessionIdCopied, setSessionIdCopied] = useState(false)
  const [pathCopied, setPathCopied] = useState(false)
  const toast = useL4AppToast()
  const view = buildL2WorkbenchContextUsageView(tokens, contextWindow, contextIgnorePlugin)
  const percent = Math.round(view.usedPercent)
  const projectedPercent = view.projectedPercent === null ? null : Math.round(view.projectedPercent)
  const toneClass =
    percent >= 90
      ? 'text-destructive'
      : percent >= 80
        ? 'text-status-warning'
        : 'text-muted-foreground'
  const progressClass =
    percent >= 90 ? 'bg-destructive' : percent >= 80 ? 'bg-status-warning' : 'bg-primary'
  const label = view.contextIgnore
    ? t('contextUsageWithIgnore', {
        percent,
        projected: projectedPercent ?? 0,
        ignored: formatTokens(view.contextIgnore.ignoredTokens),
        potential: formatTokens(view.contextIgnore.potentialTokens)
      })
    : t('contextUsageSimple', { percent, limit: formatTokens(contextWindow) })

  return (
    <HoverCard
      open={open}
      triggerId={triggerId}
      onOpenChange={(nextOpen, eventDetails) => {
        if (touchPressRef.current && eventDetails.reason === 'trigger-focus') return
        if (!nextOpen) {
          setSessionIdCopied(false)
          setPathCopied(false)
        }
        setOpen(nextOpen)
      }}
    >
      <HoverCardTrigger
        id={triggerId}
        delay={100}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={label}
            aria-expanded={open}
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-transparent transition-colors outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring/50 data-open:bg-accent"
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
            <svg
              className="pointer-events-none block size-5 -rotate-90"
              viewBox="0 0 20 20"
              aria-hidden="true"
            >
              <circle
                cx="10"
                cy="10"
                r={CONTEXT_RING_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-muted-foreground opacity-20"
              />
              {view.contextIgnore ? (
                <>
                  {view.usedPercent > 0 ? (
                    <circle
                      cx="10"
                      cy="10"
                      r={CONTEXT_RING_RADIUS}
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeWidth="2"
                      strokeDasharray={CONTEXT_RING_CIRCUMFERENCE}
                      strokeDashoffset={ringOffset(view.usedPercent)}
                      className="text-muted-foreground"
                    />
                  ) : null}
                  {view.projectedPercent !== null && view.projectedPercent > 0 ? (
                    <circle
                      cx="10"
                      cy="10"
                      r={CONTEXT_RING_RADIUS}
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeWidth="2"
                      strokeDasharray={CONTEXT_RING_CIRCUMFERENCE}
                      strokeDashoffset={ringOffset(view.projectedPercent)}
                      className="text-foreground"
                    />
                  ) : null}
                </>
              ) : view.usedPercent > 0 ? (
                <circle
                  cx="10"
                  cy="10"
                  r={CONTEXT_RING_RADIUS}
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="2"
                  strokeDasharray={CONTEXT_RING_CIRCUMFERENCE}
                  strokeDashoffset={ringOffset(view.usedPercent)}
                  className={toneClass}
                />
              ) : null}
            </svg>
          </button>
        }
      />

      <HoverCardContent
        side="top"
        align="center"
        sideOffset={6}
        aria-label={t('contextDetails')}
        className="w-80 max-w-[calc(100vw-2rem)] p-4 text-sm"
      >
        <div className="space-y-2">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="whitespace-nowrap text-muted-foreground">{t('contextMetrics')}</span>
              <span className="whitespace-nowrap font-medium tabular-nums text-foreground">
                {formatTokens(view.currentTokens)} / {formatTokens(contextWindow)} / {percent}%
              </span>
            </div>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
              {view.contextIgnore && view.projectedPercent !== null ? (
                <>
                  <div
                    className="h-full bg-foreground"
                    style={{ width: `${view.projectedPercent}%` }}
                  />
                  <div
                    className="h-full bg-muted-foreground"
                    style={{ width: `${view.potentialSegmentPercent}%` }}
                  />
                </>
              ) : (
                <div
                  className={cn('h-full rounded-full', progressClass)}
                  style={{ width: `${view.usedPercent}%` }}
                />
              )}
            </div>
          </div>
          {view.contextIgnore && view.projectedTokens !== null ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <span className="size-2 rounded-full bg-foreground" />
                  {t('afterIgnore')}
                </span>
                <span className="font-medium tabular-nums text-foreground">
                  {formatTokens(view.projectedTokens)} · {projectedPercent}%
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <span className="size-2 rounded-full bg-muted-foreground" />
                  {t('potentialIgnore')}
                </span>
                <span className="font-medium tabular-nums text-foreground">
                  {formatTokens(view.contextIgnore.potentialTokens)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{t('alreadyIgnored')}</span>
                <span className="font-medium tabular-nums text-foreground">
                  {formatTokens(view.contextIgnore.ignoredTokens)}
                </span>
              </div>
            </>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                ignoreDisabled ||
                ignorePending ||
                !view.contextIgnore ||
                view.contextIgnore.potentialTokens <= 0
              }
              aria-label={
                view.contextIgnore && view.contextIgnore.potentialTokens > 0
                  ? t('ignoreNow', { amount: formatTokens(view.contextIgnore.potentialTokens) })
                  : t('nothingToIgnore')
              }
              aria-busy={ignorePending}
              onClick={() => void onIgnoreContext()}
            >
              {ignorePending ? <LoaderCircleIcon className="animate-spin" /> : <EraserIcon />}
              {ignorePending ? t('ignoring') : t('ignore')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={compactDisabled || compactPending}
              aria-busy={compactPending}
              onClick={() => void onCompactContext()}
            >
              {compactPending ? <LoaderCircleIcon className="animate-spin" /> : <Layers3Icon />}
              {compactPending ? t('compacting') : t('compact')}
            </Button>
          </div>
          {percent >= 80 ? (
            <p
              className={cn(
                'pt-1 text-sm',
                percent >= 90 ? 'text-destructive' : 'text-status-warning'
              )}
            >
              {percent >= 90 ? t('contextCritical') : t('contextWarning')}
            </p>
          ) : null}
          <div className="border-t border-border" />
          <button
            type="button"
            aria-label={t('copySessionId', { id: sessionId })}
            className="w-full cursor-pointer rounded-md px-1 py-1 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring/50"
            onClick={() => {
              void copyL4BrowserText(sessionId).then((copied) => {
                if (copied) {
                  setSessionIdCopied(true)
                  return
                }
                toast.error(t('copySessionFailed'))
              })
            }}
          >
            <span className="flex items-center justify-between gap-3 text-muted-foreground">
              <span>{t('currentSessionId')}</span>
              <span className="inline-flex items-center gap-1">
                {sessionIdCopied ? t('copied') : t('clickToCopy')}
                {sessionIdCopied ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
              </span>
            </span>
            <span className="mt-1 block break-all font-mono text-xs leading-5 text-foreground">
              {sessionId}
            </span>
          </button>
          <button
            type="button"
            aria-label={t('copyCurrentPath', { path: cwd })}
            className="w-full cursor-pointer rounded-md px-1 py-1 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring/50"
            onClick={() => {
              void copyL4BrowserText(cwd).then((copied) => {
                if (copied) {
                  setPathCopied(true)
                  return
                }
                toast.error(t('copyPathFailed'))
              })
            }}
          >
            <span className="flex items-center justify-between gap-3 text-muted-foreground">
              <span>{t('currentPath')}</span>
              <span className="inline-flex items-center gap-1">
                {pathCopied ? t('copied') : t('clickToCopy')}
                {pathCopied ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
              </span>
            </span>
            <span
              className="mt-1 block min-w-0 break-words font-mono text-xs leading-5 text-foreground"
              title={cwd}
            >
              {cwd}
            </span>
          </button>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
