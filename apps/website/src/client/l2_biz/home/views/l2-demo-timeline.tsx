'use client'

import { Tooltip } from '@base-ui/react/tooltip'
import { useRef, useState, type ReactElement } from 'react'
import { getShowcaseCue } from '../l2-showcase-cues'
import { showcaseChapters } from '../l2-showcase-story'
import styles from './l2-demo-timeline.module.css'

function timestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function DemoTimeline({
  chapter,
  step,
  stepProgress,
  progress,
  onSeek
}: {
  chapter: (typeof showcaseChapters)[number]
  step: number
  stepProgress: number
  progress: number
  onSeek: (step: number) => void
}): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const touchPreview = useRef<number | null>(null)
  const [openStep, setOpenStep] = useState<number | null>(null)
  const [mobile, setMobile] = useState(false)
  return (
    <Tooltip.Provider delay={180} closeDelay={100}>
      <div ref={rootRef} className={styles.timeline} aria-label="演示时间轴">
        <span
          className={styles.progress}
          role="progressbar"
          aria-label="演示进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-valuetext={`${chapter.steps[step].title}，${Math.round(progress * 100)}%`}
        />
        <ol className={styles.steps}>
          {chapter.steps.map((item, index) => {
            const start = chapter.steps
              .slice(0, index)
              .reduce((sum, item) => sum + item.duration, 0)
            const cue = getShowcaseCue(chapter.id, index, mobile)
            const waiting = cue === null || cue.waiting
            const title = cue?.guide ?? item.title
            const description = cue?.description ?? item.description
            return (
              <li key={index} className={styles.step} style={{ flexGrow: item.duration }}>
                <span className={styles.track} aria-hidden="true">
                  <span
                    style={{
                      transform: `scaleX(${index < step ? 1 : index === step ? stepProgress : 0})`
                    }}
                  />
                </span>
                <Tooltip.Root
                  triggerId={`showcase-cue-${chapter.id}-${index}`}
                  open={openStep === index}
                  onOpenChange={(open, details) => {
                    // 触控点选保留预览，不让残留的鼠标悬停回调抢走它。
                    if (
                      open &&
                      touchPreview.current !== null &&
                      touchPreview.current !== index &&
                      details.reason === 'trigger-hover'
                    ) {
                      details.cancel()
                      return
                    }
                    if (
                      !open &&
                      touchPreview.current === index &&
                      (details.reason === 'trigger-hover' ||
                        details.reason === 'trigger-focus' ||
                        details.reason === 'trigger-press' ||
                        details.reason === 'none')
                    ) {
                      details.cancel()
                      return
                    }
                    if (open) {
                      setMobile((rootRef.current?.getBoundingClientRect().width ?? 0) < 640)
                      setOpenStep(index)
                    } else {
                      if (touchPreview.current === index) touchPreview.current = null
                      setOpenStep((current) => (current === index ? null : current))
                    }
                  }}
                >
                  <Tooltip.Trigger
                    id={`showcase-cue-${chapter.id}-${index}`}
                    type="button"
                    closeOnClick={false}
                    className={styles.node}
                    data-timeline-step={index}
                    data-waiting={waiting || undefined}
                    data-complete={index < step || undefined}
                    aria-current={index === step ? 'step' : undefined}
                    aria-describedby={
                      openStep === index ? `showcase-cue-preview-${chapter.id}-${index}` : undefined
                    }
                    aria-label={`回到 ${timestamp(start)} ${waiting ? '等待或停留' : '提示'}：${title}`}
                    onPointerEnter={(event) => {
                      if (event.pointerType === 'mouse') touchPreview.current = null
                    }}
                    onPointerDown={(event) => {
                      touchPreview.current = event.pointerType === 'touch' ? index : null
                    }}
                    onClick={() => {
                      setMobile((rootRef.current?.getBoundingClientRect().width ?? 0) < 640)
                      setOpenStep(index)
                      onSeek(index)
                    }}
                    onKeyDown={(event) => {
                      const next =
                        event.key === 'ArrowLeft'
                          ? Math.max(0, index - 1)
                          : event.key === 'ArrowRight'
                            ? Math.min(chapter.steps.length - 1, index + 1)
                            : event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? chapter.steps.length - 1
                                : null
                      if (next === null) return
                      event.preventDefault()
                      rootRef.current
                        ?.querySelector<HTMLButtonElement>(`[data-timeline-step="${next}"]`)
                        ?.focus()
                    }}
                  >
                    <span aria-hidden="true" />
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Positioner
                      side="top"
                      align="center"
                      sideOffset={8}
                      collisionPadding={12}
                      className={styles.positioner}
                    >
                      <Tooltip.Popup
                        id={`showcase-cue-preview-${chapter.id}-${index}`}
                        role="tooltip"
                        className={styles.preview}
                      >
                        <p className={styles.time}>
                          {timestamp(start)} · {waiting ? '等待 / 停留' : '提示 / 操作'}
                        </p>
                        <p className={styles.title}>{title}</p>
                        <p className={styles.description}>{description}</p>
                      </Tooltip.Popup>
                    </Tooltip.Positioner>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </li>
            )
          })}
        </ol>
      </div>
    </Tooltip.Provider>
  )
}
