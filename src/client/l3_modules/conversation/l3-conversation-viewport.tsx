'use client'

import { useEffect } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'

export const L3_CONVERSATION_TOP_GUTTER_PX = 12

function scrollDebugEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('chatScrollDebug') === '1'
  )
}

export function logL3ConversationScroll(
  event: string,
  scrollElement: HTMLElement,
  details: Record<string, unknown> = {}
): void {
  if (!scrollDebugEnabled()) return

  const turn = activeTailTurn(scrollElement)
  console.info('[Pi Desk][ChatScroll]', event, {
    time: Math.round(performance.now() * 10) / 10,
    scrollTop: scrollElement.scrollTop,
    scrollHeight: scrollElement.scrollHeight,
    clientHeight: scrollElement.clientHeight,
    distanceFromBottom:
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight,
    tailSpace: turn ? tailSpaceHeight(turn) : 0,
    tailMinHeight: turn?.style.minHeight || null,
    tailAnchor: turn?.dataset.chatTailAnchor ?? null,
    ...details
  })
}

function findMessage(
  scrollElement: HTMLElement,
  attribute: 'data-chat-scroll-anchor' | 'data-chat-user-message',
  value?: string
): HTMLElement | null {
  const messages = Array.from(scrollElement.querySelectorAll<HTMLElement>(`[${attribute}]`))
  return value === undefined
    ? (messages.at(-1) ?? null)
    : (messages.find((message) => message.getAttribute(attribute) === value) ?? null)
}

function lastTurn(scrollElement: HTMLElement): HTMLElement | null {
  const turns = scrollElement.querySelectorAll<HTMLElement>('[data-chat-turn]')
  return turns.item(turns.length - 1)
}

function logicalTailTurn(scrollElement: HTMLElement): HTMLElement | null {
  const turn = lastTurn(scrollElement)
  return turn?.hasAttribute('data-chat-logical-tail') ? turn : null
}

function activeTailTurn(scrollElement: HTMLElement): HTMLElement | null {
  return scrollElement.querySelector<HTMLElement>('[data-chat-tail-space]')
}

function tailSpaceHeight(turn: HTMLElement): number {
  const lastChild = turn.lastElementChild
  if (!(lastChild instanceof HTMLElement)) return 0
  return Math.max(0, turn.getBoundingClientRect().bottom - lastChild.getBoundingClientRect().bottom)
}

function contentBottomPadding(turn: HTMLElement): number {
  const content = turn.parentElement
  if (!content) return 0
  const padding = Number.parseFloat(getComputedStyle(content).paddingBottom)
  return Number.isFinite(padding) ? padding : 0
}

function measureTailPosition(
  scrollElement: HTMLElement,
  target: HTMLElement,
  turn: HTMLElement,
  offset: number
): { targetScrollTop: number; minHeight: number } {
  const scrollRect = scrollElement.getBoundingClientRect()
  const scrollTop = scrollElement.scrollTop
  const targetScrollTop = Math.max(
    0,
    scrollTop + target.getBoundingClientRect().top - scrollRect.top - offset
  )
  const turnTop = scrollTop + turn.getBoundingClientRect().top - scrollRect.top
  return {
    targetScrollTop,
    // 只补足锚点定位需要的空间；自然内容不能写进最低高度，否则收起会滞后一帧。
    minHeight: Math.max(
      0,
      targetScrollTop + scrollElement.clientHeight - turnTop - contentBottomPadding(turn)
    )
  }
}

export function findL3ConversationMessage(
  scrollElement: HTMLElement,
  attribute: 'data-chat-scroll-anchor' | 'data-chat-user-message',
  value?: string
): HTMLElement | null {
  return findMessage(scrollElement, attribute, value)
}

export function readL3ConversationTailSpacerHeight(scrollElement: HTMLElement): number {
  const turn = activeTailTurn(scrollElement)
  return turn ? tailSpaceHeight(turn) : 0
}

export function clearL3ConversationTailSpacer(scrollElement: HTMLElement): void {
  for (const turn of scrollElement.querySelectorAll<HTMLElement>('[data-chat-tail-space]')) {
    logL3ConversationScroll('tail:clear:start', scrollElement)
    turn.style.removeProperty('min-height')
    delete turn.dataset.chatTailSpace
    delete turn.dataset.chatTailAnchor
    delete turn.dataset.chatTailOffset
    logL3ConversationScroll('tail:clear:end', scrollElement)
  }
}

export function refreshL3ConversationTailSpacer(scrollElement: HTMLElement): void {
  const turn = activeTailTurn(scrollElement)
  if (!turn) return
  if (turn !== logicalTailTurn(scrollElement)) {
    clearL3ConversationTailSpacer(scrollElement)
    return
  }

  const anchor = turn.dataset.chatTailAnchor
  const offset = Number.parseFloat(turn.dataset.chatTailOffset ?? '')
  if (!anchor || !Number.isFinite(offset)) return

  const target = findMessage(scrollElement, 'data-chat-scroll-anchor', anchor)
  if (!target) {
    clearL3ConversationTailSpacer(scrollElement)
    return
  }

  const { minHeight } = measureTailPosition(scrollElement, target, turn, offset)
  const nextMinHeight = `${Math.ceil(minHeight)}px`
  if (turn.style.minHeight !== nextMinHeight) {
    logL3ConversationScroll('tail:refresh:start', scrollElement, { nextMinHeight })
    turn.style.minHeight = nextMinHeight
    logL3ConversationScroll('tail:refresh:end', scrollElement, { nextMinHeight })
  }
}

export function positionL3ConversationMessage(
  scrollElement: HTMLElement,
  target: HTMLElement,
  offset: number,
  addTailSpace: boolean
): void {
  logL3ConversationScroll('position:start', scrollElement, {
    target: target.dataset.chatScrollAnchor ?? null,
    offset,
    addTailSpace
  })
  const turn = addTailSpace ? logicalTailTurn(scrollElement) : null
  // 同一轮的定位空间可直接重算，先清空会让浏览器截短 scrollTop。
  if (!turn || activeTailTurn(scrollElement) !== turn) {
    clearL3ConversationTailSpacer(scrollElement)
  }
  if (!turn) {
    scrollElement.scrollTop = Math.max(
      0,
      scrollElement.scrollTop +
        target.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top -
        offset
    )
    logL3ConversationScroll('position:end', scrollElement, {
      target: target.dataset.chatScrollAnchor ?? null,
      offset,
      addTailSpace
    })
    return
  }

  const { targetScrollTop, minHeight } = measureTailPosition(scrollElement, target, turn, offset)
  const nextMinHeight = `${Math.ceil(minHeight)}px`
  if (turn.style.minHeight !== nextMinHeight) turn.style.minHeight = nextMinHeight
  if (!turn.hasAttribute('data-chat-tail-space')) turn.dataset.chatTailSpace = ''
  const anchor = target.dataset.chatScrollAnchor
  if (turn.dataset.chatTailAnchor !== anchor) {
    if (anchor) turn.dataset.chatTailAnchor = anchor
    else delete turn.dataset.chatTailAnchor
  }
  if (turn.dataset.chatTailOffset !== String(offset)) turn.dataset.chatTailOffset = String(offset)
  scrollElement.scrollTop = targetScrollTop
  logL3ConversationScroll('position:end', scrollElement, {
    target: target.dataset.chatScrollAnchor ?? null,
    offset,
    addTailSpace,
    minHeight
  })
}

export function L3ConversationTailSpacerObserver({ active = true }: { active?: boolean }): null {
  const { scrollRef, state } = useStickToBottomContext()

  useEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement || !active) return

    let refreshFrame: number | null = null
    let observedChildren = new Set<HTMLElement>()
    const scheduleRefresh = (): void => {
      if (refreshFrame !== null) return
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = null
        refreshL3ConversationTailSpacer(scrollElement)
      })
    }
    const contentObserver = new ResizeObserver(scheduleRefresh)
    const syncChildren = (): void => {
      const nextChildren = new Set<HTMLElement>()
      const turn = activeTailTurn(scrollElement)
      if (turn) {
        for (const child of turn.children) {
          if (child instanceof HTMLElement) nextChildren.add(child)
        }
      }
      for (const child of observedChildren) {
        if (!nextChildren.has(child)) contentObserver.unobserve(child)
      }
      for (const child of nextChildren) {
        if (!observedChildren.has(child)) contentObserver.observe(child)
      }
      observedChildren = nextChildren
    }
    const mutationObserver = new MutationObserver(() => {
      syncChildren()
      scheduleRefresh()
    })
    let previousHeight: number | undefined
    let previousWidth: number | undefined
    let viewportDifference = 0
    let resizeReleaseFrame: number | null = null
    let resizeReleaseTimer: number | null = null
    const viewportObserver = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { height, width } = entry.contentRect
      const difference = height - (previousHeight ?? height)
      const widthDifference = width - (previousWidth ?? width)
      previousHeight = height
      previousWidth = width
      if (!difference && !widthDifference) {
        scheduleRefresh()
        return
      }

      logL3ConversationScroll('viewport:resize', scrollElement, {
        difference,
        widthDifference,
        isAtBottom: state.isAtBottom,
        escapedFromLock: state.escapedFromLock
      })
      // 库只观察内容高度；仅宽度变化时保留库标记的内容高度差。
      if (difference) {
        viewportDifference = difference
        state.resizeDifference = difference
      }
      if (refreshFrame !== null) {
        window.cancelAnimationFrame(refreshFrame)
        refreshFrame = null
      }
      // 宽度重排和高度变化都在绘制前同步跟底；库的 instant 仍会等到下一帧。
      refreshL3ConversationTailSpacer(scrollElement)
      if (state.isAtBottom) {
        state.scrollTop = Math.max(0, state.calculatedTargetScrollTop)
      }
      logL3ConversationScroll('viewport:resize:positioned', scrollElement, {
        difference,
        widthDifference
      })
      if (!difference) return
      if (resizeReleaseFrame !== null) window.cancelAnimationFrame(resizeReleaseFrame)
      if (resizeReleaseTimer !== null) window.clearTimeout(resizeReleaseTimer)
      resizeReleaseFrame = window.requestAnimationFrame(() => {
        resizeReleaseFrame = null
        resizeReleaseTimer = window.setTimeout(() => {
          resizeReleaseTimer = null
          if (state.resizeDifference === difference) state.resizeDifference = 0
          viewportDifference = 0
        }, 1)
      })
    })

    mutationObserver.observe(scrollElement, {
      attributes: true,
      attributeFilter: ['data-chat-tail-space', 'data-chat-logical-tail'],
      childList: true,
      subtree: true
    })
    viewportObserver.observe(scrollElement)
    syncChildren()
    scheduleRefresh()

    return () => {
      if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame)
      if (resizeReleaseFrame !== null) window.cancelAnimationFrame(resizeReleaseFrame)
      if (resizeReleaseTimer !== null) window.clearTimeout(resizeReleaseTimer)
      if (viewportDifference && state.resizeDifference === viewportDifference) {
        state.resizeDifference = 0
      }
      mutationObserver.disconnect()
      contentObserver.disconnect()
      viewportObserver.disconnect()
    }
  }, [active, scrollRef, state])

  return null
}
