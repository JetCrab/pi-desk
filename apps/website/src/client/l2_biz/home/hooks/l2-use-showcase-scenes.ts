'use client'

import { useEffect, useRef, useState, type ComponentType } from 'react'
import { showcaseChapters, type ShowcaseSceneProps } from '../l2-showcase-story'
import { PinScene } from '../views/scenes/l2-pin-scene'

type Scene = ComponentType<ShowcaseSceneProps>
const loaders: Array<() => Promise<Scene>> = [
  () => Promise.resolve(PinScene),
  () => import('../views/scenes/l2-sync-scene').then((module) => module.SyncScene),
  () => import('../views/scenes/l2-files-scene').then((module) => module.FilesScene),
  () => import('../views/scenes/l2-create-plugin-scene').then((module) => module.CreatePluginScene),
  () => import('../views/scenes/l2-install-scene').then((module) => module.InstallScene),
  () => import('../views/scenes/l2-context-scene').then((module) => module.ContextScene),
  () => import('../views/scenes/l2-branches-scene').then((module) => module.BranchesScene),
  () => import('../views/scenes/l2-agents-scene').then((module) => module.AgentsScene)
]
// 只有八个模块，缓存属于本次页面的代码生命周期，不保留演示实例或操作状态。
const modules: Array<Promise<Scene> | undefined> = [Promise.resolve(PinScene)]

function loadScene(chapter: number): Promise<Scene> {
  modules[chapter] ??= loaders[chapter]().catch((error: unknown) => {
    modules[chapter] = undefined
    throw error
  })
  return modules[chapter]!
}

export function useShowcaseScenes(): {
  chapter: number
  Scene: Scene
  loadingChapter: number | null
  failedChapter: number | null
  selectChapter: (chapter: number) => void
} {
  const [frame, setFrame] = useState<{ chapter: number; Scene: Scene }>({
    chapter: 0,
    Scene: PinScene
  })
  const [request, setRequest] = useState({ chapter: 0 })
  const latest = useRef<{ chapter: number } | null>(request)
  const [failed, setFailed] = useState(false)

  useEffect(
    () => () => {
      latest.current = null
    },
    []
  )

  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
    if (connection?.saveData) return
    let disposed = false
    let loading = false
    let chapter = 1
    let idle: number | null = null
    let timer: number | null = null

    function cancelScheduled(): void {
      if (idle !== null) window.cancelIdleCallback(idle)
      if (timer !== null) window.clearTimeout(timer)
      idle = null
      timer = null
    }

    function schedule(): void {
      if (disposed || document.hidden || loading || idle !== null || timer !== null) return
      while (chapter < loaders.length && modules[chapter]) chapter++
      if (chapter >= loaders.length) return
      if (typeof window.requestIdleCallback === 'function') {
        idle = window.requestIdleCallback(warmNext)
      } else {
        timer = window.setTimeout(warmNext, 300)
      }
    }

    function warmNext(): void {
      idle = null
      timer = null
      if (disposed || document.hidden) return
      loading = true
      const next = chapter++
      void loadScene(next).then(
        () => {
          loading = false
          schedule()
        },
        (error: unknown) => {
          loading = false
          console.warn('官网演示预加载暂停', showcaseChapters[next].title, error)
        }
      )
    }

    function onVisibility(): void {
      if (document.hidden) cancelScheduled()
      else schedule()
    }

    const firstFrame = window.requestAnimationFrame(schedule)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      window.cancelAnimationFrame(firstFrame)
      cancelScheduled()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return {
    chapter: frame.chapter,
    Scene: frame.Scene,
    loadingChapter: request.chapter !== frame.chapter && !failed ? request.chapter : null,
    failedChapter: failed ? request.chapter : null,
    selectChapter: (chapter) => {
      const next = { chapter }
      latest.current = next
      setFailed(false)
      setRequest(next)
      if (chapter === frame.chapter) return
      void loadScene(chapter).then(
        (Scene) => {
          if (latest.current !== next) return
          setFrame({ chapter, Scene })
        },
        (error: unknown) => {
          if (latest.current !== next) return
          console.error('官网演示章节加载失败', showcaseChapters[chapter].title, error)
          setFailed(true)
        }
      )
    }
  }
}
