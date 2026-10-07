'use client'

import {
  Children,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'
import { useReducedMotion } from 'motion/react'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi
} from '@client/l4_foundation/ui/shadcn/carousel'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { useL2WorkSessionCarouselGesture } from './hooks/l2-work-session-carousel-gesture'

export interface L2WorkSessionMobileCarouselItem {
  workId: string
  projectName: string
  sessionTitle: string | null
  fixed: boolean
}

interface L2WorkSessionMobileCarouselProps {
  items: readonly L2WorkSessionMobileCarouselItem[]
  activeWorkId: string | null
  onActiveWorkSessionChange: (workId: string) => void
  children: ReactNode
}

interface PositionIndicatorState {
  index: number
  position: number
  visible: boolean
}

type ReadyCarouselApi = NonNullable<CarouselApi>

const POSITION_INDICATOR_HIDE_DELAY_MS = 900

function clampPosition(value: number, itemCount: number): number {
  return Math.max(0, Math.min(itemCount - 1, value))
}

function displayTitle(item: L2WorkSessionMobileCarouselItem): string {
  return item.sessionTitle ? `${item.projectName} · ${item.sessionTitle}` : item.projectName
}

export function L2WorkSessionMobileCarousel({
  items,
  activeWorkId,
  onActiveWorkSessionChange,
  children
}: L2WorkSessionMobileCarouselProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const reducedMotion = useReducedMotion()
  const slides = Children.toArray(children)
  const fallbackWorkId = items[0]?.workId ?? null
  const effectiveActiveWorkId = items.some((item) => item.workId === activeWorkId)
    ? activeWorkId
    : fallbackWorkId
  const [initialIndex] = useState(() =>
    Math.max(
      0,
      items.findIndex((item) => item.workId === effectiveActiveWorkId)
    )
  )
  const hideTimerRef = useRef<number | null>(null)
  const pointerDownRef = useRef(false)
  const [api, setApi] = useState<CarouselApi>()
  const [indicator, setIndicator] = useState<PositionIndicatorState>({
    index: initialIndex,
    position: initialIndex,
    visible: false
  })

  const clearHideTimer = useCallback((): void => {
    if (hideTimerRef.current === null) return
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }, [])

  const scheduleIndicatorHide = useCallback((): void => {
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      setIndicator((current) => (current.visible ? { ...current, visible: false } : current))
    }, POSITION_INDICATOR_HIDE_DELAY_MS)
  }, [clearHideTimer])

  const updateIndicator = useCallback(
    (carouselApi: ReadyCarouselApi, visible?: boolean): void => {
      const position = clampPosition(
        carouselApi.scrollProgress() * (items.length - 1),
        items.length
      )
      const index = Math.round(position)
      setIndicator((current) => {
        const nextVisible = visible ?? current.visible
        return current.index === index &&
          Math.abs(current.position - position) < 0.001 &&
          current.visible === nextVisible
          ? current
          : { index, position, visible: nextVisible }
      })
    },
    [items.length]
  )

  const handleEdgeSwipe = useCallback(
    (carouselApi: ReadyCarouselApi): void => {
      updateIndicator(carouselApi, true)
      scheduleIndicatorHide()
    },
    [scheduleIndicatorHide, updateIndicator]
  )
  const watchDrag = useL2WorkSessionCarouselGesture(api, handleEdgeSwipe)

  const carouselOptions = useMemo(
    () => ({
      align: 'start' as const,
      containScroll: 'trimSnaps' as const,
      dragFree: false,
      loop: false,
      skipSnaps: false,
      duration: reducedMotion ? 0 : 25,
      startIndex: initialIndex,
      watchDrag
    }),
    [initialIndex, reducedMotion, watchDrag]
  )

  useEffect(() => {
    if (!effectiveActiveWorkId || effectiveActiveWorkId === activeWorkId) return
    onActiveWorkSessionChange(effectiveActiveWorkId)
  }, [activeWorkId, effectiveActiveWorkId, onActiveWorkSessionChange])

  useLayoutEffect(() => {
    if (!api || !effectiveActiveWorkId) return
    const nextIndex = items.findIndex((item) => item.workId === effectiveActiveWorkId)
    if (nextIndex < 0 || api.selectedScrollSnap() === nextIndex) return
    api.scrollTo(nextIndex, true)
  }, [api, effectiveActiveWorkId, items])

  useEffect(() => {
    if (!api) return

    const handlePointerDown = (): void => {
      pointerDownRef.current = true
    }
    const handlePointerUp = (): void => {
      pointerDownRef.current = false
      scheduleIndicatorHide()
    }
    const handleScroll = (carouselApi: ReadyCarouselApi): void => {
      if (pointerDownRef.current) {
        clearHideTimer()
        updateIndicator(carouselApi, true)
        return
      }
      updateIndicator(carouselApi)
    }
    const handleSelect = (carouselApi: ReadyCarouselApi): void => {
      const selected = items[carouselApi.selectedScrollSnap()]
      if (selected && selected.workId !== activeWorkId) {
        onActiveWorkSessionChange(selected.workId)
      }
      updateIndicator(carouselApi)
    }
    const handleSettle = (carouselApi: ReadyCarouselApi): void => {
      updateIndicator(carouselApi)
      scheduleIndicatorHide()
    }
    const handleReInit = (carouselApi: ReadyCarouselApi): void => {
      updateIndicator(carouselApi, false)
    }

    api.on('pointerDown', handlePointerDown)
    api.on('pointerUp', handlePointerUp)
    api.on('scroll', handleScroll)
    api.on('select', handleSelect)
    api.on('settle', handleSettle)
    api.on('reInit', handleReInit)

    return () => {
      pointerDownRef.current = false
      api.off('pointerDown', handlePointerDown)
      api.off('pointerUp', handlePointerUp)
      api.off('scroll', handleScroll)
      api.off('select', handleSelect)
      api.off('settle', handleSettle)
      api.off('reInit', handleReInit)
    }
  }, [
    activeWorkId,
    api,
    clearHideTimer,
    items,
    onActiveWorkSessionChange,
    scheduleIndicatorHide,
    updateIndicator
  ])

  useEffect(() => clearHideTimer, [clearHideTimer])

  if (items.length <= 1) {
    return <div className="size-full min-h-0 min-w-0 overflow-hidden">{slides[0] ?? null}</div>
  }

  const indicatorItem = items[indicator.index] ?? items[0]!
  const indicatorWidth = `${100 / items.length}%`
  const indicatorOffset = `translate3d(${indicator.position * 100}%, 0, 0)`

  return (
    <Carousel
      opts={carouselOptions}
      setApi={setApi}
      aria-label={t('sessionWindows')}
      onKeyDownCapture={() => undefined}
      className="size-full min-h-0 min-w-0 [&_[data-slot=carousel-content]]:h-full [&_[data-slot=carousel-content]]:touch-auto"
    >
      <CarouselContent className="ml-0 h-full">
        {items.map((item, index) => (
          <CarouselItem
            key={item.workId}
            aria-label={`${index + 1} / ${items.length}，${displayTitle(item)}`}
            className="h-full pl-0"
          >
            {slides[index] ?? null}
          </CarouselItem>
        ))}
      </CarouselContent>
      <div
        aria-hidden="true"
        data-testid="mobile-work-session-position"
        className={cn(
          'pointer-events-none absolute top-16 left-1/2 z-30 w-[min(82vw,20rem)] -translate-x-1/2 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none',
          indicator.visible ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
        )}
      >
        <div className="rounded-xl border bg-popover px-3 py-2 text-popover-foreground shadow-lg">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="shrink-0 text-muted-foreground">
              {t(indicatorItem.fixed ? 'fixedSession' : 'primarySession')}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">
              {displayTitle(indicatorItem)}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {indicator.index + 1} / {items.length}
            </span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground"
              style={{ width: indicatorWidth, transform: indicatorOffset }}
            />
          </div>
        </div>
      </div>
    </Carousel>
  )
}
