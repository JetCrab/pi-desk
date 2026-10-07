'use client'

import {
  Clock3Icon,
  ChevronDownIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MessageCircleQuestionIcon,
  SquareIcon,
  XIcon
} from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { L4PiUiRequest, L4PiUiSnapshot } from '@common/l4_foundation/pi/l4-pi-ui-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { Textarea } from '@client/l4_foundation/ui/shadcn/textarea'
import { L4ChoiceGroup } from '@client/l4_foundation/ui/l4-choice-group'
import {
  L4AppDialogRoot,
  L4AppDialogContent,
  L4AppDialogHeader,
  L4AppDialogTitle,
  L4AppDialogFooter
} from '@client/l4_foundation/ui/l4-app-dialog'
import type { L2NativeUiModel } from './l2-native-ui'
import { L2NativeUiNotices } from './l2-native-ui-notices'

function Question({
  request,
  model
}: {
  request: L4PiUiRequest
  model: L2NativeUiModel
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const titleId = useId()
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const { state } = model
  const hasAnswer = Object.hasOwn(state.answers, request.id)
  const value = state.answers[request.id] ?? (request.method === 'editor' ? request.prefill : '')
  const expired = request.expiresAt !== null && request.expiresAt <= now
  const disabled = !state.ready || state.submitting !== null || state.unknown !== null || expired
  const submitDisabled = disabled || (request.method === 'select' && !hasAnswer)

  useEffect(() => {
    if (request.expiresAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [request.expiresAt])

  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (!submitDisabled) model.answer(request.id, request.method === 'confirm' ? true : value)
  }
  const textarea = (large: boolean): React.JSX.Element => (
    <Textarea
      aria-label={request.title}
      aria-labelledby={large ? undefined : titleId}
      className={
        large ? 'min-h-0 flex-1 resize-none text-base' : 'h-32 min-h-20 resize-none text-base'
      }
      value={value}
      disabled={state.submitting !== null}
      maxLength={64 * 1024}
      onChange={(event) => model.setAnswer(request.id, event.target.value)}
      onKeyDown={(event) => {
        if (
          !event.nativeEvent.isComposing &&
          event.key === 'Enter' &&
          (event.ctrlKey || event.metaKey)
        ) {
          event.preventDefault()
          submit()
        }
      }}
    />
  )
  const actions = (dialog = false): React.JSX.Element => (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={!dialog && !model.canStop}
        onClick={dialog ? () => setExpanded(false) : model.stop}
      >
        {dialog ? (
          t('nativeUiBack')
        ) : (
          <>
            <SquareIcon className="size-3.5" />
            {t('nativeUiStop')}
          </>
        )}
      </Button>
      <span className="flex-1" />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => model.answer(request.id, request.method === 'confirm' ? false : null)}
      >
        {t(request.method === 'confirm' ? 'nativeUiReject' : 'nativeUiCancel')}
      </Button>
      <Button
        type={dialog ? 'button' : 'submit'}
        size="sm"
        disabled={submitDisabled}
        onClick={dialog ? () => submit() : undefined}
      >
        {t(
          state.submitting
            ? 'nativeUiSubmitting'
            : request.method === 'confirm'
              ? 'nativeUiConfirm'
              : 'nativeUiSubmit'
        )}
      </Button>
    </>
  )

  return (
    <>
      <section
        className="mb-2 overflow-hidden rounded-xl border border-input bg-background"
        aria-label={t('nativeUiTitle')}
        data-testid="native-ui-question"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing && !expanded) {
            event.preventDefault()
            event.stopPropagation()
            model.setCollapsed(true)
          }
        }}
      >
        <div className="flex flex-wrap items-center gap-2 px-3 pt-2 text-xs text-muted-foreground">
          <MessageCircleQuestionIcon className="size-3.5" />
          <span>{t('nativeUiTitle')}</span>
          {state.snapshot.requests.length > 1 ? (
            <span>{t('nativeUiMore', { count: state.snapshot.requests.length - 1 })}</span>
          ) : null}
          <span className="flex-1" />
          {request.method === 'editor' ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setExpanded(true)}>
              <Maximize2Icon className="size-3.5" />
              {t('nativeUiExpand')}
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={() => model.setCollapsed(true)}>
            {t('nativeUiLater')}
          </Button>
        </div>
        <form onSubmit={submit}>
          <div className="max-h-[40dvh] space-y-3 overflow-y-auto px-3 pt-2 pb-3">
            <h3
              id={titleId}
              className="text-base leading-6 font-medium whitespace-pre-wrap wrap-anywhere"
            >
              {request.title}
            </h3>
            {request.method === 'confirm' ? (
              <p className="text-sm leading-6 whitespace-pre-wrap wrap-anywhere text-muted-foreground">
                {request.message}
              </p>
            ) : null}
            {request.method === 'select' ? (
              <L4ChoiceGroup
                label={request.title}
                value={hasAnswer ? String(request.options.indexOf(value)) : ''}
                disabled={disabled}
                options={request.options.map((label, index) => ({ value: String(index), label }))}
                onChange={(index) => model.setAnswer(request.id, request.options[Number(index)]!)}
              />
            ) : null}
            {request.method === 'input' ? (
              <Input
                aria-labelledby={titleId}
                value={value}
                placeholder={request.placeholder}
                maxLength={64 * 1024}
                className="text-base"
                disabled={state.submitting !== null}
                onChange={(event) => model.setAnswer(request.id, event.target.value)}
              />
            ) : null}
            {request.method === 'editor' ? textarea(false) : null}
            {request.expiresAt !== null ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock3Icon className="size-3.5" />
                {t('nativeUiCountdown', {
                  seconds: Math.max(0, Math.ceil((request.expiresAt - now) / 1000))
                })}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">{actions()}</div>
        </form>
      </section>
      {request.method === 'editor' && expanded ? (
        <L4AppDialogRoot open onOpenChange={setExpanded}>
          <L4AppDialogContent
            className="h-[min(40rem,calc(100dvh-2rem))] max-w-3xl"
            data-testid="native-ui-editor-dialog"
          >
            <L4AppDialogHeader className="px-4 pt-4 pr-12 pb-3">
              <L4AppDialogTitle>{request.title}</L4AppDialogTitle>
            </L4AppDialogHeader>
            {state.error || !state.ready ? (
              <p role="status" className="px-4 pb-3 text-sm text-muted-foreground">
                {state.error ?? t('nativeUiDisconnected')}
              </p>
            ) : null}
            <div className="flex min-h-0 flex-1 px-4 pb-4">{textarea(true)}</div>
            <L4AppDialogFooter>{actions(true)}</L4AppDialogFooter>
          </L4AppDialogContent>
        </L4AppDialogRoot>
      ) : null}
    </>
  )
}

export function L2NativeUiQuestions({
  model
}: {
  model: L2NativeUiModel
}): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const { state } = model
  const request = state.snapshot.requests[0]
  return (
    <>
      {state.error || (!state.ready && request) ? (
        <div
          role="status"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1">{state.error ?? t('nativeUiDisconnected')}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={state.refreshing}
            onClick={model.refresh}
          >
            {state.refreshing ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
            {t('nativeUiRetry')}
          </Button>
          {!request ? (
            <Button type="button" variant="ghost" size="sm" onClick={model.dismissError}>
              {t('close', { ns: 'common' })}
            </Button>
          ) : null}
        </div>
      ) : null}
      {request ? (
        state.collapsed ? (
          <div
            className="mb-2 flex items-center gap-2 rounded-lg border px-3 py-2"
            data-testid="native-ui-collapsed"
          >
            <MessageCircleQuestionIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 text-sm">
              {t('nativeUiPending', { count: state.snapshot.requests.length })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => model.setCollapsed(false)}
            >
              {t('nativeUiResume')}
            </Button>
          </div>
        ) : (
          <Question key={request.id} request={request} model={model} />
        )
      ) : null}
      {state.notices.length > 0 ? (
        <Collapsible
          defaultOpen={Boolean(request || state.commandPending?.startsWith('/mcp login '))}
          className="mb-2 rounded-lg border px-3 py-2"
          data-testid="native-ui-output"
        >
          <div className="flex items-center gap-2">
            <CollapsibleTrigger className="group flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-180 motion-reduce:transition-none" />
              {t('nativeCommandOutput', { defaultValue: '会话命令输出' })}
            </CollapsibleTrigger>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('close', { ns: 'common' })}
              onClick={model.dismissNotices}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
          <CollapsibleContent>
            <div className="mt-2 max-h-40 overflow-y-auto">
              <L2NativeUiNotices notices={state.notices} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {state.prefill ? (
        <div className="mb-2 rounded-lg border px-3 py-2" data-testid="native-ui-prefill">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-sm font-medium">{t('nativeUiDraft')}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => model.usePrefill('dismiss')}
            >
              {t('nativeUiDismiss')}
            </Button>
          </div>
          <p className="my-2 max-h-24 overflow-y-auto text-sm whitespace-pre-wrap wrap-anywhere">
            {state.prefill.text}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => model.usePrefill('append')}
            >
              {t('nativeUiAppend')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => model.usePrefill('replace')}
            >
              {t('nativeUiReplace')}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}

export function L2NativeUiExtras({
  snapshot,
  placement
}: {
  snapshot: L4PiUiSnapshot
  placement: 'aboveEditor' | 'belowEditor'
}): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const widgets = Object.entries(snapshot.widgets).filter(
    ([, widget]) => widget.placement === placement
  )
  const statuses = placement === 'belowEditor' ? Object.values(snapshot.statuses) : []
  if (!widgets.length && !statuses.length) return null
  return (
    <div className="my-1.5 space-y-1" data-testid={`native-ui-extras-${placement}`}>
      {widgets.length ? (
        <details className="group">
          <summary className="flex min-h-7 cursor-pointer items-center gap-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ListChecksIcon className="size-3.5" />
            {t('nativeUiInfo')}
            <span>{widgets.length > 1 ? widgets.length : ''}</span>
            <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="max-h-36 space-y-2 overflow-y-auto px-2 pb-2 text-sm leading-6">
            {widgets.map(([key, widget]) => (
              <p key={key} className="whitespace-pre-wrap wrap-anywhere">
                {widget.lines.join('\n')}
              </p>
            ))}
          </div>
        </details>
      ) : null}
      {statuses.length ? (
        <details className="group">
          <summary className="flex min-h-7 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-current" />
            <span className="min-w-0 truncate group-open:hidden">{statuses[0]}</span>
            <span className="hidden group-open:inline">{t('nativeUiStatus')}</span>
            {statuses.length > 1 ? <span>+{statuses.length - 1}</span> : null}
          </summary>
          <div className="max-h-32 space-y-1 overflow-y-auto px-2 py-1 text-sm whitespace-pre-wrap wrap-anywhere">
            {statuses.map((text, index) => (
              <p key={index}>{text}</p>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}
