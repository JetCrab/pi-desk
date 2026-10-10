'use client'

import Viewer from 'viewerjs'
import { useEffect, useId, useMemo, useRef } from 'react'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import type { L4Locale } from '@common/l4_foundation/locale/l4-locale'

export interface L4ImageViewerSlide {
  src: string
  alt: string
  width?: number
  height?: number
}

interface L4ImageViewerBaseProps {
  slides: readonly L4ImageViewerSlide[]
  index?: number
  onIndexChange?: (index: number) => void
  className?: string
  ariaLabel?: string
  thumbnails?: boolean
}

interface L4ModalImageViewerProps extends L4ImageViewerBaseProps {
  mode: 'modal'
  open: boolean
  onClose: () => void
}

interface L4InlineImageViewerProps extends L4ImageViewerBaseProps {
  mode: 'inline'
}

export type L4ImageViewerProps = L4ModalImageViewerProps | L4InlineImageViewerProps

interface L4ViewerRuntime extends Viewer {
  resize(): void
  fulled: boolean
  viewed: boolean
  image?: HTMLImageElement
  options: Viewer.Options
}

const TOOLBAR_LABELS = [
  ['.viewer-zoom-in', '放大', 'Zoom in'],
  ['.viewer-zoom-out', '缩小', 'Zoom out'],
  ['.viewer-one-to-one', '原始尺寸', 'Actual size'],
  ['.viewer-reset', '重置', 'Reset'],
  ['.viewer-prev', '上一张', 'Previous image'],
  ['.viewer-next', '下一张', 'Next image'],
  ['.viewer-rotate-left', '向左旋转', 'Rotate left'],
  ['.viewer-rotate-right', '向右旋转', 'Rotate right']
] as const

function createToolbar(multiple: boolean): Viewer.ToolbarOptions {
  return {
    prev: multiple,
    zoomOut: true,
    zoomIn: true,
    oneToOne: { show: 2 },
    reset: true,
    rotateLeft: { show: 2 },
    rotateRight: { show: 2 },
    next: multiple
  }
}

function readViewerIndex(event: CustomEvent): number | null {
  const detail: unknown = event.detail
  if (typeof detail !== 'object' || detail === null) return null
  const index = Reflect.get(detail, 'index')
  return typeof index === 'number' && Number.isInteger(index) ? index : null
}

function viewerRoot(instanceClass: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${instanceClass}`)
}

function updateCounter(instanceClass: string, index: number, total: number): void {
  const counter = viewerRoot(instanceClass)?.querySelector<HTMLElement>(
    '[data-pi-desk-viewer-counter]'
  )
  if (counter) counter.textContent = `${index + 1} / ${total}`
}

function decorateViewer(
  instanceClass: string,
  inline: boolean,
  ariaLabel: string,
  total: number,
  initialIndex: number,
  locale: L4Locale
): void {
  const root = viewerRoot(instanceClass)
  if (!root) return

  root.setAttribute('aria-label', ariaLabel)
  root.setAttribute('lang', locale)

  for (const [selector, chinese, english] of TOOLBAR_LABELS) {
    const control = root.querySelector<HTMLElement>(selector)
    if (!control) continue
    const label = locale === 'en' ? english : chinese
    control.setAttribute('aria-label', label)
    control.setAttribute('title', label)
  }

  labelViewerImages(root, locale)

  const cornerButton = root.querySelector<HTMLElement>('.viewer-button')
  if (cornerButton) {
    const updateCornerButtonLabel = (): void => {
      const label = inline
        ? cornerButton.classList.contains('viewer-fullscreen-exit')
          ? locale === 'en'
            ? 'Exit fullscreen'
            : '退出全屏'
          : locale === 'en'
            ? 'View image fullscreen'
            : '全屏查看图片'
        : locale === 'en'
          ? 'Close image preview'
          : '关闭图片预览'
      cornerButton.setAttribute('aria-label', label)
      cornerButton.setAttribute('title', label)
    }
    updateCornerButtonLabel()
    if (inline) {
      cornerButton.addEventListener('click', () => requestAnimationFrame(updateCornerButtonLabel))
    }
  }

  if (total > 1) {
    const counter = document.createElement('div')
    counter.className = 'pi-desk-image-viewer-counter'
    counter.dataset.piDeskViewerCounter = ''
    counter.setAttribute('aria-live', 'polite')
    counter.textContent = `${initialIndex + 1} / ${total}`
    root.appendChild(counter)
  }
}

function labelViewerImages(root: HTMLElement | null, locale: L4Locale): void {
  root?.querySelectorAll<HTMLElement>('.viewer-list > li').forEach((item, index) => {
    const label = locale === 'en' ? `View image ${index + 1}` : `查看第 ${index + 1} 张图片`
    item.setAttribute('aria-label', label)
    item.setAttribute('title', label)
  })
}

export function L4ImageViewer(props: L4ImageViewerProps): React.JSX.Element | null {
  const { locale } = useL4Region()
  const {
    slides,
    index = 0,
    onIndexChange,
    className,
    thumbnails = true,
    ariaLabel = locale === 'en' ? 'Image preview' : '图片预览'
  } = props
  const inline = props.mode === 'inline'
  const active = props.mode === 'inline' || props.open
  const modalOnClose = props.mode === 'modal' ? props.onClose : undefined
  const multiple = slides.length > 1
  const safeIndex = Math.min(Math.max(index, 0), Math.max(slides.length - 1, 0))
  const instanceClass = `pi-desk-image-viewer-${useId().replaceAll(':', '')}`
  const sourceRef = useRef<HTMLSpanElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<L4ViewerRuntime | null>(null)
  const appliedSlideSignatureRef = useRef('')
  const slideSignatureRef = useRef('')
  const currentIndexRef = useRef(safeIndex)
  const initialIndexRef = useRef(safeIndex)
  const onIndexChangeRef = useRef(onIndexChange)
  const onCloseRef = useRef(modalOnClose)
  const slideSignature = useMemo(
    () => JSON.stringify(slides.map((slide) => [slide.src, slide.alt])),
    [slides]
  )
  const viewerClassName = cn(
    'pi-desk-image-viewer',
    inline ? 'pi-desk-image-viewer-inline' : 'pi-desk-image-viewer-modal',
    instanceClass,
    className
  )

  useEffect(() => {
    slideSignatureRef.current = slideSignature
  }, [slideSignature])

  useEffect(() => {
    initialIndexRef.current = safeIndex
  }, [safeIndex])

  useEffect(() => {
    onIndexChangeRef.current = onIndexChange
  }, [onIndexChange])

  useEffect(() => {
    onCloseRef.current = modalOnClose
  }, [modalOnClose])

  useEffect(() => {
    const source = sourceRef.current
    if (!source || !active || slides.length === 0) return

    let disposed = false
    let viewer: L4ViewerRuntime | null = null
    let resizeFrame = 0
    let resizeObserver: ResizeObserver | null = null
    const handleEscape = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !viewer?.fulled
      )
        return
      // Viewer.js 自身关闭时不 preventDefault，且会与下层弹窗同时响应。
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!event.repeat) {
        viewerRoot(instanceClass)?.querySelector<HTMLElement>('.viewer-button')?.click()
      }
    }
    window.addEventListener('keydown', handleEscape, true)
    const initialize = (): void => {
      if (disposed) return
      const initialIndex = initialIndexRef.current
      currentIndexRef.current = initialIndex
      const touchCapable =
        window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
      viewer = new Viewer(source, {
        inline,
        initialViewIndex: initialIndex,
        initialCoverage: inline ? 0.82 : 0.88,
        minWidth: 0,
        minHeight: 0,
        minZoomRatio: 0.05,
        maxZoomRatio: 8,
        zoomRatio: 0.12,
        zIndex: 200,
        zIndexInline: 1,
        backdrop: inline ? false : true,
        button: true,
        focus: true,
        keyboard: true,
        loading: true,
        loop: false,
        movable: true,
        navbar: multiple && thumbnails ? 2 : false,
        rotatable: true,
        scalable: false,
        slideOnTouch: multiple,
        title: inline ? false : 1,
        toolbar: createToolbar(multiple),
        tooltip: true,
        transition: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        toggleOnDblclick: !touchCapable,
        zoomable: true,
        zoomOnTouch: true,
        zoomOnWheel: true,
        className: viewerClassName,
        ready: () =>
          decorateViewer(instanceClass, inline, ariaLabel, slides.length, initialIndex, locale),
        view: (event) => {
          const nextIndex = readViewerIndex(event)
          if (nextIndex === null) return
          // 切图时不使用 Viewer.js 从零尺寸展开的动画；缩放等操作仍保留过渡。
          if (multiple && viewerRef.current) viewerRef.current.options.transition = false
          currentIndexRef.current = nextIndex
          updateCounter(instanceClass, nextIndex, slides.length)
          onIndexChangeRef.current?.(nextIndex)
        },
        viewed: () => {
          const runtime = viewerRef.current
          if (!multiple || !runtime?.image) return
          const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
          runtime.options.transition = !reducedMotion
          if (reducedMotion) return
          // 先提交最终尺寸，再恢复操作过渡，避免初始零尺寸被浏览器一起动画化。
          runtime.image.getBoundingClientRect()
          runtime.image.classList.add('viewer-transition')
          runtime.image.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 150,
            easing: 'ease-out'
          })
        },
        hidden: () => onCloseRef.current?.()
      }) as L4ViewerRuntime

      viewerRef.current = viewer
      appliedSlideSignatureRef.current = slideSignatureRef.current
      if (inline && hostRef.current) {
        resizeObserver = new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame)
          resizeFrame = requestAnimationFrame(() => viewer?.resize())
        })
        resizeObserver.observe(hostRef.current)
      } else {
        viewer.show()
      }
    }

    // Viewer.js 无法彻底撤销等待 img.load 的内嵌初始化；在外层等待并隔离卸载。
    const images = Array.from(source.querySelectorAll('img'))
    if (inline && images.some((image) => !image.complete)) {
      void Promise.all(images.map((image) => image.decode().catch(() => undefined))).then(
        initialize
      )
    } else {
      initialize()
    }

    return () => {
      disposed = true
      window.removeEventListener('keydown', handleEscape, true)
      resizeObserver?.disconnect()
      cancelAnimationFrame(resizeFrame)
      if (viewerRef.current === viewer) viewerRef.current = null
      viewer?.destroy()
    }
  }, [
    active,
    ariaLabel,
    inline,
    instanceClass,
    locale,
    multiple,
    slides.length,
    thumbnails,
    viewerClassName
  ])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || appliedSlideSignatureRef.current === slideSignature) return
    appliedSlideSignatureRef.current = slideSignature
    const currentIndex = currentIndexRef.current
    const sourceImage = sourceRef.current?.querySelectorAll('img')[currentIndex]
    const refreshCurrent =
      viewer.image?.src !== sourceImage?.src || viewer.image?.alt !== sourceImage?.alt
    // update() 会自动重看已变化的图片；由这里统一刷新，避免重复切图或临时跳到其他索引。
    if (refreshCurrent) viewer.viewed = false
    viewer.update()
    if (refreshCurrent) viewer.view(currentIndex)
    labelViewerImages(viewerRoot(instanceClass), locale)
  }, [instanceClass, locale, slideSignature])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || currentIndexRef.current === safeIndex) return
    viewer.view(safeIndex)
  }, [safeIndex])

  if (slides.length === 0 || !active) return null

  const source = (
    <span ref={sourceRef} className="pi-desk-image-viewer-source" aria-hidden="true">
      {slides.map((slide, slideIndex) => (
        // Viewer.js 通过真实 img 元素读取 Blob URL、自然尺寸和缩略图。
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={slideIndex}
          src={slide.src}
          alt={slide.alt}
          width={slide.width}
          height={slide.height}
          decoding="async"
          draggable={false}
        />
      ))}
    </span>
  )

  if (!inline) return source

  return (
    <div
      ref={hostRef}
      className="pi-desk-image-viewer-host"
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={(event) => {
        const viewer = viewerRef.current
        if (
          !viewer ||
          viewer.fulled ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.nativeEvent.isComposing
        )
          return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'ArrowLeft') viewer.prev(false)
          else viewer.next(false)
        }
      }}
    >
      {source}
    </div>
  )
}
