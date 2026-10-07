import { useCallback, useEffect, useRef } from 'react'
import type { CarouselApi } from '@client/l4_foundation/ui/shadcn/carousel'

type ReadyCarouselApi = NonNullable<CarouselApi>

interface HorizontalScroll {
  left: number
  maximum: number
}

interface ContentGesture {
  x: number
  y: number
  scrolls: HorizontalScroll[]
  owner: 'pending' | 'content' | 'previous' | 'next'
}

const SWIPE_LOCK_SELECTOR = [
  '[data-carousel-swipe-lock]',
  '[data-testid="file-workspace"]',
  '[data-streamdown="mermaid-block"]',
  '[data-slot="plugin-scrollbar"]',
  '[data-slot="scroll-area-scrollbar"]',
  '.monaco-editor',
  '[contenteditable="true"]',
  '[role="application"]',
  '[role="dialog"]',
  '[role="menu"]',
  'input',
  'textarea',
  'select',
  'a',
  'summary',
  'img'
].join(',')

const SCROLL_WRAPPER_SELECTOR = [
  '[data-streamdown="code-block"]',
  '[data-streamdown="table-wrapper"]',
  '[data-pi-desk-scroll]',
  '[data-slot="l4-scroll-area"]'
].join(',')

function horizontalScroll(element: HTMLElement): HorizontalScroll | null {
  const maximum = element.scrollWidth - element.clientWidth
  if (maximum <= 1 || !['auto', 'scroll'].includes(getComputedStyle(element).overflowX)) {
    return null
  }
  return { left: element.scrollLeft, maximum }
}

function contentScrolls(target: Element): HorizontalScroll[] {
  const scrolls: HorizontalScroll[] = []
  for (
    let element: Element | null = target;
    element && !element.matches('[data-slot="carousel-item"]');
    element = element.parentElement
  ) {
    if (!(element instanceof HTMLElement)) continue
    const scroll = horizontalScroll(element)
    if (scroll) scrolls.push(scroll)
    // 容器边框与留白不属于正文节点，但仍应使用同一滚动区的边缘判断。
    if (element.matches(SCROLL_WRAPPER_SELECTOR)) {
      for (const child of element.children) {
        if (!(child instanceof HTMLElement) || child.contains(target)) continue
        const childScroll = horizontalScroll(child)
        if (childScroll) scrolls.push(childScroll)
      }
    }
  }
  return scrolls
}

export function useL2WorkSessionCarouselGesture(
  api: CarouselApi,
  onEdgeSwipe: (api: ReadyCarouselApi) => void
): (api: ReadyCarouselApi, event: TouchEvent | MouseEvent) => boolean {
  const gestureRef = useRef<ContentGesture | null>(null)

  const watchDrag = useCallback(
    (_api: ReadyCarouselApi, event: TouchEvent | MouseEvent): boolean => {
      gestureRef.current = null
      const target = event.target
      if (!(target instanceof Element)) return true
      if (target.closest(SWIPE_LOCK_SELECTOR)) return false
      const button = target.closest('button')
      // 工具摘要整体是折叠按钮，触摸时仍应允许从摘要起滑切换会话。
      if (
        button &&
        (!('touches' in event) ||
          !button.matches('[data-slot="collapsible-trigger"]') ||
          !button.closest('[data-chat-scroll-anchor$=":tool"]'))
      ) {
        return false
      }
      const scrolls = contentScrolls(target)
      if (!('touches' in event)) {
        return !scrolls.length && !target.closest('pre,table,[data-streamdown="code-block"]')
      }
      if (event.touches.length !== 1) return false
      if (!scrolls.length) return true
      const touch = event.touches[0]!
      gestureRef.current = { x: touch.clientX, y: touch.clientY, scrolls, owner: 'pending' }
      return false
    },
    []
  )

  useEffect(() => {
    if (!api) return
    const root = api.rootNode()
    const clearGesture = (): void => {
      gestureRef.current = null
    }
    const handleMove = (event: TouchEvent): void => {
      const gesture = gestureRef.current
      if (!gesture) return
      if (event.touches.length !== 1) {
        clearGesture()
        return
      }
      const touch = event.touches[0]!
      const dx = touch.clientX - gesture.x
      const dy = touch.clientY - gesture.y
      if (gesture.owner === 'pending') {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return
        const contentCanScroll = gesture.scrolls.some((scroll) =>
          dx < 0 ? scroll.left < scroll.maximum - 1 : scroll.left > 1
        )
        // 归属按起滑时的位置固定，本次滑到边缘也不会突然切走窗口。
        gesture.owner =
          Math.abs(dy) >= Math.abs(dx) || contentCanScroll
            ? 'content'
            : dx < 0
              ? 'next'
              : 'previous'
      }
      if (gesture.owner === 'content') return
      if (!event.cancelable) {
        gesture.owner = 'content'
        return
      }
      event.preventDefault()
    }
    const handleEnd = (event: TouchEvent): void => {
      const gesture = gestureRef.current
      clearGesture()
      if (!gesture || gesture.owner === 'pending' || gesture.owner === 'content') return
      const touch = event.changedTouches[0]!
      const dx = touch.clientX - gesture.x
      const dy = touch.clientY - gesture.y
      const threshold = Math.max(50, Math.min(225, root.clientWidth * 0.2))
      const distance = gesture.owner === 'next' ? -dx : dx
      if (distance < threshold || Math.abs(dy) >= Math.abs(dx)) return
      if (gesture.owner === 'next' ? !api.canScrollNext() : !api.canScrollPrev()) return
      onEdgeSwipe(api)
      if (gesture.owner === 'next') api.scrollNext()
      else api.scrollPrev()
    }

    root.addEventListener('touchmove', handleMove, { passive: false })
    root.addEventListener('touchend', handleEnd)
    root.addEventListener('touchcancel', clearGesture)
    api.on('reInit', clearGesture)
    return () => {
      clearGesture()
      root.removeEventListener('touchmove', handleMove)
      root.removeEventListener('touchend', handleEnd)
      root.removeEventListener('touchcancel', clearGesture)
      api.off('reInit', clearGesture)
    }
  }, [api, onEdgeSwipe])

  return watchDrag
}
