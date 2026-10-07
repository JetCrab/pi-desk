'use client'

import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { useTranslation } from 'react-i18next'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { ButtonGroup } from '@client/l4_foundation/ui/shadcn/button-group'
import type { L3ConversationTurn } from './l3-conversation-display'
import {
  findL3ConversationUserTurnIndexes,
  type L3ConversationProgressiveWindowState
} from './l3-conversation-progressive-window'
import {
  L3_CONVERSATION_TOP_GUTTER_PX,
  clearL3ConversationTailSpacer,
  logL3ConversationScroll,
  positionL3ConversationMessage,
  readL3ConversationTailSpacerHeight
} from './l3-conversation-viewport'

const NAVIGATION_VISIBLE_MS = 2000
const POSITION_TOLERANCE_PX = 2
const BOTTOM_THRESHOLD_PX = 2

interface ChatNavigationSnapshot {
  previousMessage: HTMLElement | null
  nextMessage: HTMLElement | null
  previousOutsideTurnIndex: number | null
  nextOutsideTurnIndex: number | null
  atBottom: boolean
}

interface ChatNavigationAvailability {
  canMoveUp: boolean
  canMoveDown: boolean
  hasNextMessage: boolean
}

interface PendingMessageNavigation {
  anchor: string
}

interface L3ConversationNavigationProps {
  turns: readonly L3ConversationTurn[]
  window: L3ConversationProgressiveWindowState
}

interface NavigationPosition {
  index: number
  visible: boolean
}

const EMPTY_AVAILABILITY: ChatNavigationAvailability = {
  canMoveUp: false,
  canMoveDown: false,
  hasNextMessage: false
}

function firstMessageIndex(
  messages: readonly HTMLElement[],
  navigationTop: number,
  boundary: number,
  inclusive: boolean
): number {
  let low = 0
  let high = messages.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const difference = messages[middle]!.getBoundingClientRect().top - navigationTop
    if (inclusive ? difference >= boundary : difference > boundary) high = middle
    else low = middle + 1
  }
  return low
}

function userAnchor(turn: L3ConversationTurn): string | null {
  return turn.user ? `${turn.user.identity}:user` : null
}

function inspectNavigation(
  scrollElement: HTMLElement,
  windowState: L3ConversationProgressiveWindowState,
  userTurnIndexes: readonly number[]
): ChatNavigationSnapshot {
  const messages = Array.from(
    scrollElement.querySelectorAll<HTMLElement>('[data-chat-user-message]')
  )
  const navigationTop = scrollElement.getBoundingClientRect().top + L3_CONVERSATION_TOP_GUTTER_PX
  const previousBoundary = firstMessageIndex(messages, navigationTop, -POSITION_TOLERANCE_PX, true)
  const nextBoundary = firstMessageIndex(messages, navigationTop, POSITION_TOLERANCE_PX, false)
  const firstMountedUserIndex = userTurnIndexes.find(
    (index) => index >= windowState.startIndex && index < windowState.endIndex
  )
  const lastMountedUserIndex = userTurnIndexes.findLast(
    (index) => index >= windowState.startIndex && index < windowState.endIndex
  )
  const previousOutsideTurnIndex =
    previousBoundary === 0
      ? (userTurnIndexes.findLast(
          (index) => index < (firstMountedUserIndex ?? windowState.startIndex)
        ) ?? null)
      : null
  const nextOutsideTurnIndex =
    nextBoundary >= messages.length
      ? (userTurnIndexes.find(
          (index) => index > (lastMountedUserIndex ?? windowState.endIndex - 1)
        ) ?? null)
      : null
  const distanceFromBottom =
    scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
  const tailSpacerHeight = readL3ConversationTailSpacerHeight(scrollElement)
  const atBottom = windowState.containsTail && distanceFromBottom <= BOTTOM_THRESHOLD_PX
  logL3ConversationScroll('navigation:inspect', scrollElement, {
    containsTail: windowState.containsTail,
    tailSpacerHeight,
    atBottom,
    previousMessage: messages[previousBoundary - 1]?.dataset.chatUserMessage ?? null,
    nextMessage: messages[nextBoundary]?.dataset.chatUserMessage ?? null,
    previousOutsideTurnIndex,
    nextOutsideTurnIndex
  })
  return {
    previousMessage: messages[previousBoundary - 1] ?? null,
    nextMessage: messages[nextBoundary] ?? null,
    previousOutsideTurnIndex,
    nextOutsideTurnIndex,
    atBottom
  }
}

function availabilityFor(snapshot: ChatNavigationSnapshot): ChatNavigationAvailability {
  const canMoveDown = !snapshot.atBottom
  return {
    canMoveUp: snapshot.previousMessage !== null || snapshot.previousOutsideTurnIndex !== null,
    canMoveDown,
    hasNextMessage:
      canMoveDown && (snapshot.nextMessage !== null || snapshot.nextOutsideTurnIndex !== null)
  }
}

function sameAvailability(
  current: ChatNavigationAvailability,
  next: ChatNavigationAvailability
): boolean {
  return (
    current.canMoveUp === next.canMoveUp &&
    current.canMoveDown === next.canMoveDown &&
    current.hasNextMessage === next.hasNextMessage
  )
}

export function L3ConversationNavigation({
  turns,
  window: turnWindow
}: L3ConversationNavigationProps): React.JSX.Element | null {
  const { t } = useTranslation('conversation')
  const { scrollRef, scrollToBottom, stopScroll } = useStickToBottomContext()
  const userTurnIndexes = useMemo(() => findL3ConversationUserTurnIndexes(turns), [turns])
  const [visible, setVisible] = useState(false)
  const [availability, setAvailability] = useState<ChatNavigationAvailability>(EMPTY_AVAILABILITY)
  const [position, setPosition] = useState<NavigationPosition | null>(null)
  const positionHideTimerRef = useRef<number | null>(null)
  const visibleRef = useRef(false)
  const hoveringRef = useRef(false)
  const hideTimerRef = useRef<number | null>(null)
  const refreshFrameRef = useRef<number | null>(null)
  const bottomNavigationRef = useRef(false)
  const pendingMessageRef = useRef<PendingMessageNavigation | null>(null)
  const pendingBottomRef = useRef(false)
  const mountedRef = useRef(false)

  const refreshAvailability = useCallback(
    (scrollElement: HTMLElement): void => {
      const next = availabilityFor(inspectNavigation(scrollElement, turnWindow, userTurnIndexes))
      if (bottomNavigationRef.current) next.canMoveDown = false
      setAvailability((current) => (sameAvailability(current, next) ? current : next))
    },
    [turnWindow, userTurnIndexes]
  )

  const scheduleAvailabilityRefresh = useCallback(
    (scrollElement: HTMLElement): void => {
      if (refreshFrameRef.current !== null) return
      refreshFrameRef.current = window.requestAnimationFrame(() => {
        refreshFrameRef.current = null
        refreshAvailability(scrollElement)
      })
    },
    [refreshAvailability]
  )

  const clearNavigationHide = useCallback((): void => {
    if (hideTimerRef.current === null) return
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }, [])

  const scheduleNavigationHide = useCallback((): void => {
    clearNavigationHide()
    if (hoveringRef.current) return
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      visibleRef.current = false
      setVisible(false)
      if (refreshFrameRef.current !== null) {
        window.cancelAnimationFrame(refreshFrameRef.current)
        refreshFrameRef.current = null
      }
    }, NAVIGATION_VISIBLE_MS)
  }, [clearNavigationHide])

  const hidePosition = useCallback((): void => {
    if (positionHideTimerRef.current !== null) window.clearTimeout(positionHideTimerRef.current)
    positionHideTimerRef.current = null
    setPosition((current) => (current?.visible ? { ...current, visible: false } : current))
  }, [])

  const showPosition = useCallback((index: number): void => {
    if (positionHideTimerRef.current !== null) window.clearTimeout(positionHideTimerRef.current)
    setPosition({ index, visible: true })
    positionHideTimerRef.current = window.setTimeout(() => {
      positionHideTimerRef.current = null
      setPosition((current) => (current?.visible ? { ...current, visible: false } : current))
    }, NAVIGATION_VISIBLE_MS)
  }, [])

  const showNavigation = useCallback((): void => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return
    if (!visibleRef.current) setAvailability(EMPTY_AVAILABILITY)
    visibleRef.current = true
    setVisible(true)
    scheduleAvailabilityRefresh(scrollElement)
    scheduleNavigationHide()
  }, [scheduleAvailabilityRefresh, scheduleNavigationHide, scrollRef])

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    const pendingMessage = pendingMessageRef.current
    if (pendingMessage) {
      const target = Array.from(
        scrollElement.querySelectorAll<HTMLElement>('[data-chat-scroll-anchor]')
      ).find((message) => message.dataset.chatScrollAnchor === pendingMessage.anchor)
      if (target) {
        pendingMessageRef.current = null
        stopScroll()
        positionL3ConversationMessage(
          scrollElement,
          target,
          L3_CONVERSATION_TOP_GUTTER_PX,
          turnWindow.containsTail
        )
      }
    }

    if (pendingBottomRef.current && turnWindow.containsTail) {
      pendingBottomRef.current = false
      clearL3ConversationTailSpacer(scrollElement)
      void Promise.resolve(scrollToBottom({ animation: 'instant' })).finally(() => {
        bottomNavigationRef.current = false
        if (mountedRef.current && visibleRef.current) {
          scheduleAvailabilityRefresh(scrollElement)
        }
      })
    }
  }, [
    scheduleAvailabilityRefresh,
    scrollRef,
    scrollToBottom,
    stopScroll,
    turnWindow.containsTail,
    turnWindow.endIndex,
    turnWindow.startIndex
  ])

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return
    mountedRef.current = true

    const handleManualScroll = (): void => {
      hidePosition()
      showNavigation()
    }
    const handleScroll = (): void => {
      if (visibleRef.current) scheduleAvailabilityRefresh(scrollElement)
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (event.target === scrollElement) hidePosition()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        hidePosition()
      }
    }
    scrollElement.addEventListener('wheel', handleManualScroll, { passive: true })
    scrollElement.addEventListener('touchmove', handleManualScroll, { passive: true })
    scrollElement.addEventListener('pointerdown', handlePointerDown, { passive: true })
    scrollElement.addEventListener('keydown', handleKeyDown)
    scrollElement.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      scrollElement.removeEventListener('wheel', handleManualScroll)
      scrollElement.removeEventListener('touchmove', handleManualScroll)
      scrollElement.removeEventListener('pointerdown', handlePointerDown)
      scrollElement.removeEventListener('keydown', handleKeyDown)
      scrollElement.removeEventListener('scroll', handleScroll)
      if (refreshFrameRef.current !== null) {
        window.cancelAnimationFrame(refreshFrameRef.current)
        refreshFrameRef.current = null
      }
      mountedRef.current = false
    }
  }, [hidePosition, scheduleAvailabilityRefresh, scrollRef, showNavigation])

  useLayoutEffect(
    () => () => {
      clearNavigationHide()
      if (positionHideTimerRef.current !== null) window.clearTimeout(positionHideTimerRef.current)
      bottomNavigationRef.current = false
      pendingMessageRef.current = null
      pendingBottomRef.current = false
    },
    [clearNavigationHide]
  )

  useLayoutEffect(() => {
    if (visible && (availability.canMoveUp || availability.canMoveDown)) return
    hoveringRef.current = false
  }, [availability.canMoveDown, availability.canMoveUp, visible])

  const navigate = useCallback(
    (direction: 'up' | 'down', trigger?: HTMLButtonElement): void => {
      const scrollElement = scrollRef.current
      if (!scrollElement) return

      showNavigation()
      const snapshot = inspectNavigation(scrollElement, turnWindow, userTurnIndexes)
      const target =
        direction === 'up'
          ? snapshot.previousMessage
          : snapshot.atBottom
            ? null
            : snapshot.nextMessage
      if (target) {
        const index = userTurnIndexes.findIndex(
          (turnIndex) => userAnchor(turns[turnIndex]!) === target.dataset.chatScrollAnchor
        )
        if (index >= 0) showPosition(index + 1)
        bottomNavigationRef.current = false
        stopScroll()
        positionL3ConversationMessage(
          scrollElement,
          target,
          L3_CONVERSATION_TOP_GUTTER_PX,
          turnWindow.containsTail
        )
      } else {
        const outsideTurnIndex =
          direction === 'up' ? snapshot.previousOutsideTurnIndex : snapshot.nextOutsideTurnIndex
        if (outsideTurnIndex !== null) {
          const anchor = userAnchor(turns[outsideTurnIndex]!)
          if (anchor) {
            showPosition(userTurnIndexes.indexOf(outsideTurnIndex) + 1)
            bottomNavigationRef.current = false
            pendingMessageRef.current = { anchor }
            turnWindow.revealTurn(outsideTurnIndex)
          }
        } else if (direction === 'down') {
          if (userTurnIndexes.length > 0) showPosition(userTurnIndexes.length)
          if (trigger) trigger.disabled = true
          setAvailability((current) =>
            current.canMoveDown ? { ...current, canMoveDown: false } : current
          )
          if (!snapshot.atBottom && !bottomNavigationRef.current) {
            logL3ConversationScroll('navigation:bottom:start', scrollElement, {
              containsTail: turnWindow.containsTail
            })
            bottomNavigationRef.current = true
            clearL3ConversationTailSpacer(scrollElement)
            if (!turnWindow.containsTail) {
              pendingBottomRef.current = true
              turnWindow.resetToTail()
            } else {
              void Promise.resolve(scrollToBottom({ animation: 'instant' })).finally(() => {
                bottomNavigationRef.current = false
                if (mountedRef.current && visibleRef.current) {
                  scheduleAvailabilityRefresh(scrollElement)
                }
              })
            }
          }
        }
      }

      scheduleAvailabilityRefresh(scrollElement)
    },
    [
      scheduleAvailabilityRefresh,
      scrollRef,
      scrollToBottom,
      showNavigation,
      showPosition,
      stopScroll,
      turns,
      turnWindow,
      userTurnIndexes
    ]
  )

  const showButtons = visible && (availability.canMoveUp || availability.canMoveDown)
  const downLabel = t(availability.hasNextMessage ? 'nextUserMessage' : 'bottom')

  return (
    <>
      {position && userTurnIndexes.length > 0 ? (
        <div
          role="status"
          aria-hidden={!position.visible}
          aria-label={`${t('userNavigation')} ${position.index} / ${userTurnIndexes.length}`}
          className={`pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 rounded-lg border bg-background/95 px-2 py-2 shadow-sm transition-opacity duration-150 motion-reduce:transition-none sm:left-4 ${position.visible ? 'opacity-100' : 'opacity-0'}`}
        >
          <div className="text-center text-sm font-medium tabular-nums">
            {position.index} / {userTurnIndexes.length}
          </div>
          <div className="relative mx-auto mt-2 h-28 w-0.5 rounded-full bg-border">
            <span
              className="absolute left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
              style={{
                top: `${((position.index - 1) / Math.max(1, userTurnIndexes.length - 1)) * 100}%`
              }}
            />
          </div>
        </div>
      ) : null}
      {showButtons ? (
        <ButtonGroup
          orientation="vertical"
          className="absolute right-3 bottom-4 z-10 rounded-lg shadow-sm sm:right-4"
          aria-label={t('userNavigation')}
          onMouseEnter={() => {
            hoveringRef.current = true
            clearNavigationHide()
          }}
          onMouseLeave={() => {
            hoveringRef.current = false
            if (visibleRef.current) scheduleNavigationHide()
          }}
        >
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-10 bg-background/90 backdrop-blur dark:bg-background/90"
            disabled={!availability.canMoveUp}
            aria-label={t('previousUserMessage')}
            title={t('previousUserShort')}
            onClick={() => navigate('up')}
          >
            <ArrowUpIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-10 bg-background/90 backdrop-blur dark:bg-background/90"
            disabled={!availability.canMoveDown}
            aria-label={downLabel}
            title={downLabel}
            onClick={(event) => navigate('down', event.currentTarget)}
          >
            <ArrowDownIcon className="size-4" />
          </Button>
        </ButtonGroup>
      ) : null}
    </>
  )
}
