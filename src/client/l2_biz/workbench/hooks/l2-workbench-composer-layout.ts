'use client'

import { useLayoutEffect, useState, type RefObject } from 'react'

function pixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function elementChildren(element: HTMLElement): HTMLElement[] {
  return [...element.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
}

function measureRequiredElementWidths(
  elements: readonly HTMLElement[]
): ReadonlyMap<HTMLElement, number> {
  const uniqueElements = [...new Set(elements)]
  const previousStyles = uniqueElements.map((element) => ({
    element,
    flex: element.style.flex,
    width: element.style.width,
    minWidth: element.style.minWidth
  }))

  try {
    // 所有样式先统一写入，再连续读取尺寸，避免逐元素读写造成同步布局抖动。
    for (const { element } of previousStyles) {
      element.style.flex = '0 0 auto'
      element.style.width = 'max-content'
      element.style.minWidth = 'max-content'
    }
    return new Map(
      uniqueElements.map((element) => [element, element.getBoundingClientRect().width])
    )
  } finally {
    for (const { element, flex, width, minWidth } of previousStyles) {
      element.style.flex = flex
      element.style.width = width
      element.style.minWidth = minWidth
    }
  }
}

function requiredChildrenWidth(
  children: readonly HTMLElement[],
  gap: number,
  widths: ReadonlyMap<HTMLElement, number>
): number {
  return (
    children.reduce((width, child) => width + (widths.get(child) ?? 0), 0) +
    Math.max(0, children.length - 1) * gap
  )
}

export function useL2WorkbenchComposerLayout(
  mobile: boolean,
  footerRef: RefObject<HTMLDivElement | null>,
  submitToolsRef: RefObject<HTMLDivElement | null>,
  statusRef: RefObject<HTMLSpanElement | null>
): boolean {
  const [desktopMetadataRow, setDesktopMetadataRow] = useState(false)

  useLayoutEffect(() => {
    if (mobile) return

    const footer = footerRef.current
    const primaryTools = footer?.querySelector<HTMLElement>('[data-composer-tools="primary"]')
    const metadataTools = footer?.querySelector<HTMLElement>('[data-composer-tools="metadata"]')
    const submitTools = submitToolsRef.current
    if (!footer || !primaryTools || !metadataTools || !submitTools) return

    let availableWidth = 0
    let requiredWidth: number | null = null
    const updateLayout = (): void => {
      // 控件自然宽度不随桌面列宽变化；仅在内容或字体变化后重新测量。
      if (requiredWidth === null) {
        const footerStyle = window.getComputedStyle(footer)
        availableWidth =
          footer.clientWidth - pixels(footerStyle.paddingLeft) - pixels(footerStyle.paddingRight)
        // getComputedStyle 返回实时对象，必须在临时修改控件样式前读出数值。
        const footerGap = pixels(footerStyle.columnGap)
        const primaryChildren = elementChildren(primaryTools)
        const metadataChildren = elementChildren(metadataTools)
        const submitChildren = elementChildren(submitTools)
        const primaryGap = pixels(window.getComputedStyle(primaryTools).columnGap)
        const metadataGap = pixels(window.getComputedStyle(metadataTools).columnGap)
        const submitGap = pixels(window.getComputedStyle(submitTools).columnGap)
        const status = statusRef.current
        const widths = measureRequiredElementWidths([
          ...primaryChildren,
          ...metadataChildren,
          ...submitChildren,
          ...(status ? [status] : [])
        ])
        const itemWidths = [
          requiredChildrenWidth(primaryChildren, primaryGap, widths),
          requiredChildrenWidth(metadataChildren, metadataGap, widths),
          status ? (widths.get(status) ?? 0) : 0,
          requiredChildrenWidth(submitChildren, submitGap, widths)
        ].filter((width) => width > 0)
        requiredWidth =
          itemWidths.reduce((total, width) => total + width, 0) +
          Math.max(0, itemWidths.length - 1) * footerGap
      }
      setDesktopMetadataRow(requiredWidth > availableWidth + 1)
    }

    let updateFrame: number | null = null
    const scheduleUpdateLayout = (): void => {
      if (updateFrame !== null) return
      updateFrame = window.requestAnimationFrame(() => {
        updateFrame = null
        updateLayout()
      })
    }
    const invalidateMeasurement = (): void => {
      requiredWidth = null
      scheduleUpdateLayout()
    }
    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry || availableWidth === entry.contentRect.width) return
      availableWidth = entry.contentRect.width
      scheduleUpdateLayout()
    })
    const mutationObserver = new MutationObserver(invalidateMeasurement)
    resizeObserver.observe(footer)
    mutationObserver.observe(footer, { childList: true, characterData: true, subtree: true })
    window.addEventListener('resize', invalidateMeasurement)
    document.fonts.addEventListener('loadingdone', invalidateMeasurement)
    updateLayout()

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', invalidateMeasurement)
      document.fonts.removeEventListener('loadingdone', invalidateMeasurement)
      if (updateFrame !== null) window.cancelAnimationFrame(updateFrame)
    }
  }, [footerRef, mobile, statusRef, submitToolsRef])

  return desktopMetadataRow
}
