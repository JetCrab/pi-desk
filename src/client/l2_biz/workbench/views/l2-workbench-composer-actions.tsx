'use client'

import { ArrowRightIcon, ArrowUpToLineIcon, LoaderCircleIcon } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PromptInputButton } from '@client/l4_foundation/ui/ai-elements/prompt-input'
import styles from '../l2-workbench-chat-composer.module.css'

const ARROW_OUTLINE =
  'M19 4 A1 1 0 0 1 21 4 V11 A5 5 0 0 1 16 16 H6.4142 L9.7071 19.2929 A1 1 0 0 1 8.2929 20.7071 L3.2929 15.7071 A1 1 0 0 1 3.2929 14.2929 L8.2929 9.2929 A1 1 0 0 1 9.7071 10.7071 L6.4142 14 H16 A3 3 0 0 0 19 11 Z'
const STOP_OUTLINE =
  'M18 4 A2 2 0 0 1 20 6 V18 A2 2 0 0 1 18 20 H6 A2 2 0 0 1 4 18 V6 A2 2 0 0 1 6 4 Z'
const POINT_COUNT = 160

type OutlinePoint = readonly [number, number]

function sampleOutline(outline: string): OutlinePoint[] {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', outline)
  const length = path.getTotalLength()
  return Array.from({ length: POINT_COUNT }, (_, index) => {
    const point = path.getPointAtLength((index / POINT_COUNT) * length)
    return [point.x, point.y]
  })
}

function interpolateOutline(
  arrow: readonly OutlinePoint[],
  stop: readonly OutlinePoint[],
  progress: number
): string {
  return (
    arrow
      .map(([x, y], index) => {
        const nextX = x + (stop[index][0] - x) * progress
        const nextY = y + (stop[index][1] - y) * progress
        return `${index === 0 ? 'M' : 'L'}${nextX.toFixed(3)} ${nextY.toFixed(3)}`
      })
      .join(' ') + 'Z'
  )
}

function ComposerMorphIcon({ stopping }: { stopping: boolean }): React.JSX.Element {
  const pathRef = useRef<SVGPathElement | null>(null)
  const progressRef = useRef(stopping ? 1 : 0)
  const outlinesRef = useRef<{ arrow: OutlinePoint[]; stop: OutlinePoint[] } | null>(null)
  // React 不随目标更新 d，途中反向直接沿用上一帧轮廓。
  const [initialOutline] = useState(stopping ? STOP_OUTLINE : ARROW_OUTLINE)

  useLayoutEffect(() => {
    const path = pathRef.current
    if (!path) return
    const target = stopping ? 1 : 0
    const start = progressRef.current
    if (start === target) return

    const outlines = (outlinesRef.current ??= {
      arrow: sampleOutline(ARROW_OUTLINE),
      stop: sampleOutline(STOP_OUTLINE)
    })
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const paint = (progress: number): void => {
      progressRef.current = progress
      path.setAttribute('d', interpolateOutline(outlines.arrow, outlines.stop, progress))
    }
    const started = performance.now()
    const duration = 280 * Math.abs(target - start)
    let frame = 0
    const tick = (now: number): void => {
      const elapsed = Math.min(1, (now - started) / duration)
      paint(start + (target - start) * (1 - (1 - elapsed) ** 3))
      if (elapsed < 1) frame = window.requestAnimationFrame(tick)
    }
    const finish = (): void => {
      window.cancelAnimationFrame(frame)
      paint(target)
    }
    if (reducedMotion.matches) finish()
    else frame = window.requestAnimationFrame(tick)
    reducedMotion.addEventListener('change', finish)
    return () => {
      window.cancelAnimationFrame(frame)
      reducedMotion.removeEventListener('change', finish)
    }
  }, [stopping])

  return (
    <svg className="size-4 fill-current" viewBox="0 0 24 24" aria-hidden="true">
      <path ref={pathRef} d={initialOutline} />
    </svg>
  )
}

interface L2WorkbenchComposerActionsProps {
  ready: boolean
  stopping: boolean
  expanded: boolean
  sendDisabled: boolean
  stopDisabled: boolean
  onSend: () => void
  onFollowUp: () => void
  onInterrupt: () => void
}

export function L2WorkbenchComposerActions({
  ready,
  stopping,
  expanded,
  sendDisabled,
  stopDisabled,
  onSend,
  onFollowUp,
  onInterrupt
}: L2WorkbenchComposerActionsProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const mainLabel = stopping ? t('stopResponse') : ready ? t('send') : t('synchronizing')

  return (
    <div className={styles.actions} data-composer-actions data-expanded={expanded}>
      <div className={styles.runningActionsClip} inert={!expanded} aria-hidden={!expanded}>
        <div className={styles.runningActions} data-composer-running-actions>
          <PromptInputButton
            className={styles.actionButton}
            tooltip={t('steerNow')}
            aria-label={t('steerNow')}
            variant="secondary"
            disabled={!expanded || sendDisabled}
            onClick={onSend}
          >
            <ArrowRightIcon className="size-4" />
          </PromptInputButton>
          <PromptInputButton
            className={styles.actionButton}
            tooltip={t('sendFollowUp')}
            aria-label={t('sendFollowUp')}
            variant="outline"
            disabled={!expanded || sendDisabled}
            onClick={onFollowUp}
          >
            <ArrowUpToLineIcon className="size-4" />
          </PromptInputButton>
        </div>
      </div>
      <PromptInputButton
        data-composer-main-action
        data-stopping={stopping}
        className={`${styles.actionButton} ${styles.mainAction}`}
        type={stopping ? 'button' : 'submit'}
        variant="default"
        tooltip={mainLabel}
        aria-label={mainLabel}
        disabled={stopping ? stopDisabled : sendDisabled}
        onClick={stopping ? onInterrupt : undefined}
      >
        {!ready ? (
          <LoaderCircleIcon className="size-4 animate-spin" />
        ) : (
          <ComposerMorphIcon stopping={stopping} />
        )}
      </PromptInputButton>
    </div>
  )
}
