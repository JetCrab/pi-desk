'use client'

import { Pause, Play } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement
} from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import styles from './l2-background-tasks-demo.module.css'

type DemoMediaProps = {
  slug: string
  label: string
  heading: string
  caption: string
  controlLabel: string
  Animation: ComponentType
}

function subscribeViewport(listener: () => void): () => void {
  const media = window.matchMedia('(max-width: 640px)')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

function narrowViewport(): boolean {
  return window.matchMedia('(max-width: 640px)').matches
}

function DemoVideo({ slug, label, heading, caption, controlLabel }: DemoMediaProps): ReactElement {
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
          element.src = `/media/docs/${slug}-demo.mp4`
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
  }, [slug])

  return (
    <figure className={styles.demo} aria-label={`${label}操作示意`}>
      <div className={styles.demoHeading}>
        <span>
          {heading} <span>· 操作示意</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${playing ? '暂停' : '播放'}${controlLabel}`}
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
        poster={`/media/docs/${slug}-demo.webp`}
        muted
        loop
        playsInline
        preload="none"
        aria-label={`${label}操作视频`}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => {
          console.warn(`[${label}教程] 操作视频未能加载`)
          setError(true)
        }}
      />
      <figcaption className={styles.videoNote}>
        {error ? '视频暂时无法播放，可以按照下方步骤操作。' : caption}
      </figcaption>
    </figure>
  )
}

export function DocsDemoMedia(props: DemoMediaProps): ReactElement {
  const mobile = useSyncExternalStore(subscribeViewport, narrowViewport, () => true)
  const { Animation } = props
  return mobile ? <DemoVideo {...props} /> : <Animation />
}
