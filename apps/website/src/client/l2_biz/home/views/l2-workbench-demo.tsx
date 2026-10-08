'use client'

import { Tabs } from '@base-ui/react/tabs'
import {
  Bot,
  Boxes,
  Files,
  GitBranch,
  LoaderCircle,
  Minimize2,
  MonitorSmartphone,
  Pin,
  Puzzle
} from 'lucide-react'
import { MotionConfig } from 'motion/react'
import { useRef, type ReactElement } from 'react'
import { DemoActivity, DemoStep } from '../hooks/l2-demo-activity'
import { useShowcase } from '../hooks/l2-use-showcase'
import { useShowcaseScenes } from '../hooks/l2-use-showcase-scenes'
import { showcaseChapters } from '../l2-showcase-story'
import { DemoCursor } from './l2-demo-cursor'
import { DemoTimeline } from './l2-demo-timeline'
// 提前准备小体积章节样式，避免慢 CSS 阻塞已显示画面的提交；章节 JS 仍按需加载。
import './l2-demo-plugin-management.module.css'
import './scenes/l2-sync-scene.module.css'
import './scenes/l2-files-scene.module.css'
import './scenes/l2-create-plugin-scene.module.css'
import './scenes/l2-install-scene.module.css'
import './scenes/l2-context-scene.module.css'
import './scenes/l2-branches-scene.module.css'
import './scenes/l2-agents-scene.module.css'

const icons = [Pin, MonitorSmartphone, Files, Puzzle, Boxes, Minimize2, GitBranch, Bot]

export function WorkbenchDemo(): ReactElement {
  const sectionRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const scenes = useShowcaseScenes()
  const playback = useShowcase(sectionRef, scenes.chapter, scenes.loadingChapter !== null)
  const chapter = showcaseChapters[scenes.chapter]
  const Scene = scenes.Scene

  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.3, ease: 'easeOut' }}>
      {/* 演示内部会自动重排，不能作为整页滚动锚定的参照。 */}
      <section
        id="showcase"
        ref={sectionRef}
        aria-label="产品演示"
        className="@container/showcase h-dvh min-h-[480px] snap-start snap-always bg-(--showcase-background) px-6 pt-6 [overflow-anchor:none] [--showcase-background:light-dark(oklch(0.945_0_0),oklch(0.15_0_0))] max-md:px-3 max-md:pt-3"
      >
        <Tabs.Root
          value={chapter.id}
          onValueChange={(value) =>
            scenes.selectChapter(showcaseChapters.findIndex((item) => item.id === value))
          }
          className="grid h-full grid-rows-[minmax(0,1fr)_40px_60px] gap-y-2 max-md:grid-rows-[minmax(0,1fr)_36px_52px] max-md:gap-y-1"
        >
          <Tabs.Panel
            value={chapter.id}
            className="min-h-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <div
              id="showcase-stage"
              ref={stageRef}
              data-scene={chapter.id}
              data-step={playback.step}
              data-running={playback.running}
              aria-label={`${chapter.title}演示画面`}
              aria-busy={scenes.loadingChapter !== null}
              className="@container/stage relative h-full min-h-0"
            >
              <DemoActivity.Provider value={playback.running}>
                <DemoStep.Provider value={playback.step}>
                  <Scene
                    key={`${chapter.id}:${playback.replayKey}`}
                    step={playback.step}
                    elapsed={playback.elapsed}
                    onStep={playback.selectStep}
                  />
                </DemoStep.Provider>
              </DemoActivity.Provider>
              <DemoCursor
                key={`cursor:${chapter.id}:${playback.replayKey}`}
                root={stageRef}
                chapter={chapter.id}
                step={playback.step}
                running={playback.running}
                progress={playback.stepProgress}
              />
              {scenes.failedChapter !== null && (
                <div
                  role="alert"
                  className="absolute bottom-3 left-3 flex items-center gap-3 rounded-lg bg-background px-3 py-2 text-sm shadow-sm"
                >
                  <span>这段内容暂时没能加载。</span>
                  <button
                    className="underline underline-offset-4"
                    onClick={() => scenes.selectChapter(scenes.failedChapter!)}
                  >
                    重试
                  </button>
                </div>
              )}
            </div>
          </Tabs.Panel>
          <DemoTimeline
            key={chapter.id}
            chapter={chapter}
            step={playback.step}
            stepProgress={playback.stepProgress}
            progress={playback.progress}
            onSeek={playback.seek}
          />
          <Tabs.List
            activateOnFocus
            aria-label="功能演示"
            className="mx-auto flex w-full max-w-[1440px] items-center justify-center gap-4 overflow-x-auto px-4 [scrollbar-width:thin] max-xl:justify-start max-md:gap-2 max-md:px-0"
          >
            {showcaseChapters.map((item, index) => {
              const Icon = icons[index]
              return (
                <Tabs.Tab
                  key={item.id}
                  value={item.id}
                  aria-busy={scenes.loadingChapter === index}
                  onFocus={() => scenes.selectChapter(index)}
                  onClick={() => scenes.selectChapter(index)}
                  className="relative flex min-h-10 shrink-0 cursor-pointer items-center justify-center gap-2 px-4 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors after:absolute after:inset-x-4 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent hover:text-foreground focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-ring data-active:text-foreground data-active:after:bg-foreground"
                >
                  {scenes.loadingChapter === index ? (
                    <LoaderCircle
                      size={18}
                      aria-hidden="true"
                      className="animate-spin motion-reduce:animate-none"
                    />
                  ) : (
                    <Icon size={18} aria-hidden="true" />
                  )}
                  {item.title}
                </Tabs.Tab>
              )
            })}
          </Tabs.List>
        </Tabs.Root>
      </section>
    </MotionConfig>
  )
}
