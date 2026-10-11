'use client'

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { useStickToBottomContext, type StickToBottomState } from 'use-stick-to-bottom'
import {
  L3_CONVERSATION_TOP_GUTTER_PX,
  clearL3ConversationTailSpacer,
  findL3ConversationMessage,
  logL3ConversationScroll,
  positionL3ConversationMessage,
  readL3ConversationTailSpacerHeight
} from '@client/l3_modules/conversation/l3-conversation-viewport'
import type { L2WorkbenchChatViewportSnapshot } from '../l2-workbench-chat'

const BOTTOM_THRESHOLD_PX = 2

function subscribePageVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

function pageIsVisible(): boolean {
  return document.visibilityState === 'visible'
}

function serverPageIsVisible(): boolean {
  return true
}

function markProgrammaticScroll(scrollState: StickToBottomState, scrollElement: HTMLElement): void {
  // 库的命令式 setter 同时标记程序滚动，避免把锚点定位误判为手动回底。
  scrollState.scrollTop = scrollElement.scrollTop
}

interface L2WorkbenchChatViewportManagerProps {
  visible?: boolean
  running: boolean
  ready: boolean
  containsTail: boolean
  latestUserAnchor: string | null
  entrySnapshot: L2WorkbenchChatViewportSnapshot | null
  onResetToTail: () => void
  onSaveSnapshot: (snapshot: L2WorkbenchChatViewportSnapshot) => void
  onClearSnapshot: () => void
}

function activeTailTurn(scrollElement: HTMLElement): HTMLElement | null {
  return scrollElement.querySelector<HTMLElement>('[data-chat-tail-space]')
}

function captureSnapshot(
  scrollElement: HTMLElement,
  includeBottom = false
): L2WorkbenchChatViewportSnapshot | null {
  const distanceFromBottom =
    scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
  if (
    !includeBottom &&
    readL3ConversationTailSpacerHeight(scrollElement) <= BOTTOM_THRESHOLD_PX &&
    distanceFromBottom <= BOTTOM_THRESHOLD_PX
  )
    return null

  const containerTop = scrollElement.getBoundingClientRect().top
  let closest: { messageId: string; offset: number; distance: number } | null = null
  for (const message of scrollElement.querySelectorAll<HTMLElement>('[data-chat-scroll-anchor]')) {
    const messageId = message.dataset.chatScrollAnchor
    if (!messageId) continue
    const offset = message.getBoundingClientRect().top - containerTop
    const distance = Math.abs(offset)
    if (!closest || distance < closest.distance) closest = { messageId, offset, distance }
  }
  return closest ? { messageId: closest.messageId, offset: closest.offset } : null
}

export function L2WorkbenchChatViewportManager({
  visible = true,
  running,
  ready,
  containsTail,
  latestUserAnchor,
  entrySnapshot,
  onResetToTail,
  onSaveSnapshot,
  onClearSnapshot
}: L2WorkbenchChatViewportManagerProps): null {
  const { isAtBottom, scrollRef, scrollToBottom, state, stopScroll } = useStickToBottomContext()
  const pageVisible = useSyncExternalStore(
    subscribePageVisibility,
    pageIsVisible,
    serverPageIsVisible
  )
  const previousPageVisibleRef = useRef(pageVisible)
  const positioningRef = useRef(false)
  const initializedRef = useRef(false)
  const positionedUserAnchorRef = useRef<string | null>(null)
  // 只在首次进入仍在运行的视图时恢复旧锚点；之后的新用户消息使用自己的锚点。
  const entrySnapshotRef = useRef(running ? entrySnapshot : null)
  const suspendedSnapshotRef = useRef<L2WorkbenchChatViewportSnapshot | null>(null)
  const suspendedScrollTopRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement || !visible || !isAtBottom) return

    // 同高度的内容换位不会触发 ResizeObserver，浏览器锚定产生的上移会被误判为用户上翻。
    const previousOverflowAnchor = scrollElement.style.overflowAnchor
    scrollElement.style.overflowAnchor = 'none'
    logL3ConversationScroll('viewport:anchor-lock', scrollElement)
    return () => {
      scrollElement.style.overflowAnchor = previousOverflowAnchor
    }
  }, [isAtBottom, scrollRef, visible])

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return
    if (!visible) {
      if (suspendedScrollTopRef.current === null) {
        suspendedSnapshotRef.current = captureSnapshot(scrollElement, true)
        suspendedScrollTopRef.current = scrollElement.scrollTop
      }
      stopScroll()
      return
    }
    if (suspendedScrollTopRef.current === null) return
    if (!running) {
      initializedRef.current = false
      entrySnapshotRef.current = null
      suspendedSnapshotRef.current = null
      suspendedScrollTopRef.current = null
      logL3ConversationScroll('viewport:reenter-ended', scrollElement)
      return
    }
    stopScroll()
    const snapshot = suspendedSnapshotRef.current
    const target = snapshot
      ? findL3ConversationMessage(scrollElement, 'data-chat-scroll-anchor', snapshot.messageId)
      : null
    if (snapshot && target)
      positionL3ConversationMessage(scrollElement, target, snapshot.offset, containsTail)
    else scrollElement.scrollTop = suspendedScrollTopRef.current
    // 仍在运行时，隐藏期间的新消息不能覆盖离开前的阅读位置。
    initializedRef.current = true
    positionedUserAnchorRef.current = latestUserAnchor
    suspendedSnapshotRef.current = null
    suspendedScrollTopRef.current = null
  }, [containsTail, latestUserAnchor, running, scrollRef, stopScroll, visible])

  useLayoutEffect(() => {
    const returnedToPage = pageVisible && !previousPageVisibleRef.current
    previousPageVisibleRef.current = pageVisible
    if (returnedToPage && visible && !running) {
      initializedRef.current = false
      entrySnapshotRef.current = null
    }
    if (!ready || !visible || !pageVisible) return
    if (!running) onClearSnapshot()

    const initializing = !initializedRef.current
    const hasNewUser =
      latestUserAnchor !== null && latestUserAnchor !== positionedUserAnchorRef.current
    if (!initializing && !hasNewUser) return
    if (initializing && !running && !containsTail) {
      onResetToTail()
      return
    }

    const currentScrollElement = scrollRef.current
    if (hasNewUser) {
      onClearSnapshot()
      if (currentScrollElement) clearL3ConversationTailSpacer(currentScrollElement)
    }

    let positionFrame: number | null = null
    let releaseFrame: number | null = null
    let releaseEntryAnchor: (() => void) | null = null
    positioningRef.current = true

    const position = (): void => {
      const scrollElement = scrollRef.current
      if (!scrollElement) {
        positioningRef.current = false
        return
      }

      logL3ConversationScroll('viewport:initialize:start', scrollElement, {
        initializing,
        running,
        containsTail,
        latestUserAnchor
      })

      let target: HTMLElement | null = null
      let targetOffset = L3_CONVERSATION_TOP_GUTTER_PX
      const snapshot = initializing && running ? entrySnapshotRef.current : null
      if (snapshot) {
        const savedTarget = findL3ConversationMessage(
          scrollElement,
          'data-chat-scroll-anchor',
          snapshot.messageId
        )
        if (savedTarget) {
          target = savedTarget
          targetOffset = snapshot.offset
        }
      }
      if (!target && latestUserAnchor) {
        target = findL3ConversationMessage(
          scrollElement,
          'data-chat-scroll-anchor',
          latestUserAnchor
        )
      }
      target ??= findL3ConversationMessage(scrollElement, 'data-chat-user-message')

      const followAfterPosition = target !== null && snapshot === null && (running || !initializing)
      const enterRunningAtBottom = initializing && running && snapshot === null
      if (target) {
        stopScroll()
        positionL3ConversationMessage(scrollElement, target, targetOffset, containsTail)
        if (enterRunningAtBottom) {
          // 无快照表示应继续吸底；首帧同步置底，后置收敛不再产生可见移动。
          scrollElement.scrollTop = Math.max(
            0,
            scrollElement.scrollHeight - scrollElement.clientHeight
          )
          void scrollToBottom({ animation: 'instant' })
        }
      } else {
        clearL3ConversationTailSpacer(scrollElement)
        scrollElement.scrollTop = Math.max(
          0,
          scrollElement.scrollHeight - scrollElement.clientHeight
        )
        void scrollToBottom({ animation: 'instant' })
      }

      logL3ConversationScroll('viewport:initialize:positioned', scrollElement, {
        initializing,
        running,
        target: target?.dataset.chatScrollAnchor ?? null,
        followAfterPosition,
        enterRunningAtBottom
      })
      initializedRef.current = true
      positionedUserAnchorRef.current = latestUserAnchor
      entrySnapshotRef.current = null
      if (initializing && !running && target) {
        // 首屏的懒布局仍会改变高度；用户开始操作后立即交还阅读位置。
        const entryTarget = target
        markProgrammaticScroll(state, scrollElement)
        const observer = new ResizeObserver(() => {
          stopScroll()
          positionL3ConversationMessage(scrollElement, entryTarget, targetOffset, containsTail)
          markProgrammaticScroll(state, scrollElement)
        })
        observer.observe(scrollElement)
        if (scrollElement.firstElementChild) observer.observe(scrollElement.firstElementChild)
        const interactionElement = scrollElement.parentElement!
        const events = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'click'] as const
        const release = (): void => {
          observer.disconnect()
          for (const event of events) interactionElement.removeEventListener(event, release, true)
          releaseEntryAnchor = null
          positioningRef.current = false
        }
        for (const event of events) {
          interactionElement.addEventListener(event, release, { passive: true, capture: true })
        }
        releaseEntryAnchor = release
      }
      releaseFrame = window.requestAnimationFrame(() => {
        if (followAfterPosition) void scrollToBottom({ animation: 'instant' })
        else if (target) stopScroll()
        positioningRef.current = releaseEntryAnchor !== null
      })
    }

    // 首次挂载必须在首帧绘制前定位；后续新用户消息仍等待一帧完成布局。
    if (initializing && scrollRef.current) position()
    else positionFrame = window.requestAnimationFrame(position)

    return () => {
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame)
      if (releaseFrame !== null) window.cancelAnimationFrame(releaseFrame)
      releaseEntryAnchor?.()
      positioningRef.current = false
    }
  }, [
    containsTail,
    latestUserAnchor,
    onClearSnapshot,
    onResetToTail,
    pageVisible,
    ready,
    running,
    scrollRef,
    scrollToBottom,
    state,
    stopScroll,
    visible
  ])

  useEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement || !visible) return

    const resumeFollowAtBottom = (): void => {
      logL3ConversationScroll('viewport:scroll', scrollElement, {
        positioning: positioningRef.current,
        isAtBottom: state.isAtBottom,
        escapedFromLock: state.escapedFromLock,
        resizeDifference: state.resizeDifference
      })
      if (positioningRef.current || state.isAtBottom) return
      const turn = activeTailTurn(scrollElement)
      if (!turn || turn.dataset.chatTailAnchor !== latestUserAnchor) return
      const distanceFromBottom =
        scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
      if (distanceFromBottom <= BOTTOM_THRESHOLD_PX) {
        logL3ConversationScroll('viewport:resume-follow', scrollElement, {
          isAtBottom: state.isAtBottom,
          escapedFromLock: state.escapedFromLock
        })
        void scrollToBottom({ animation: 'instant' })
      }
    }

    scrollElement.addEventListener('scroll', resumeFollowAtBottom, { passive: true })
    return () => scrollElement.removeEventListener('scroll', resumeFollowAtBottom)
  }, [latestUserAnchor, scrollRef, scrollToBottom, state, visible])

  useLayoutEffect(() => {
    if (!running || !visible) return
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    const save = (): void => {
      if (positioningRef.current) return
      const snapshot = captureSnapshot(scrollElement)
      if (snapshot) onSaveSnapshot(snapshot)
      else onClearSnapshot()
    }
    scrollElement.addEventListener('scroll', save, { passive: true })
    return () => {
      scrollElement.removeEventListener('scroll', save)
      save()
    }
  }, [onClearSnapshot, onSaveSnapshot, running, scrollRef, visible])

  return null
}
