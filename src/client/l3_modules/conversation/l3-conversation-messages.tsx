'use client'

export { L3ConversationPresentationProvider } from './l3-conversation-plugin-message'

import {
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  FilePenLineIcon,
  FilePlus2Icon,
  FileTextIcon,
  FolderIcon,
  Layers3Icon,
  LoaderCircleIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon
} from 'lucide-react'
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useStickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'
import { useTranslation } from 'react-i18next'
import { L3_CONVERSATION_LOCALE_MESSAGES } from '@common/l3_modules/conversation/l3-conversation-locale-messages'
import type { PluginJsonObject } from '@jetcrab/pi-desk-sdk/browser'
import type { L3ConversationMessageUsage } from '@common/l3_modules/conversation/l3-conversation-contract'
import { readL3ConversationPiDeskCommand } from '@common/l3_modules/conversation/l3-conversation-pidesk'
import { copyL4BrowserText } from '@client/l4_foundation/lib/l4-browser-clipboard'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import {
  useL4PluginHost,
  useL4PluginRegistry
} from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import { L4FileIcon } from '@client/l4_foundation/ui/file-icons/l4-file-icon'
import {
  Message,
  MessageAction,
  MessageContent,
  MessageToolbar
} from '@client/l4_foundation/ui/ai-elements/message'
import { Reasoning, ReasoningTrigger } from '@client/l4_foundation/ui/ai-elements/reasoning'
import { Shimmer } from '@client/l4_foundation/ui/ai-elements/shimmer'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { L4ImageViewer, type L4ImageViewerSlide } from '@client/l4_foundation/ui/l4-image-viewer'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'
import { L3ConversationCallSummary } from './l3-conversation-call-summary'
import { L3ConversationCodemodeCalls } from './l3-conversation-codemode-calls'
import { L3ConversationMarkdown } from './l3-conversation-markdown'
import { L3ConversationMessageView } from './l3-conversation-plugin-message'
import { L3ConversationPiDeskView } from './l3-conversation-pidesk-view'
import styles from './l3-conversation-messages.module.css'
import {
  formatL3ConversationBashToolDuration,
  formatL3ConversationCost,
  formatL3ConversationTimestamp,
  formatL3ConversationTokenCount,
  type L3ConversationDisplayMessage,
  type L3ConversationProcessItem,
  type L3ConversationTurn
} from './l3-conversation-display'

export type L3ConversationLoadDetail = (
  message: L3ConversationDisplayMessage
) => Promise<PluginJsonObject | null>
export type L3ConversationAcquireImage = (
  message: L3ConversationDisplayMessage,
  imageIndex: number
) => { url: string; release: () => void } | Promise<{ url: string; release: () => void }>
export type L3ConversationPreviewFile = (path: string) => void

interface DetailLoadState {
  loading: boolean
  error: string | null
  load: () => Promise<void>
}

const USER_MESSAGE_COLLAPSE_THRESHOLD_LINES = 6
const MESSAGE_COPY_FEEDBACK_MS = 1500
const PROCESS_ITEM_BATCH_SIZE = 64
const TOOL_DETAIL_SCROLL_CLASS =
  'max-h-[min(20rem,45dvh)] overflow-auto overscroll-contain [scrollbar-gutter:stable]'
const L3ConversationBeforeExpandContext = createContext<() => void>(() => undefined)
const L3ConversationFileCwdContext = createContext<string | null>(null)
const L3ConversationImageContext = createContext<L3ConversationAcquireImage | null>(null)
const COLLAPSIBLE_PANEL_MOTION_CLASS =
  'h-[var(--collapsible-panel-height)] overflow-hidden transition-[height,opacity] duration-200 ease-out data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-none'

export function L3ConversationStickToBottomBridge({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const { isAtBottom, stopScroll } = useStickToBottomContext()
  const isAtBottomRef = useRef(isAtBottom)
  const stopScrollRef = useRef(stopScroll)
  useLayoutEffect(() => {
    isAtBottomRef.current = isAtBottom
    stopScrollRef.current = stopScroll
  }, [isAtBottom, stopScroll])
  const beforeExpand = useCallback((): void => {
    if (isAtBottomRef.current) stopScrollRef.current()
  }, [])

  return (
    <L3ConversationBeforeExpandContext.Provider value={beforeExpand}>
      {children}
    </L3ConversationBeforeExpandContext.Provider>
  )
}

function useDetailLoad(
  message: L3ConversationDisplayMessage,
  onLoadDetail: L3ConversationLoadDetail
): DetailLoadState {
  const { t } = useTranslation('conversation')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (
      message.temporary ||
      !message.durable ||
      !message.snapshot.fixed.hasDetail ||
      message.detail !== undefined ||
      loading
    )
      return

    setLoading(true)
    setError(null)
    try {
      await onLoadDetail(message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('detailFailed'))
    } finally {
      setLoading(false)
    }
  }, [loading, message, onLoadDetail, t])

  return { loading, error, load }
}

interface ExpandableDetailState {
  open: boolean
  expandable: boolean
  loading: boolean
  error: string | null
  handleOpenChange: (open: boolean) => void
}

function useExpandableDetail(
  message: L3ConversationDisplayMessage,
  onLoadDetail: L3ConversationLoadDetail
): ExpandableDetailState {
  const [open, setOpen] = useState(false)
  const beforeExpand = useContext(L3ConversationBeforeExpandContext)
  const { loading, error, load } = useDetailLoad(message, onLoadDetail)
  const expandable =
    !message.temporary &&
    (message.summary.hasDetail ||
      (message.summary.type === 'tool' && Boolean(message.summary.images?.length)))

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!expandable) return
    if (nextOpen) {
      beforeExpand()
      void load()
    }
    setOpen(nextOpen)
  }

  return { open, expandable, loading, error, handleOpenChange }
}

function MessageTime({ timestampMs }: { timestampMs: number }): React.JSX.Element {
  const { locale, timeZone } = useL4Region()
  const formatted = formatL3ConversationTimestamp(timestampMs, undefined, locale, timeZone)
  return (
    <time
      dateTime={new Date(timestampMs).toISOString()}
      title={formatted.full}
      className="shrink-0"
    >
      {formatted.compact}
    </time>
  )
}

function MessageCopyAction({
  text,
  copyLabel,
  alwaysVisible = false
}: {
  text: string
  copyLabel?: string
  alwaysVisible?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('conversation')
  const toast = useL4AppToast()
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    }
  }, [])

  const handleCopy = useCallback(async (): Promise<void> => {
    let succeeded = false
    try {
      succeeded = await copyL4BrowserText(text)
    } catch {
      succeeded = false
    }
    if (!succeeded) {
      toast.error(t('messageCopyFailed'))
      return
    }

    setCopied(true)
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null
      setCopied(false)
    }, MESSAGE_COPY_FEEDBACK_MS)
  }, [text, toast, t])

  if (!text.trim()) return null

  const label = copied ? t('copied') : (copyLabel ?? t('copyMessage'))
  return (
    <MessageAction
      tooltip={label}
      label={label}
      size="icon-sm"
      className={cn(!alwaysVisible && styles.messageCopyAction, 'text-muted-foreground')}
      onClick={() => void handleCopy()}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </MessageAction>
  )
}

function ChatUsageText({
  usage,
  compactOnly = false
}: {
  usage: L3ConversationMessageUsage
  compactOnly?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const inputTokens = formatL3ConversationTokenCount(usage.inputTokens)
  const outputTokens = formatL3ConversationTokenCount(usage.outputTokens)
  const cacheReadTokens = formatL3ConversationTokenCount(usage.cacheReadTokens)
  const cost = formatL3ConversationCost(usage.costUsd)
  const labeled = t('usage', {
    input: inputTokens,
    output: outputTokens,
    cached: cacheReadTokens,
    cost
  })
  const compact = `${inputTokens}/${outputTokens}/${cacheReadTokens}/${cost}`

  if (compactOnly) {
    return (
      <span
        className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
        title={labeled}
        aria-label={labeled}
      >
        {compact}
      </span>
    )
  }

  return (
    <span className="min-w-0">
      <span className={styles.usageLabeled}>{labeled}</span>
      <span className={styles.usageCompact}>{compact}</span>
    </span>
  )
}

function AssistantFooter({
  message
}: {
  message: L3ConversationDisplayMessage
}): React.JSX.Element | null {
  if (message.summary.type !== 'assistant' || message.timestampMs === null) return null
  const copyText = message.summary.status !== 'running' ? message.summary.text : null
  return (
    <MessageToolbar
      className={cn(
        styles.usageToolbar,
        'mt-1 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground'
      )}
    >
      {message.usageCalls?.length ? (
        <L3ConversationCallSummary
          key={message.durable!.location.entryId}
          messages={message.usageCalls}
          incomplete={message.usageIncomplete ?? false}
        >
          <ChatUsageText usage={message.summary.usage} />
        </L3ConversationCallSummary>
      ) : (
        <ChatUsageText usage={message.summary.usage} />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {copyText === null ? null : <MessageCopyAction text={copyText} />}
        {message.timestampMs === null ? null : <MessageTime timestampMs={message.timestampMs} />}
      </div>
    </MessageToolbar>
  )
}

type UserMessageImageState =
  { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error' }

interface UserMessageImagePreview {
  slides: L4ImageViewerSlide[]
  index: number
}

function MessageImages({
  message,
  onAcquireImage
}: {
  message: L3ConversationDisplayMessage
  onAcquireImage: L3ConversationAcquireImage
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const metadata =
    message.summary.type === 'user' || message.summary.type === 'tool'
      ? (message.summary.images ?? [])
      : []
  const imageCount = metadata.length
  const messageRef = useRef(message)
  useLayoutEffect(() => {
    messageRef.current = message
  }, [message])
  const [imageStates, setImageStates] = useState<UserMessageImageState[]>(() =>
    Array.from({ length: imageCount }, () => ({ status: 'loading' }))
  )
  const [preview, setPreview] = useState<UserMessageImagePreview | null>(null)
  const [retry, setRetry] = useState(0)

  useLayoutEffect(() => {
    let active = true
    const releases: Array<(() => void) | null> = Array.from({ length: imageCount }, () => null)
    for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
      const ready = (image: Awaited<ReturnType<L3ConversationAcquireImage>>): void => {
        if (!active) {
          image.release()
          return
        }
        releases[imageIndex] = image.release
        setImageStates((current) => {
          const next = [...current]
          next[imageIndex] = { status: 'ready', url: image.url }
          return next
        })
      }
      const failed = (): void => {
        if (!active) return
        setImageStates((current) => {
          const next = [...current]
          next[imageIndex] = { status: 'error' }
          return next
        })
      }
      try {
        const image = onAcquireImage(messageRef.current, imageIndex)
        if ('then' in image) void image.then(ready).catch(failed)
        else ready(image)
      } catch {
        failed()
      }
    }

    return () => {
      active = false
      releases.forEach((release) => release?.())
    }
  }, [
    imageCount,
    message.identity,
    message.tempId,
    message.durable?.location.entryId,
    onAcquireImage,
    retry
  ])

  const openPreview = (targetImageIndex: number): void => {
    const slides: L4ImageViewerSlide[] = []
    let activeIndex = -1

    imageStates.forEach((state, imageIndex) => {
      if (state.status !== 'ready') return
      if (imageIndex === targetImageIndex) activeIndex = slides.length
      const image = metadata[imageIndex]!
      slides.push({
        src: state.url,
        alt: t('chatImage', { count: imageIndex + 1 }),
        width: image.width,
        height: image.height
      })
    })

    if (activeIndex >= 0) setPreview({ slides, index: activeIndex })
  }

  return (
    <>
      <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {metadata.map((image, imageIndex) => {
          const state = imageStates[imageIndex]
          if (state?.status === 'error') {
            return (
              <button
                key={`${imageIndex}:${image.width}:${image.height}`}
                type="button"
                className="flex aspect-square min-h-20 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border bg-muted px-2 text-center text-xs text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setPreview(null)
                  setImageStates((current) =>
                    current.map((imageState) =>
                      imageState.status === 'error' ? { status: 'loading' } : imageState
                    )
                  )
                  setRetry((value) => value + 1)
                }}
              >
                <span>{t('imageUnavailable')}</span>
                <span className="text-sm font-medium text-foreground">
                  {t('retry', { ns: 'common' })}
                </span>
              </button>
            )
          }
          if (state?.status !== 'ready') {
            return (
              <div
                key={`${imageIndex}:${image.width}:${image.height}`}
                className="grid aspect-square min-h-20 place-items-center rounded-md border bg-muted px-2 text-center text-xs text-muted-foreground"
              >
                {t('imageLoading')}
              </div>
            )
          }

          return (
            <button
              key={`${imageIndex}:${image.width}:${image.height}`}
              type="button"
              className="group block aspect-square w-full cursor-zoom-in overflow-hidden rounded-md border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => openPreview(imageIndex)}
              aria-label={t('previewImageNumber', { count: imageIndex + 1 })}
            >
              {/* 图片地址由页面缓存持有，组件卸载只释放展示引用。 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={state.url}
                alt={t('chatImage', { count: imageIndex + 1 })}
                className="aspect-square size-full object-cover transition-transform duration-200 group-hover:scale-[1.02] motion-reduce:transition-none"
              />
            </button>
          )
        })}
      </div>
      {preview ? (
        <L4ImageViewer
          mode="modal"
          open
          slides={preview.slides}
          index={preview.index}
          ariaLabel={t('chatImagePreview')}
          onClose={() => setPreview(null)}
          onIndexChange={(index) =>
            setPreview((current) => (current ? { ...current, index } : current))
          }
        />
      ) : null}
    </>
  )
}

function UserMessageText({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const textRef = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState<boolean | null>(null)
  const beforeExpand = useContext(L3ConversationBeforeExpandContext)

  useLayoutEffect(() => {
    const textElement = textRef.current
    if (!textElement) return

    // 正文保持自然高度，只裁切外层；展开收起不触发正文尺寸测量。
    const observer = new ResizeObserver(([entry]) => {
      // 离屏内容可能被跳过布局，不以零高度覆盖已知的折叠状态。
      if (!entry || entry.contentRect.height === 0) return
      const lineHeight = Number.parseFloat(getComputedStyle(textElement).lineHeight)
      setCollapsible(
        entry.contentRect.height > lineHeight * USER_MESSAGE_COLLAPSE_THRESHOLD_LINES + 1
      )
    })
    observer.observe(textElement)
    return () => observer.disconnect()
  }, [])

  const handleToggle = useCallback((): void => {
    if (!expanded) beforeExpand()
    setExpanded((current) => !current)
  }, [beforeExpand, expanded])

  return (
    <div className="min-w-0">
      <div
        className={cn('relative', !expanded && collapsible !== false && styles.userTextCollapsed)}
      >
        <p ref={textRef} className="whitespace-pre-wrap break-words">
          {text}
        </p>
        {collapsible && !expanded ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-secondary to-transparent"
            aria-hidden="true"
          />
        ) : null}
      </div>
      {collapsible ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={handleToggle}
          className="-mb-1 ml-auto mt-1 flex min-h-7 cursor-pointer items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? t('collapse') : t('expand')}
          <ChevronDownIcon
            className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      ) : null}
    </div>
  )
}

function UserMessage({
  message,
  onAcquireImage
}: {
  message: L3ConversationDisplayMessage
  onAcquireImage: L3ConversationAcquireImage
}): React.JSX.Element {
  if (message.summary.type !== 'user') throw new Error('UserMessage requires a user summary')

  return (
    <Message
      from="user"
      data-message-id={message.identity}
      data-chat-scroll-anchor={`${message.identity}:user`}
      data-chat-user-message=""
      className={cn(styles.copyableMessage, 'max-w-[92%] sm:max-w-[84%]')}
    >
      <MessageContent
        className={cn(styles.userText, 'group-[.is-user]:px-3 group-[.is-user]:py-2')}
      >
        {message.summary.images.length > 0 ? (
          <MessageImages
            key={`${message.tempId}:${message.durable?.location.entryId ?? 'temporary'}`}
            message={message}
            onAcquireImage={onAcquireImage}
          />
        ) : null}
        {message.summary.text ? <UserMessageText text={message.summary.text} /> : null}
      </MessageContent>
      {message.timestampMs === null ? null : (
        <MessageToolbar className="mt-0 justify-end gap-1 text-xs text-muted-foreground">
          <MessageCopyAction text={message.summary.text} />
          <MessageTime timestampMs={message.timestampMs} />
        </MessageToolbar>
      )}
    </Message>
  )
}

function AssistantText({
  message,
  text
}: {
  message: L3ConversationDisplayMessage
  text: string
}): React.JSX.Element {
  const streaming =
    message.temporary &&
    message.summary.type === 'assistant' &&
    message.summary.status === 'running'

  return (
    <Message
      from="assistant"
      data-message-id={message.identity}
      data-chat-scroll-anchor={`${message.identity}:text`}
      className={cn(styles.copyableMessage, 'max-w-full gap-1')}
    >
      <MessageContent className="w-full">
        <L3ConversationMarkdown isAnimating={streaming} mode={streaming ? 'streaming' : 'static'}>
          {text}
        </L3ConversationMarkdown>
      </MessageContent>
      <AssistantFooter message={message} />
    </Message>
  )
}

function AssistantThinkingStatus(): React.JSX.Element {
  const { t } = useTranslation('conversation')
  return (
    <div
      role="status"
      className={cn(
        styles.detailText,
        'flex min-h-9 w-full items-center gap-2 py-1 text-muted-foreground'
      )}
    >
      <BrainIcon className="size-4" aria-hidden="true" />
      <Shimmer as="span" duration={1}>
        {t('thinking')}
      </Shimmer>
    </div>
  )
}

function AssistantReasoningContent({
  content,
  streaming
}: {
  content: string
  streaming: boolean
}): React.JSX.Element {
  const { scrollRef, contentRef } = useStickToBottom({
    initial: streaming ? 'instant' : false,
    resize: 'instant'
  })

  return (
    <div
      ref={scrollRef}
      className="max-h-56 overflow-y-auto pb-2 pr-2 [scrollbar-gutter:stable] sm:max-h-72"
    >
      <div ref={contentRef}>
        <L3ConversationMarkdown isAnimating={streaming} mode={streaming ? 'streaming' : 'static'}>
          {content}
        </L3ConversationMarkdown>
      </div>
    </div>
  )
}

function AssistantReasoning({
  message,
  detailLoad
}: {
  message: L3ConversationDisplayMessage
  detailLoad: DetailLoadState
}): React.JSX.Element | null {
  const { t } = useTranslation('conversation')
  if (message.summary.type !== 'assistant') return null

  const { loading, error, load } = detailLoad
  const detailLoaded = message.detail !== undefined
  const detail = message.detail?.type === 'assistant' ? message.detail : null
  const thinking = detail?.thinking ?? ''
  const hasThinking = thinking.trim().length > 0
  const thinkingStreaming =
    hasThinking &&
    message.temporary &&
    message.summary.status === 'running' &&
    message.summary.text.trim().length === 0
  const mayHaveThinking = hasThinking || (!detailLoaded && message.summary.hasDetail)

  if (!mayHaveThinking) return null

  const content = thinking || (loading ? t('thinkingLoading') : (error ?? t('thinkingUnavailable')))

  return (
    <Reasoning
      className="mb-0 w-full"
      isStreaming={thinkingStreaming}
      onOpenChange={(open) => {
        if (open) void load()
      }}
    >
      <ReasoningTrigger
        className={cn(styles.detailText, 'min-h-9 justify-start py-1')}
        getThinkingMessage={(streaming) =>
          streaming ? (
            <Shimmer as="span" duration={1}>
              {t('thinking')}
            </Shimmer>
          ) : (
            <span>{t('thinkingProcess')}</span>
          )
        }
      />
      <CollapsibleContent
        className={cn(
          COLLAPSIBLE_PANEL_MOTION_CLASS,
          'text-sm leading-6 text-muted-foreground outline-none'
        )}
      >
        <div className="pt-2">
          <div className="border-l pl-4">
            <AssistantReasoningContent content={content} streaming={thinkingStreaming} />
          </div>
        </div>
      </CollapsibleContent>
    </Reasoning>
  )
}

function localizedAssistantError(
  errorMessage: string | null,
  locale: 'en' | 'zh-CN'
): string | null {
  const normalized = errorMessage?.trim()
  if (!normalized) return null

  switch (normalized.toLowerCase()) {
    case 'terminated':
      return L3_CONVERSATION_LOCALE_MESSAGES[locale].streamInterrupted
    case 'request timed out':
    case 'request timed out.':
      return L3_CONVERSATION_LOCALE_MESSAGES[locale].requestTimedOut
    default:
      return errorMessage
  }
}

function AssistantError({
  message
}: {
  message: L3ConversationDisplayMessage
}): React.JSX.Element | null {
  const { t } = useTranslation('conversation')
  const { locale } = useL4Region()
  if (message.summary.type !== 'assistant') return null
  const errorMessage =
    localizedAssistantError(message.summary.errorMessage, locale) ??
    (message.summary.status === 'error' ? t('modelFailed') : null)
  if (!errorMessage) return null

  return (
    <pre
      className={cn(
        styles.toolOutput,
        'whitespace-pre-wrap break-words rounded-lg border border-destructive/40 bg-muted p-3 font-sans text-destructive'
      )}
    >
      {errorMessage}
    </pre>
  )
}

function AssistantProcessItem({
  item,
  onLoadDetail
}: {
  item: L3ConversationProcessItem
  onLoadDetail: L3ConversationLoadDetail
}): React.JSX.Element {
  const { message, hideAssistantText } = item
  const detailLoad = useDetailLoad(message, onLoadDetail)
  if (message.summary.type !== 'assistant') {
    throw new Error('AssistantProcessItem requires an assistant summary')
  }

  return (
    <div
      className="space-y-2"
      data-message-id={message.identity}
      data-chat-scroll-anchor={`${message.identity}:process`}
    >
      <AssistantReasoning message={message} detailLoad={detailLoad} />
      {hideAssistantText || !message.summary.text.trim() ? null : (
        <AssistantText message={message} text={message.summary.text} />
      )}
      <AssistantError message={message} />
    </div>
  )
}

function ToolIcon({
  name,
  filePath,
  className
}: {
  name: string
  filePath: string | null
  className?: string
}): React.JSX.Element {
  const normalized = name.toLowerCase().split('.').at(-1) ?? name.toLowerCase()
  const props = { className }
  switch (normalized) {
    case 'read':
      return filePath ? <L4FileIcon path={filePath} {...props} /> : <FileTextIcon {...props} />
    case 'write':
      return <FilePlus2Icon {...props} />
    case 'edit':
      return <FilePenLineIcon {...props} />
    case 'bash':
      return <TerminalIcon {...props} />
    case 'grep':
    case 'find':
      return <SearchIcon {...props} />
    case 'ls':
      return <FolderIcon {...props} />
    case 'agent':
    case 'agent_resume':
      return <BotIcon {...props} />
    default:
      return <WrenchIcon {...props} />
  }
}

interface ToolCardDetailState {
  loading: boolean
  error: string | null
}

interface ToolFilePathDisplay {
  fileStem: string
  fileExtension: string
  directory: string | null
  fullPath: string
}

function normalizeToolFilePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized
  return normalized.replace(/\/+$/, '')
}

function isAbsoluteToolFilePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value)
}

function resolveToolFilePath(
  path: string,
  cwd: string | null
): {
  compactPath: string
  fullPath: string
} {
  const normalizedPath = normalizeToolFilePath(path)
  if (!cwd) return { compactPath: normalizedPath, fullPath: normalizedPath }

  const normalizedCwd = normalizeToolFilePath(cwd)
  if (!isAbsoluteToolFilePath(normalizedPath)) {
    const compactPath = normalizedPath.replace(/^(?:\.\/)+/, '')
    const cwdPrefix = normalizedCwd.endsWith('/') ? normalizedCwd : `${normalizedCwd}/`
    return { compactPath, fullPath: `${cwdPrefix}${compactPath}` }
  }

  const cwdPrefix = normalizedCwd.endsWith('/') ? normalizedCwd : `${normalizedCwd}/`
  const caseInsensitive = /^[A-Za-z]:\//.test(normalizedPath) && /^[A-Za-z]:\//.test(normalizedCwd)
  const comparablePath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath
  const comparableCwdPrefix = caseInsensitive ? cwdPrefix.toLowerCase() : cwdPrefix
  if (comparablePath.startsWith(comparableCwdPrefix)) {
    return {
      compactPath: normalizedPath.slice(cwdPrefix.length),
      fullPath: normalizedPath
    }
  }

  return { compactPath: normalizedPath, fullPath: normalizedPath }
}

function toolFilePathDisplay(path: string, cwd: string | null): ToolFilePathDisplay {
  const { compactPath, fullPath } = resolveToolFilePath(path, cwd)
  const driveRoot = compactPath.match(/^[A-Za-z]:\//)?.[0] ?? null
  const root = driveRoot ?? (compactPath.startsWith('/') ? '/' : '')
  const segments = compactPath.slice(root.length).split('/').filter(Boolean)
  const fileName = segments.pop() ?? compactPath
  const extensionStart = fileName.lastIndexOf('.')
  const directory =
    segments.length > 2 ? `…/${segments.slice(-2).join('/')}` : `${root}${segments.join('/')}`

  return {
    fileStem: extensionStart > 0 ? fileName.slice(0, extensionStart) : fileName,
    fileExtension: extensionStart > 0 ? fileName.slice(extensionStart) : '',
    directory: directory || null,
    fullPath
  }
}

function BashToolElapsedTime({
  status,
  timing
}: {
  status: 'running' | 'completed' | 'error'
  timing: Extract<L3ConversationDisplayMessage['summary'], { type: 'tool'; kind: 'bash' }>['timing']
}): React.JSX.Element | null {
  const startedAtMs = timing && 'startedAtMs' in timing ? timing.startedAtMs : null
  const durationMs = timing && 'durationMs' in timing ? timing.durationMs : null
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (status !== 'running' || startedAtMs === null) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAtMs, status])

  const elapsedMs = durationMs ?? (startedAtMs === null ? null : Math.max(0, nowMs - startedAtMs))
  if (elapsedMs === null) return null
  return <>{formatL3ConversationBashToolDuration(elapsedMs)}</>
}

function ToolCardShell({
  message,
  onLoadDetail,
  previewPath,
  onPreviewFile,
  renderDetail
}: {
  message: L3ConversationDisplayMessage
  onLoadDetail: L3ConversationLoadDetail
  previewPath: string | null
  onPreviewFile?: L3ConversationPreviewFile
  renderDetail: (state: ToolCardDetailState) => ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  if (message.summary.type !== 'tool' && message.summary.type !== 'bash') {
    throw new Error('ToolCardShell requires a tool or bash summary')
  }

  const cwd = useContext(L3ConversationFileCwdContext)
  const onAcquireImage = useContext(L3ConversationImageContext)
  const hasImages =
    !message.temporary && message.summary.type === 'tool' && Boolean(message.summary.images?.length)
  const { open, expandable, loading, error, handleOpenChange } = useExpandableDetail(
    message,
    onLoadDetail
  )
  const display =
    message.summary.type === 'tool'
      ? {
          name: message.summary.name,
          reasoning: message.summary.reasoning,
          inputPreview: message.summary.inputPreview,
          activity: message.summary.activity,
          usage: message.summary.usage
        }
      : {
          name: 'bash',
          reasoning: null,
          inputPreview: message.summary.command,
          activity: null,
          usage: null
        }
  const { name, reasoning, inputPreview, activity, usage } = display
  const bashSummary =
    message.summary.type === 'tool' && message.summary.kind === 'bash' ? message.summary : null
  const failed = message.summary.status === 'error'
  const previewable = !message.temporary && previewPath !== null && onPreviewFile !== undefined
  const filePathDisplay = previewPath ? toolFilePathDisplay(previewPath, cwd) : null

  return (
    <Collapsible
      open={expandable && open}
      onOpenChange={handleOpenChange}
      className={cn(
        styles.detailText,
        'w-full overflow-hidden rounded-lg border bg-muted/45 dark:bg-card',
        failed ? 'border-destructive' : 'border-border'
      )}
      data-message-id={message.identity}
      data-chat-scroll-anchor={`${message.identity}:tool`}
    >
      <div className="relative">
        <CollapsibleTrigger
          disabled={!expandable}
          className={cn(
            'relative grid min-h-14 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 px-3 py-1.5 text-left',
            expandable &&
              'cursor-pointer hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
          )}
          aria-label={
            expandable ? t(open ? 'collapseTool' : 'expandTool', { name }) : t('tool', { name })
          }
        >
          <ToolIcon
            name={name}
            filePath={previewPath}
            className="col-start-1 row-start-1 size-4 text-muted-foreground"
          />
          <span className="col-start-2 row-start-1 flex min-h-7 min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono font-medium">{name}</span>
            {reasoning ? (
              <span className="min-w-0 flex-1 truncate text-foreground">{reasoning}</span>
            ) : null}
            {usage ? <ChatUsageText usage={usage} compactOnly /> : null}
          </span>
          <span className="col-start-3 row-start-1 flex min-h-7 items-center justify-end gap-2">
            {/* 预览按钮独立于折叠触发器，此处只保留它在首行的位置。 */}
            {previewable ? <span className="size-7" aria-hidden="true" /> : null}
            {expandable ? (
              <span className="flex size-7 items-center justify-center" aria-hidden="true">
                <ChevronDownIcon
                  data-tool-disclosure=""
                  className={cn(
                    'size-4 text-muted-foreground transition-transform',
                    open && 'rotate-180'
                  )}
                />
              </span>
            ) : null}
          </span>
          {filePathDisplay ? (
            <span
              className={cn(
                styles.toolFilePath,
                'col-start-2 row-start-2 flex min-w-0 items-baseline overflow-hidden font-mono text-xs'
              )}
              title={filePathDisplay.fullPath}
            >
              <span className="flex min-w-0 max-w-full shrink-0 items-baseline text-foreground">
                <span className="min-w-0 truncate">{filePathDisplay.fileStem}</span>
                <span className="shrink-0">{filePathDisplay.fileExtension}</span>
              </span>
              {filePathDisplay.directory ? (
                <span
                  className={cn(styles.toolFileDirectory, 'min-w-0 truncate text-muted-foreground')}
                >
                  {' · '}
                  {filePathDisplay.directory}
                </span>
              ) : null}
            </span>
          ) : inputPreview ? (
            <span className="col-start-2 row-start-2 truncate font-mono text-xs text-muted-foreground">
              {inputPreview}
            </span>
          ) : null}
          {bashSummary?.timing ? (
            <span className="col-start-3 row-start-2 text-right font-mono text-xs tabular-nums whitespace-nowrap text-muted-foreground">
              <BashToolElapsedTime status={bashSummary.status} timing={bashSummary.timing} />
            </span>
          ) : activity ? (
            <span
              className="col-start-3 row-start-2 max-w-36 truncate text-right font-mono text-xs tabular-nums text-muted-foreground"
              title={activity}
            >
              {activity}
            </span>
          ) : null}
        </CollapsibleTrigger>
        {previewable ? (
          <button
            type="button"
            title={t('previewFile')}
            aria-label={t('previewFilePath', { path: previewPath })}
            onClick={() => onPreviewFile(previewPath)}
            className={cn(
              'absolute top-1.5 flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              expandable ? 'right-12' : 'right-3'
            )}
          >
            <ExternalLinkIcon className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <CollapsibleContent className={COLLAPSIBLE_PANEL_MOTION_CLASS}>
        <div className="border-t">
          {filePathDisplay ? (
            <p className="border-b px-3 py-2 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {filePathDisplay.fullPath}
            </p>
          ) : null}
          {open && hasImages && onAcquireImage ? (
            <div className="px-3 pt-3">
              <MessageImages message={message} onAcquireImage={onAcquireImage} />
            </div>
          ) : null}
          {renderDetail({ loading, error })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolDetailMessage({
  children,
  destructive = false
}: {
  children: ReactNode
  destructive?: boolean
}): React.JSX.Element {
  return (
    <p
      className={cn(
        styles.detailText,
        'px-3 py-3',
        destructive ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {children}
    </p>
  )
}

function GenericToolResult({
  message,
  loading,
  error
}: {
  message: L3ConversationDisplayMessage
  loading: boolean
  error: string | null
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const detail =
    message.detail?.type === 'bash' ||
    (message.detail?.type === 'tool' &&
      (message.detail.kind === 'generic' ||
        message.detail.kind === 'bash' ||
        message.detail.kind === 'codemode'))
      ? message.detail
      : null
  const output = detail?.output ?? ''
  if (loading) return <ToolDetailMessage>{t('loadingResult')}</ToolDetailMessage>
  if (error) return <ToolDetailMessage destructive>{error}</ToolDetailMessage>
  if (!output)
    return message.summary.type === 'tool' && message.summary.images?.length ? (
      <></>
    ) : (
      <ToolDetailMessage>{t('emptyResult')}</ToolDetailMessage>
    )
  return (
    <pre
      role="region"
      aria-label={t('toolOutput')}
      tabIndex={0}
      className={cn(
        TOOL_DETAIL_SCROLL_CLASS,
        styles.toolOutput,
        'whitespace-pre-wrap break-words px-3 py-3 font-mono'
      )}
    >
      {output}
    </pre>
  )
}

function ReadToolResult({
  message,
  loading,
  error
}: {
  message: L3ConversationDisplayMessage
  loading: boolean
  error: string | null
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const detail =
    message.detail?.type === 'tool' && message.detail.kind === 'read' ? message.detail : null
  if (loading) return <ToolDetailMessage>{t('loadingRead')}</ToolDetailMessage>
  if (error) return <ToolDetailMessage destructive>{error}</ToolDetailMessage>
  if (!detail)
    return message.summary.type === 'tool' && message.summary.images?.length ? (
      <></>
    ) : (
      <ToolDetailMessage>{t('readUnavailable')}</ToolDetailMessage>
    )
  if (!detail.content) return <ToolDetailMessage>{t('readEmpty')}</ToolDetailMessage>
  return (
    <pre
      role="region"
      aria-label={t('readContent')}
      tabIndex={0}
      className={cn(
        TOOL_DETAIL_SCROLL_CLASS,
        styles.toolOutput,
        styles.toolCode,
        'px-3 py-3 font-mono'
      )}
    >
      {detail.content}
    </pre>
  )
}

function DiffContent({ content }: { content: string }): React.JSX.Element {
  const { t } = useTranslation('conversation')
  return (
    <div
      role="region"
      aria-label={t('editDiff')}
      tabIndex={0}
      className={cn(TOOL_DETAIL_SCROLL_CLASS, styles.toolOutput, 'font-mono')}
    >
      {content.split('\n').map((line, index) => {
        const lineClass = line.startsWith('+')
          ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
          : line.startsWith('-')
            ? 'bg-red-500/10 text-red-800 dark:text-red-200'
            : line.trimEnd().endsWith('...')
              ? 'bg-muted/40 text-muted-foreground'
              : 'text-foreground'
        return (
          <span
            key={index}
            className={cn(styles.toolCode, styles.toolCodeLine, 'block px-3', lineClass)}
          >
            {line || ' '}
          </span>
        )
      })}
    </div>
  )
}

function EditToolResult({
  message,
  loading,
  error
}: {
  message: L3ConversationDisplayMessage
  loading: boolean
  error: string | null
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const detail =
    message.detail?.type === 'tool' && message.detail.kind === 'edit' ? message.detail : null
  if (loading) return <ToolDetailMessage>{t('loadingDiff')}</ToolDetailMessage>
  if (error) return <ToolDetailMessage destructive>{error}</ToolDetailMessage>
  if (!detail) return <ToolDetailMessage>{t('diffUnavailable')}</ToolDetailMessage>
  if (detail.contentKind === 'diff') return <DiffContent content={detail.content} />
  return (
    <pre
      role="region"
      aria-label={t('editResult')}
      tabIndex={0}
      className={cn(
        TOOL_DETAIL_SCROLL_CLASS,
        styles.toolOutput,
        'whitespace-pre-wrap break-words px-3 py-3 font-mono',
        message.summary.type === 'tool' && message.summary.status === 'error' && 'text-destructive'
      )}
    >
      {detail.content}
    </pre>
  )
}

function WriteToolResult({
  message,
  loading,
  error
}: {
  message: L3ConversationDisplayMessage
  loading: boolean
  error: string | null
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const detail =
    message.detail?.type === 'tool' && message.detail.kind === 'write' ? message.detail : null
  if (loading) return <ToolDetailMessage>{t('loadingWrite')}</ToolDetailMessage>
  if (error) return <ToolDetailMessage destructive>{error}</ToolDetailMessage>
  if (!detail) return <ToolDetailMessage>{t('writeUnavailable')}</ToolDetailMessage>
  if (detail.contentKind === 'content' && !detail.content) {
    return <ToolDetailMessage>{t('writeEmpty')}</ToolDetailMessage>
  }
  return (
    <pre
      role="region"
      aria-label={t(detail.contentKind === 'content' ? 'writeContent' : 'writeResult')}
      tabIndex={0}
      className={cn(
        TOOL_DETAIL_SCROLL_CLASS,
        styles.toolOutput,
        'px-3 py-3 font-mono',
        detail.contentKind === 'content' ? styles.toolCode : 'whitespace-pre-wrap break-words',
        detail.contentKind === 'output' &&
          message.summary.type === 'tool' &&
          message.summary.status === 'error' &&
          'text-destructive'
      )}
    >
      {detail.content}
    </pre>
  )
}

function PiDeskToolView({
  message,
  onLoadDetail
}: {
  message: L3ConversationDisplayMessage
  onLoadDetail: L3ConversationLoadDetail
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const { open, expandable, loading, error, handleOpenChange } = useExpandableDetail(
    message,
    onLoadDetail
  )
  if (message.summary.type !== 'tool' || message.summary.kind !== 'pidesk') {
    throw new Error('PiDeskToolView requires a pidesk summary')
  }
  const command = readL3ConversationPiDeskCommand(message.summary.input)
  const output =
    message.detail?.type === 'tool' && message.detail.kind === 'pidesk'
      ? message.detail.output
      : null
  return (
    <L3ConversationPiDeskView
      identity={message.identity}
      command={command}
      output={output}
      expandable={expandable}
      open={open}
      loading={loading}
      error={error}
      onOpenChange={handleOpenChange}
      commandAction={
        <MessageCopyAction
          text={command.command}
          copyLabel={t('pidesk.copyCommand')}
          alwaysVisible
        />
      }
      outputAction={
        output ? (
          <MessageCopyAction text={output} copyLabel={t('pidesk.copyOutput')} alwaysVisible />
        ) : null
      }
    />
  )
}

function GenericToolView({
  message,
  onLoadDetail
}: {
  message: L3ConversationDisplayMessage
  onLoadDetail: L3ConversationLoadDetail
}): React.JSX.Element {
  return (
    <ToolCardShell
      message={message}
      onLoadDetail={onLoadDetail}
      previewPath={null}
      renderDetail={(state) => (
        <>
          <GenericToolResult message={message} {...state} />
          {message.detail?.type === 'tool' &&
          message.detail.kind === 'codemode' &&
          message.detail.nestedCalls ? (
            <L3ConversationCodemodeCalls nestedCalls={message.detail.nestedCalls} />
          ) : null}
        </>
      )}
    />
  )
}

function BashToolView({
  message,
  onLoadDetail
}: {
  message: L3ConversationDisplayMessage
  onLoadDetail: L3ConversationLoadDetail
}): React.JSX.Element {
  return <GenericToolView message={message} onLoadDetail={onLoadDetail} />
}

function ReadToolView({
  message,
  onLoadDetail,
  onPreviewFile
}: {
  message: L3ConversationDisplayMessage
  onLoadDetail: L3ConversationLoadDetail
  onPreviewFile?: L3ConversationPreviewFile
}): React.JSX.Element {
  if (message.summary.type !== 'tool' || message.summary.kind !== 'read') {
    throw new Error('ReadToolView requires a read summary')
  }
  return (
    <ToolCardShell
      message={message}
      onLoadDetail={onLoadDetail}
      previewPath={message.summary.path}
      onPreviewFile={onPreviewFile}
      renderDetail={(state) => <ReadToolResult message={message} {...state} />}
    />
  )
}

function EditToolView({
  message,
  onLoadDetail,
  onPreviewFile
}: {
  message: L3ConversationDisplayMessage
  onLoadDetail: L3ConversationLoadDetail
  onPreviewFile?: L3ConversationPreviewFile
}): React.JSX.Element {
  if (message.summary.type !== 'tool' || message.summary.kind !== 'edit') {
    throw new Error('EditToolView requires an edit summary')
  }
  return (
    <ToolCardShell
      message={message}
      onLoadDetail={onLoadDetail}
      previewPath={message.summary.path}
      onPreviewFile={onPreviewFile}
      renderDetail={(state) => <EditToolResult message={message} {...state} />}
    />
  )
}

function WriteToolView({
  message,
  onLoadDetail,
  onPreviewFile
}: {
  message: L3ConversationDisplayMessage
  onLoadDetail: L3ConversationLoadDetail
  onPreviewFile?: L3ConversationPreviewFile
}): React.JSX.Element {
  if (message.summary.type !== 'tool' || message.summary.kind !== 'write') {
    throw new Error('WriteToolView requires a write summary')
  }
  return (
    <ToolCardShell
      message={message}
      onLoadDetail={onLoadDetail}
      previewPath={message.summary.path}
      onPreviewFile={onPreviewFile}
      renderDetail={(state) => <WriteToolResult message={message} {...state} />}
    />
  )
}

function CustomMessage({ message }: { message: L3ConversationDisplayMessage }): React.JSX.Element {
  const { t } = useTranslation('conversation')
  if (message.summary.type !== 'custom') throw new Error('CustomMessage requires a custom summary')
  return (
    <div
      data-message-id={message.identity}
      data-chat-scroll-anchor={`${message.identity}:custom`}
      className={cn(
        styles.toolOutput,
        'rounded-lg border-l-2 bg-muted px-3 py-2 text-muted-foreground'
      )}
    >
      {message.summary.text || t('emptyMessage')}
    </div>
  )
}

function CompactionMessage({
  message,
  onLoadDetail
}: {
  message: L3ConversationDisplayMessage
  onLoadDetail: L3ConversationLoadDetail
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  if (message.summary.type !== 'compaction') {
    throw new Error('CompactionMessage requires a compaction summary')
  }

  const { open, expandable, loading, error, handleOpenChange } = useExpandableDetail(
    message,
    onLoadDetail
  )
  const detail = message.detail?.type === 'compaction' ? message.detail : null

  return (
    <Collapsible
      open={expandable && open}
      onOpenChange={handleOpenChange}
      className="w-full py-1"
      data-message-id={message.identity}
      data-chat-scroll-anchor={`${message.identity}:compaction`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="h-px min-w-3 flex-1 bg-border/70" aria-hidden="true" />
        <CollapsibleTrigger
          disabled={!expandable}
          aria-label={
            expandable
              ? `${t(open ? 'collapse' : 'expand')} ${t('compactionSummary')}`
              : message.temporary
                ? t('compactionRunning')
                : t('compactionComplete')
          }
          className={cn(
            'inline-flex min-h-8 max-w-full items-center gap-2 rounded-full border border-border/70 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors',
            expandable
              ? 'hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
              : 'cursor-default'
          )}
        >
          {message.temporary ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Layers3Icon className="size-3.5" aria-hidden="true" />
          )}
          <span>{message.temporary ? t('compactionRunning') : t('compactionComplete')}</span>
          {expandable ? (
            <ChevronDownIcon
              className={cn('size-3.5 transition-transform', open && 'rotate-180')}
              aria-hidden="true"
            />
          ) : null}
        </CollapsibleTrigger>
        <span className="h-px min-w-3 flex-1 bg-border/70" aria-hidden="true" />
      </div>
      <CollapsibleContent className={COLLAPSIBLE_PANEL_MOTION_CLASS}>
        <div className="pt-2">
          <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-3 sm:px-4">
            <div
              role="region"
              aria-label={t('compactionSummaryContent')}
              tabIndex={0}
              className="max-h-80 overflow-y-auto pr-2 [scrollbar-gutter:stable]"
            >
              {loading ? (
                <p className="text-sm text-muted-foreground">{t('compactionLoading')}</p>
              ) : error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : detail?.text ? (
                <L3ConversationMarkdown isAnimating={false} mode="static">
                  {detail.text}
                </L3ConversationMarkdown>
              ) : (
                <p className="text-sm text-muted-foreground">{t('compactionUnavailable')}</p>
              )}
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ProcessItemComponent({
  item,
  onLoadDetail,
  onAcquireImage,
  onPreviewFile
}: {
  item: L3ConversationProcessItem
  onLoadDetail: L3ConversationLoadDetail
  onAcquireImage: L3ConversationAcquireImage
  onPreviewFile?: L3ConversationPreviewFile
}): React.JSX.Element {
  const defaultView = (() => {
    switch (item.message.summary.type) {
      case 'assistant':
        return <AssistantProcessItem item={item} onLoadDetail={onLoadDetail} />
      case 'tool':
        switch (item.message.summary.kind) {
          case 'pidesk':
            return <PiDeskToolView message={item.message} onLoadDetail={onLoadDetail} />
          case 'read':
            return (
              <ReadToolView
                message={item.message}
                onLoadDetail={onLoadDetail}
                onPreviewFile={onPreviewFile}
              />
            )
          case 'edit':
            return (
              <EditToolView
                message={item.message}
                onLoadDetail={onLoadDetail}
                onPreviewFile={onPreviewFile}
              />
            )
          case 'write':
            return (
              <WriteToolView
                message={item.message}
                onLoadDetail={onLoadDetail}
                onPreviewFile={onPreviewFile}
              />
            )
          case 'bash':
          case 'codemode':
          case 'generic':
            return <GenericToolView message={item.message} onLoadDetail={onLoadDetail} />
        }
      case 'bash':
        return <BashToolView message={item.message} onLoadDetail={onLoadDetail} />
      case 'custom':
        return <CustomMessage message={item.message} />
      case 'compaction':
        return <CompactionMessage message={item.message} onLoadDetail={onLoadDetail} />
      case 'user':
        return <UserMessage message={item.message} onAcquireImage={onAcquireImage} />
    }
  })()
  return (
    <L3ConversationMessageView
      message={item.message}
      loadDetail={onLoadDetail}
      defaultView={defaultView}
    />
  )
}

const ProcessItem = memo(
  ProcessItemComponent,
  (previous, next) =>
    previous.onLoadDetail === next.onLoadDetail &&
    previous.onAcquireImage === next.onAcquireImage &&
    previous.onPreviewFile === next.onPreviewFile &&
    previous.item.hideAssistantText === next.item.hideAssistantText &&
    sameDisplayMessage(previous.item.message, next.item.message)
)

function ProcessItemWindow({
  items,
  onLoadDetail,
  onAcquireImage,
  onPreviewFile
}: {
  items: readonly L3ConversationProcessItem[]
  onLoadDetail: L3ConversationLoadDetail
  onAcquireImage: L3ConversationAcquireImage
  onPreviewFile?: L3ConversationPreviewFile
}): React.JSX.Element {
  const { scrollRef } = useStickToBottomContext()
  const containerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const previousLengthRef = useRef(items.length)
  const pendingAnchorRef = useRef<{ identity: string; offset: number } | null>(null)
  const [capacity, setCapacity] = useState(() => Math.min(PROCESS_ITEM_BATCH_SIZE, items.length))
  const startIndex = Math.max(0, items.length - capacity)
  const hasEarlier = startIndex > 0

  const loadEarlier = useCallback((): void => {
    if (!hasEarlier) return
    const scrollElement = scrollRef.current
    const firstItem = containerRef.current?.querySelector<HTMLElement>('[data-chat-process-item]')
    if (scrollElement && firstItem?.dataset.chatProcessItem) {
      pendingAnchorRef.current = {
        identity: firstItem.dataset.chatProcessItem,
        offset: firstItem.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top
      }
    }
    setCapacity((current) => Math.min(items.length, current + PROCESS_ITEM_BATCH_SIZE))
  }, [hasEarlier, items.length, scrollRef])

  useLayoutEffect(() => {
    const previousLength = previousLengthRef.current
    previousLengthRef.current = items.length
    if (capacity >= previousLength && capacity < items.length) setCapacity(items.length)
  }, [capacity, items.length])

  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current
    if (!pending) return
    const scrollElement = scrollRef.current
    const target = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>('[data-chat-process-item]') ?? []
    ).find((item) => item.dataset.chatProcessItem === pending.identity)
    pendingAnchorRef.current = null
    if (!scrollElement || !target) return
    const nextOffset =
      target.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top
    scrollElement.scrollTop += nextOffset - pending.offset
  }, [startIndex, scrollRef])

  useEffect(() => {
    const root = scrollRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel || !hasEarlier) return
    const nearTop = (): boolean => {
      const rootTop = root.getBoundingClientRect().top
      const sentinelTop = sentinel.getBoundingClientRect().top
      return sentinelTop >= rootTop - 96 && sentinelTop <= rootTop + 96
    }
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0 && nearTop()) loadEarlier()
    }
    const handleTouchMove = (): void => {
      if (nearTop()) loadEarlier()
    }
    root.addEventListener('wheel', handleWheel, { passive: true })
    root.addEventListener('touchmove', handleTouchMove, { passive: true })
    return () => {
      root.removeEventListener('wheel', handleWheel)
      root.removeEventListener('touchmove', handleTouchMove)
    }
  }, [hasEarlier, loadEarlier, scrollRef])

  return (
    <div ref={containerRef}>
      {hasEarlier ? (
        <div ref={sentinelRef} className="h-px" data-chat-process-history aria-hidden="true" />
      ) : null}
      {items.slice(startIndex).map((item, relativeIndex) => {
        const index = startIndex + relativeIndex
        const previous = items[index - 1]
        const followsAssistantText =
          previous?.message.summary.type === 'assistant' &&
          !previous.hideAssistantText &&
          Boolean(previous.message.summary.text.trim())
        const marginClass = followsAssistantText ? 'mt-5' : 'mt-2'

        return (
          <div
            key={item.message.identity}
            data-chat-process-item={item.message.identity}
            className={index > 0 ? marginClass : undefined}
          >
            <ProcessItem
              item={item}
              onLoadDetail={onLoadDetail}
              onAcquireImage={onAcquireImage}
              onPreviewFile={onPreviewFile}
            />
          </div>
        )
      })}
    </div>
  )
}

function ProcessGroupComponent({
  turn,
  onLoadDetail,
  onAcquireImage,
  onPreviewFile
}: {
  turn: L3ConversationTurn
  onLoadDetail: L3ConversationLoadDetail
  onAcquireImage: L3ConversationAcquireImage
  onPreviewFile?: L3ConversationPreviewFile
}): React.JSX.Element | null {
  const { t } = useTranslation('conversation')
  const [manualOpen, setManualOpen] = useState(false)
  const beforeExpand = useContext(L3ConversationBeforeExpandContext)
  const runtime = useL4PluginHost()
  useL4PluginRegistry()
  // 只有内置助手视图能拆分正文和过程；插件视图及其错误只在最终回复位置展示一次。
  const processItems = turn.processItems.filter(
    (item) =>
      !item.hideAssistantText ||
      (item.message.viewKey === 'pi-desk/assistant' &&
        runtime.getMessageViewResolution(item.message.viewKey) === null)
  )
  const open = turn.running || manualOpen
  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      if (turn.running) return
      // 先退出外层吸底，避免高度动画将展开触发器向上顶出视口。
      if (nextOpen) beforeExpand()
      setManualOpen(nextOpen)
    },
    [beforeExpand, turn.running]
  )

  if (processItems.length === 0) return null

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} className="w-full">
      <CollapsibleTrigger
        className={cn(
          styles.detailText,
          'flex min-h-9 w-full cursor-pointer items-center gap-2 py-1 text-left text-muted-foreground hover:text-foreground'
        )}
      >
        <span className="flex-1">
          {t('processGroup')}
          {turn.toolCount > 0 ? ` · ${t('toolCalls', { count: turn.toolCount })}` : ''}
        </span>
        <ChevronDownIcon className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className={COLLAPSIBLE_PANEL_MOTION_CLASS}>
        <div className="pt-2">
          <ProcessItemWindow
            items={processItems}
            onLoadDetail={onLoadDetail}
            onAcquireImage={onAcquireImage}
            onPreviewFile={onPreviewFile}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const ProcessGroup = memo(
  ProcessGroupComponent,
  (previous, next) =>
    previous.onLoadDetail === next.onLoadDetail &&
    previous.onAcquireImage === next.onAcquireImage &&
    previous.onPreviewFile === next.onPreviewFile &&
    previous.turn.running === next.turn.running &&
    previous.turn.toolCount === next.turn.toolCount &&
    sameProcessItems(previous.turn.processItems, next.turn.processItems)
)

interface L3ConversationTurnViewProps {
  turn: L3ConversationTurn
  cwd: string
  logicalTail?: boolean
  onLoadDetail: L3ConversationLoadDetail
  onAcquireImage: L3ConversationAcquireImage
  onPreviewFile?: L3ConversationPreviewFile
}

function sameDisplayMessage(
  left: L3ConversationDisplayMessage | null,
  right: L3ConversationDisplayMessage | null
): boolean {
  if (left === right) return true
  if (!left || !right || left.identity !== right.identity) return false
  if (left.durable || right.durable) {
    return (
      left.durable === right.durable &&
      left.usageIncomplete === right.usageIncomplete &&
      (left.usageCalls?.length ?? 0) === (right.usageCalls?.length ?? 0) &&
      (left.usageCalls ?? []).every(
        (message, index) => message.durable === right.usageCalls?.[index]?.durable
      )
    )
  }
  return (
    left.tempId === right.tempId &&
    left.summary === right.summary &&
    left.detail === right.detail &&
    left.timestampMs === right.timestampMs
  )
}

function sameProcessItems(
  left: readonly L3ConversationProcessItem[],
  right: readonly L3ConversationProcessItem[]
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      item.hideAssistantText === other.hideAssistantText &&
      sameDisplayMessage(item.message, other.message)
    )
  })
}

function sameTurn(left: L3ConversationTurn, right: L3ConversationTurn): boolean {
  if (left === right) return true
  return (
    left.identity === right.identity &&
    left.running === right.running &&
    left.toolCount === right.toolCount &&
    sameDisplayMessage(left.user, right.user) &&
    sameDisplayMessage(left.finalAssistant, right.finalAssistant) &&
    sameDisplayMessage(left.compaction, right.compaction) &&
    sameProcessItems(left.processItems, right.processItems)
  )
}

function TurnUserMessageComponent({
  message,
  onLoadDetail,
  onAcquireImage
}: {
  message: L3ConversationDisplayMessage
  onLoadDetail: L3ConversationLoadDetail
  onAcquireImage: L3ConversationAcquireImage
}): React.JSX.Element {
  return (
    <L3ConversationMessageView
      message={message}
      loadDetail={onLoadDetail}
      defaultView={<UserMessage message={message} onAcquireImage={onAcquireImage} />}
    />
  )
}

const TurnUserMessage = memo(
  TurnUserMessageComponent,
  (previous, next) =>
    previous.onLoadDetail === next.onLoadDetail &&
    previous.onAcquireImage === next.onAcquireImage &&
    sameDisplayMessage(previous.message, next.message)
)

function TurnFinalAssistantComponent({
  message,
  onLoadDetail
}: {
  message: L3ConversationDisplayMessage
  onLoadDetail: L3ConversationLoadDetail
}): React.JSX.Element | null {
  if (message.summary.type !== 'assistant') return null
  return (
    <L3ConversationMessageView
      message={message}
      loadDetail={onLoadDetail}
      defaultView={<AssistantText message={message} text={message.summary.text} />}
    />
  )
}

const TurnFinalAssistant = memo(
  TurnFinalAssistantComponent,
  (previous, next) =>
    previous.onLoadDetail === next.onLoadDetail &&
    sameDisplayMessage(previous.message, next.message)
)

function L3ConversationTurnViewComponent({
  turn,
  cwd,
  logicalTail = false,
  onLoadDetail,
  onAcquireImage,
  onPreviewFile
}: L3ConversationTurnViewProps): React.JSX.Element {
  if (turn.compaction) {
    return (
      <section
        className={cn(!turn.running && 'pi-desk-chat-turn-contained')}
        data-chat-turn={turn.identity}
        data-chat-logical-tail={logicalTail ? '' : undefined}
      >
        <L3ConversationMessageView
          message={turn.compaction}
          loadDetail={onLoadDetail}
          defaultView={<CompactionMessage message={turn.compaction} onLoadDetail={onLoadDetail} />}
        />
      </section>
    )
  }

  const waitingForAssistant =
    turn.running && turn.processItems.length === 0 && turn.finalAssistant === null

  return (
    <section
      className={cn('space-y-3', !turn.running && 'pi-desk-chat-turn-contained')}
      data-chat-turn={turn.identity}
      data-chat-logical-tail={logicalTail ? '' : undefined}
    >
      {turn.user ? (
        <TurnUserMessage
          message={turn.user}
          onLoadDetail={onLoadDetail}
          onAcquireImage={onAcquireImage}
        />
      ) : null}
      <L3ConversationImageContext.Provider value={onAcquireImage}>
        <L3ConversationFileCwdContext.Provider value={cwd}>
          <ProcessGroup
            turn={turn}
            onLoadDetail={onLoadDetail}
            onAcquireImage={onAcquireImage}
            onPreviewFile={onPreviewFile}
          />
        </L3ConversationFileCwdContext.Provider>
      </L3ConversationImageContext.Provider>
      {waitingForAssistant ? <AssistantThinkingStatus /> : null}
      {turn.finalAssistant ? (
        <TurnFinalAssistant message={turn.finalAssistant} onLoadDetail={onLoadDetail} />
      ) : null}
    </section>
  )
}

export const L3ConversationTurnView = memo(
  L3ConversationTurnViewComponent,
  (previous, next) =>
    previous.cwd === next.cwd &&
    previous.logicalTail === next.logicalTail &&
    previous.onAcquireImage === next.onAcquireImage &&
    previous.onLoadDetail === next.onLoadDetail &&
    previous.onPreviewFile === next.onPreviewFile &&
    sameTurn(previous.turn, next.turn)
)

L3ConversationTurnView.displayName = 'L3ConversationTurnView'
