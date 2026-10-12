'use client'

import dynamic from 'next/dynamic'
import { Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import styles from './l2-context-guide-demo.module.css'

function subscribeViewport(listener: () => void): () => void {
  const media = window.matchMedia('(max-width: 640px)')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

function narrowViewport(): boolean {
  return window.matchMedia('(max-width: 640px)').matches
}

const ContextUsageAnimation = dynamic(
  () => import('./l2-context-guide-demo').then((module) => module.ContextUsageAnimation),
  { ssr: false, loading: () => <ContextUsageVideo /> }
)

function ContextUsageVideo(): ReactElement {
  const video = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState(false)
  const requested = useRef(false)

  useEffect(() => {
    const element = video.current
    if (!element) return
    let visible = false
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    requested.current = !reduced.matches
    const sync = (): void => {
      if (visible && !document.hidden && requested.current) {
        void element.play().catch(() => setPlaying(false))
      } else element.pause()
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.intersectionRatio >= 0.35
        if (visible && !element.src) {
          element.src = '/media/docs/context-ignore-demo.mp4'
          element.load()
        }
        sync()
      },
      { threshold: [0, 0.35] }
    )
    const onMotion = (): void => {
      requested.current = !reduced.matches
      sync()
    }
    observer.observe(element)
    document.addEventListener('visibilitychange', sync)
    reduced.addEventListener('change', onMotion)
    return () => {
      element.pause()
      observer.disconnect()
      document.removeEventListener('visibilitychange', sync)
      reduced.removeEventListener('change', onMotion)
    }
  }, [])

  return (
    <figure className={styles.usage} aria-label="上下文忽略操作视频">
      <div className={styles.demoHeading}>
        <span>
          跟着做一次 <span className={styles.eyebrow}>· 操作示意</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={playing ? '暂停教学视频' : '播放教学视频'}
          onClick={() => {
            const element = video.current
            if (!element) return
            requested.current = element.paused
            if (requested.current) void element.play().catch(() => setPlaying(false))
            else element.pause()
          }}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? '暂停' : '播放'}
        </Button>
      </div>
      <video
        ref={video}
        className={styles.teachingVideo}
        width={766}
        height={520}
        poster="/media/docs/context-ignore-demo.webp"
        muted
        loop
        playsInline
        preload="none"
        aria-label="从工作台找到上下文入口并执行忽略的视频"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => {
          console.warn('[上下文教程] 操作视频未能加载')
          setError(true)
        }}
      />
      <figcaption className={styles.videoNote}>
        {error
          ? '视频暂时无法播放，可以按照下方步骤操作。'
          : '从完整工作台开始，跟随光标找到入口 · 示例用量'}
      </figcaption>
    </figure>
  )
}

export function ContextUsageDemo(): ReactElement {
  const mobile = useSyncExternalStore(subscribeViewport, narrowViewport, () => true)
  return mobile ? <ContextUsageVideo /> : <ContextUsageAnimation />
}
