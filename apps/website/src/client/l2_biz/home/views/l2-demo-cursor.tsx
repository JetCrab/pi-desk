'use client'

import { MousePointer2 } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState, type ReactElement, type RefObject } from 'react'
import type { ShowcaseChapterId } from '../l2-showcase-story'
import { getShowcaseCue } from '../l2-showcase-cues'

type GuidePoint = {
  x: number
  y: number
  top: number
  left: number
  width: number
  height: number
  calloutX: number
  calloutY: number
  calloutWidth: number
  guide?: string
  description?: string
  waiting: boolean
  identity: string
  targetName: string
}

export function DemoCursor({
  root,
  chapter,
  step,
  running,
  progress = 0
}: {
  root: RefObject<HTMLDivElement | null>
  chapter: ShowcaseChapterId
  step: number
  running: boolean
  progress?: number
}): ReactElement | null {
  const [point, setPoint] = useState<GuidePoint | null>(null)
  const approaching = progress >= 0.08
  const openingDrawer = chapter === 'pin' && step === 7 && progress < 0.58
  useEffect(() => {
    const stage = root.current
    if (!stage || !running || !approaching) return
    let frame = 0
    const update = (): void => {
      const outer = stage.getBoundingClientRect()
      const pc = stage.querySelector<HTMLElement>('[aria-label="PC 演示"]')
      const desktopVisible = pc && pc.getBoundingClientRect().width > 0
      const phone = stage.querySelector<HTMLElement>('[aria-label="手机演示"]')
      const mobileVisible = phone && phone.getBoundingClientRect().width > 0
      const preferMobile = getShowcaseCue(chapter, step)?.terminal === 'mobile' && mobileVisible
      const scope = preferMobile ? phone : desktopVisible ? pc : (phone ?? stage)
      const scopeBounds = scope.getBoundingClientRect()
      let target = getShowcaseCue(chapter, step, scope === phone)
      if (chapter === 'sync' && step === 3 && desktopVisible && !mobileVisible)
        target = {
          ...target,
          label: undefined,
          selector: '[data-demo-focus="sync-desktop"] > header'
        }
      if (openingDrawer && !desktopVisible)
        target = {
          label: '打开会话列表',
          guide: '打开会话列表',
          description: '在列表里取消固定，聊天不会被删除。'
        }
      const candidates = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [data-demo-focus] > header, [data-guide-target], [aria-label="快捷入口"]'
        )
      ).filter((element) => {
        const rect = element.getBoundingClientRect()
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          getComputedStyle(element).visibility === 'hidden' ||
          rect.top < outer.top ||
          rect.bottom > outer.bottom ||
          rect.left < scopeBounds.left - 1 ||
          rect.right > scopeBounds.right + 1
        )
          return false
        for (
          let parent = element.parentElement;
          parent && parent !== stage;
          parent = parent.parentElement
        ) {
          const style = getComputedStyle(parent),
            bounds = parent.getBoundingClientRect()
          if (
            /(auto|scroll|hidden|clip)/.test(style.overflowY) &&
            (rect.top < bounds.top - 2 || rect.bottom > bounds.bottom + 2)
          )
            return false
        }
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        )
        return hit !== null && (hit === element || element.contains(hit))
      })
      const primary = target
        ? candidates.filter((element) => {
            const label = element.getAttribute('aria-label') ?? ''
            if (target.selector) return element.matches(target.selector)
            if (element.tagName !== 'BUTTON') return false
            return target.label
              ? label === target.label
              : target.prefix
                ? label.startsWith(target.prefix)
                : element.textContent?.trim() === target.text
          })
        : []
      const fallback = target?.fallback
        ? candidates.filter((element) => element.getAttribute('aria-label') === target.fallback)
        : []
      // 同名候选不猜DOM先后；目标身份由当前分镜声明。
      const element =
        primary.length === 1
          ? primary[0]
          : primary.length === 0 && fallback.length === 1
            ? fallback[0]
            : null
      if (!element || !target) {
        setPoint(null)
        frame = requestAnimationFrame(update)
        return
      }
      const bounds = element.getBoundingClientRect()
      const left = bounds.left - outer.left
      const top = bounds.top - outer.top
      const calloutWidth = Math.min(230, outer.width - 24)
      const rightSpace = outer.width - left - bounds.width
      const calloutX =
        rightSpace >= calloutWidth + 18
          ? left + bounds.width + 12
          : left >= calloutWidth + 18
            ? left - calloutWidth - 12
            : Math.max(12, Math.min(outer.width - calloutWidth - 12, left))
      const calloutY = Math.max(
        12,
        Math.min(
          outer.height - 100,
          rightSpace < calloutWidth + 18 && left < calloutWidth + 18
            ? top + bounds.height + 10
            : top - 6
        )
      )
      const next: GuidePoint = {
        x: Math.min(outer.width - 26, left + bounds.width * 0.65),
        y: Math.min(outer.height - 26, top + bounds.height * 0.6),
        top,
        left,
        width: bounds.width,
        height: bounds.height,
        calloutX,
        calloutY,
        calloutWidth,
        guide: target.guide,
        description: target.description,
        waiting: target.waiting ?? false,
        identity: `${chapter}:${step}`,
        targetName:
          element.getAttribute('aria-label') ??
          element.getAttribute('data-guide-target') ??
          element.textContent?.trim() ??
          ''
      }
      setPoint((previous) =>
        previous &&
        Object.entries(next).every(([key, value]) => previous[key as keyof GuidePoint] === value)
          ? previous
          : next
      )
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [root, chapter, step, running, approaching, openingDrawer])
  if (
    !running ||
    !approaching ||
    !getShowcaseCue(chapter, step) ||
    !point ||
    point.identity !== `${chapter}:${step}`
  )
    return null
  return (
    <>
      {progress >= 0.18 && (
        <motion.div
          key={`focus-${step}`}
          aria-hidden="true"
          className="pointer-events-none absolute z-20 rounded-md border border-foreground/60 shadow-[0_0_0_3px_var(--background)]"
          initial={{ opacity: 0 }}
          animate={{ opacity: progress > 0.94 ? 0 : 1 }}
          style={{
            top: point.top - 3,
            left: point.left - 3,
            width: point.width + 6,
            height: point.height + 6
          }}
        />
      )}
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 z-20"
        initial={{ x: point.x + 32, y: point.y + 24, opacity: 0 }}
        animate={{ x: point.x, y: point.y, opacity: 1 }}
        transition={{ duration: 0.32, ease: 'easeInOut' }}
        data-testid="demo-cursor"
        data-target={point.targetName}
      >
        {!point.waiting && (
          <motion.span
            className="absolute -left-2 -top-2 size-6 rounded-full border border-foreground/40 bg-background/60"
            animate={{
              scale: progress > 0.9 ? 1.65 : 1,
              opacity: progress > 0.9 ? 0 : 0.6
            }}
            transition={{ duration: 0.22 }}
          />
        )}
        {!point.waiting && (
          <MousePointer2
            size={25}
            className="relative fill-foreground stroke-background drop-shadow-sm"
          />
        )}
      </motion.div>
      {point.guide && progress >= 0.18 && (
        <motion.div
          key={`guide-${step}-${point.guide}`}
          data-testid="demo-action-guide"
          aria-hidden="true"
          className="pointer-events-none absolute z-20 rounded-lg border border-border bg-card px-3 py-2 shadow-md"
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: progress > 0.94 ? 0 : 1, y: 0 }}
          transition={{ duration: 0.12 }}
          style={{
            top: point.calloutY,
            left: point.calloutX,
            width: point.description ? point.calloutWidth : undefined
          }}
        >
          <p className="text-sm leading-5 font-medium">{point.guide}</p>
          {point.description && (
            <p className="mt-1 text-[13px] leading-[1.55] text-muted-foreground">
              {point.description}
            </p>
          )}
        </motion.div>
      )}
    </>
  )
}
