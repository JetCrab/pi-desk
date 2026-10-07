'use client'

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import type { L3ConversationDisplayMessage, L3ConversationTurn } from './l3-conversation-display'
import { logL3ConversationScroll } from './l3-conversation-viewport'

export const L3_CONVERSATION_INITIAL_TURN_LIMIT = 30
export const L3_CONVERSATION_MESSAGE_BUDGET = 200
const L3_CONVERSATION_MINIMUM_USER_TURNS = 2
const L3_CONVERSATION_WINDOW_EDGE_PX = 24
const L3_CONVERSATION_ANCHOR_FORWARD_TURNS = 10

export interface L3ConversationTurnRange {
  startIndex: number
  endIndex: number
}

export interface L3ConversationProgressiveWindowState extends L3ConversationTurnRange {
  visibleTurns: readonly L3ConversationTurn[]
  containsTail: boolean
  revealTurn: (turnIndex: number) => void
  resetToTail: () => void
}

interface L3ConversationProgressiveWindowProps {
  active?: boolean
  turns: readonly L3ConversationTurn[]
  focusTurnIdentity: string | null
  initialAnchor: string | null
  children: (state: L3ConversationProgressiveWindowState) => ReactNode
}

interface PendingAnchor {
  turnIdentity: string
  offset: number
}

function turnMessages(turn: L3ConversationTurn): L3ConversationDisplayMessage[] {
  const messages = [
    turn.user,
    ...turn.processItems.map((item) => item.message),
    turn.finalAssistant,
    turn.compaction
  ].filter((message): message is L3ConversationDisplayMessage => message !== null)
  const identities = new Set<string>()
  return messages.filter((message) => {
    if (identities.has(message.identity)) return false
    identities.add(message.identity)
    return true
  })
}

function turnMessageCount(turn: L3ConversationTurn): number {
  return turnMessages(turn).length
}

function userTurnCount(turns: readonly L3ConversationTurn[], startIndex: number, endIndex: number) {
  let count = 0
  for (let index = startIndex; index < endIndex; index += 1) {
    if (turns[index]?.user) count += 1
  }
  return count
}

function selectBackwardStart(turns: readonly L3ConversationTurn[], endIndexInput: number): number {
  const endIndex = Math.max(0, Math.min(turns.length, endIndexInput))
  const requiredUserTurns = Math.min(
    L3_CONVERSATION_MINIMUM_USER_TURNS,
    userTurnCount(turns, 0, endIndex)
  )
  let startIndex = endIndex
  let mountedTurns = 0
  let messages = 0
  let users = 0

  while (startIndex > 0) {
    const candidate = turns[startIndex - 1]!
    const candidateMessages = turnMessageCount(candidate)
    const minimumIncomplete = users < requiredUserTurns
    if (
      mountedTurns > 0 &&
      !minimumIncomplete &&
      (mountedTurns >= L3_CONVERSATION_INITIAL_TURN_LIMIT ||
        messages + candidateMessages > L3_CONVERSATION_MESSAGE_BUDGET)
    ) {
      break
    }

    startIndex -= 1
    mountedTurns += 1
    messages += candidateMessages
    if (candidate.user) users += 1
  }

  return startIndex
}

function selectForwardEnd(turns: readonly L3ConversationTurn[], startIndexInput: number): number {
  const startIndex = Math.max(0, Math.min(turns.length, startIndexInput))
  const requiredUserTurns = Math.min(
    L3_CONVERSATION_MINIMUM_USER_TURNS,
    userTurnCount(turns, startIndex, turns.length)
  )
  let endIndex = startIndex
  let mountedTurns = 0
  let messages = 0
  let users = 0

  while (endIndex < turns.length) {
    const candidate = turns[endIndex]!
    const candidateMessages = turnMessageCount(candidate)
    const minimumIncomplete = users < requiredUserTurns
    if (
      mountedTurns > 0 &&
      !minimumIncomplete &&
      (mountedTurns >= L3_CONVERSATION_INITIAL_TURN_LIMIT ||
        messages + candidateMessages > L3_CONVERSATION_MESSAGE_BUDGET)
    ) {
      break
    }

    endIndex += 1
    mountedTurns += 1
    messages += candidateMessages
    if (candidate.user) users += 1
  }

  return endIndex
}

function messageIdentityFromAnchor(anchor: string): string {
  const separator = anchor.lastIndexOf(':')
  return separator > 0 ? anchor.slice(0, separator) : anchor
}

export function findL3ConversationTurnIndexByMessageAnchor(
  turns: readonly L3ConversationTurn[],
  anchor: string
): number {
  const messageIdentity = messageIdentityFromAnchor(anchor)
  return turns.findIndex((turn) =>
    turnMessages(turn).some((message) => message.identity === messageIdentity)
  )
}

export function findL3ConversationUserTurnIndexes(turns: readonly L3ConversationTurn[]): number[] {
  return turns.flatMap((turn, index) => (turn.user ? [index] : []))
}

export function selectL3ConversationTailRange(
  turns: readonly L3ConversationTurn[]
): L3ConversationTurnRange {
  return { startIndex: selectBackwardStart(turns, turns.length), endIndex: turns.length }
}

export function selectL3ConversationInitialRange(
  turns: readonly L3ConversationTurn[],
  initialAnchor: string | null
): L3ConversationTurnRange {
  if (turns.length === 0) return { startIndex: 0, endIndex: 0 }
  if (!initialAnchor) return selectL3ConversationTailRange(turns)

  const anchorIndex = findL3ConversationTurnIndexByMessageAnchor(turns, initialAnchor)
  if (anchorIndex < 0) return selectL3ConversationTailRange(turns)
  const endIndex = Math.min(turns.length, anchorIndex + 1 + L3_CONVERSATION_ANCHOR_FORWARD_TURNS)
  return { startIndex: selectBackwardStart(turns, endIndex), endIndex }
}

function findRenderedTurn(scrollElement: HTMLElement, identity: string): HTMLElement | null {
  return (
    Array.from(scrollElement.querySelectorAll<HTMLElement>('[data-chat-turn]')).find(
      (turn) => turn.dataset.chatTurn === identity
    ) ?? null
  )
}

interface L3ConversationWindowInternalState extends L3ConversationTurnRange {
  turnCount: number
  focusTurnIdentity: string | null
}

export function L3ConversationProgressiveWindow({
  active = true,
  turns,
  focusTurnIdentity,
  initialAnchor,
  children
}: L3ConversationProgressiveWindowProps): React.JSX.Element {
  const { scrollRef } = useStickToBottomContext()
  const [windowState, setWindowState] = useState<L3ConversationWindowInternalState>(() => ({
    ...selectL3ConversationInitialRange(turns, initialAnchor),
    turnCount: turns.length,
    focusTurnIdentity
  }))
  if (!active && windowState.focusTurnIdentity !== focusTurnIdentity) {
    setWindowState({ ...windowState, focusTurnIdentity })
  }
  const pendingAnchorRef = useRef<PendingAnchor | null>(null)
  const expansionPendingRef = useRef(false)
  const effectiveRange = useMemo<L3ConversationTurnRange>(() => {
    if (turns.length === 0) return { startIndex: 0, endIndex: 0 }
    if (active && windowState.focusTurnIdentity !== focusTurnIdentity) {
      return selectL3ConversationTailRange(turns)
    }
    if (windowState.turnCount === 0 && windowState.endIndex === 0) {
      return selectL3ConversationInitialRange(turns, initialAnchor)
    }
    const wasAtTail = windowState.endIndex >= windowState.turnCount
    return {
      startIndex: Math.min(windowState.startIndex, turns.length),
      endIndex: wasAtTail
        ? turns.length
        : Math.max(windowState.startIndex, Math.min(windowState.endIndex, turns.length))
    }
  }, [active, focusTurnIdentity, initialAnchor, turns, windowState])

  const commitRange = useCallback(
    (range: L3ConversationTurnRange): void => {
      setWindowState({
        ...range,
        turnCount: turns.length,
        focusTurnIdentity
      })
    },
    [focusTurnIdentity, turns.length]
  )

  const captureFirstTurn = useCallback((): void => {
    const scrollElement = scrollRef.current
    const firstTurn = scrollElement?.querySelector<HTMLElement>('[data-chat-turn]')
    if (!scrollElement || !firstTurn?.dataset.chatTurn) return
    pendingAnchorRef.current = {
      turnIdentity: firstTurn.dataset.chatTurn,
      offset: firstTurn.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top
    }
  }, [scrollRef])

  const expandEarlier = useCallback((): void => {
    if (effectiveRange.startIndex <= 0 || expansionPendingRef.current) return
    const nextStartIndex = selectBackwardStart(turns, effectiveRange.startIndex)
    if (nextStartIndex >= effectiveRange.startIndex) return
    captureFirstTurn()
    const scrollElement = scrollRef.current
    if (scrollElement) {
      logL3ConversationScroll('window:expand-earlier', scrollElement, {
        previousStartIndex: effectiveRange.startIndex,
        nextStartIndex
      })
    }
    expansionPendingRef.current = true
    commitRange({ ...effectiveRange, startIndex: nextStartIndex })
  }, [captureFirstTurn, commitRange, effectiveRange, scrollRef, turns])

  const expandLater = useCallback((): void => {
    if (effectiveRange.endIndex >= turns.length || expansionPendingRef.current) return
    const nextEndIndex = selectForwardEnd(turns, effectiveRange.endIndex)
    if (nextEndIndex <= effectiveRange.endIndex) return
    expansionPendingRef.current = true
    commitRange({ ...effectiveRange, endIndex: nextEndIndex })
  }, [commitRange, effectiveRange, turns])

  const revealTurn = useCallback(
    (turnIndex: number): void => {
      if (!Number.isSafeInteger(turnIndex) || turnIndex < 0 || turnIndex >= turns.length) return
      if (turnIndex >= effectiveRange.startIndex && turnIndex < effectiveRange.endIndex) return
      if (turnIndex < effectiveRange.startIndex) {
        commitRange({
          ...effectiveRange,
          startIndex: Math.min(turnIndex, selectBackwardStart(turns, turnIndex + 1))
        })
      } else {
        commitRange({
          ...effectiveRange,
          endIndex: Math.max(turnIndex + 1, selectForwardEnd(turns, turnIndex))
        })
      }
    },
    [commitRange, effectiveRange, turns]
  )

  const resetToTail = useCallback((): void => {
    commitRange(selectL3ConversationTailRange(turns))
  }, [commitRange, turns])

  useLayoutEffect(() => {
    expansionPendingRef.current = false
    const pending = pendingAnchorRef.current
    if (!pending) return
    const scrollElement = scrollRef.current
    const target = scrollElement ? findRenderedTurn(scrollElement, pending.turnIdentity) : null
    pendingAnchorRef.current = null
    if (!scrollElement || !target) return
    const nextOffset =
      target.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top
    const correction = nextOffset - pending.offset
    logL3ConversationScroll('window:anchor-correction:start', scrollElement, {
      turnIdentity: pending.turnIdentity,
      previousOffset: pending.offset,
      nextOffset,
      correction
    })
    scrollElement.scrollTop += correction
    logL3ConversationScroll('window:anchor-correction:end', scrollElement, {
      turnIdentity: pending.turnIdentity,
      correction
    })
  }, [effectiveRange.endIndex, effectiveRange.startIndex, scrollRef])

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement || !active) return

    let frame: number | null = null
    const inspect = (): void => {
      frame = null
      if (
        scrollElement.scrollTop <= L3_CONVERSATION_WINDOW_EDGE_PX &&
        effectiveRange.startIndex > 0
      ) {
        expandEarlier()
        return
      }
      const distanceFromBottom =
        scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
      if (
        distanceFromBottom <= L3_CONVERSATION_WINDOW_EDGE_PX &&
        effectiveRange.endIndex < turns.length
      ) {
        expandLater()
      }
    }
    const scheduleInspect = (): void => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(inspect)
    }
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0 && scrollElement.scrollTop <= L3_CONVERSATION_WINDOW_EDGE_PX) {
        expandEarlier()
      } else if (event.deltaY > 0) {
        scheduleInspect()
      }
    }
    const handleTouchMove = (): void => {
      if (scrollElement.scrollTop <= L3_CONVERSATION_WINDOW_EDGE_PX) expandEarlier()
      else scheduleInspect()
    }

    scrollElement.addEventListener('scroll', scheduleInspect, { passive: true })
    scrollElement.addEventListener('wheel', handleWheel, { passive: true })
    scrollElement.addEventListener('touchmove', handleTouchMove, { passive: true })
    return () => {
      scrollElement.removeEventListener('scroll', scheduleInspect)
      scrollElement.removeEventListener('wheel', handleWheel)
      scrollElement.removeEventListener('touchmove', handleTouchMove)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [active, effectiveRange, expandEarlier, expandLater, scrollRef, turns.length])

  const visibleTurns = useMemo(
    () => turns.slice(effectiveRange.startIndex, effectiveRange.endIndex),
    [effectiveRange.endIndex, effectiveRange.startIndex, turns]
  )
  const state = useMemo<L3ConversationProgressiveWindowState>(
    () => ({
      ...effectiveRange,
      visibleTurns,
      containsTail: effectiveRange.endIndex >= turns.length,
      revealTurn,
      resetToTail
    }),
    [effectiveRange, resetToTail, revealTurn, turns.length, visibleTurns]
  )

  return <>{children(state)}</>
}
