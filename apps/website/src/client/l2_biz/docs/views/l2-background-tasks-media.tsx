'use client'

import dynamic from 'next/dynamic'
import type { ReactElement } from 'react'
import { DocsDemoMedia } from './l2-docs-demo-media'

const BackgroundTasksAnimation = dynamic(
  () => import('./l2-background-tasks-demo').then((module) => module.BackgroundTasksAnimation),
  { ssr: false }
)

export function BackgroundTasksUsage(): ReactElement {
  return (
    <DocsDemoMedia
      slug="background-tasks"
      label="后台任务"
      heading="从启动到停止"
      caption="从任务摘要进入任务中心，查看日志并停止任务 · 所有内容均为示意"
      controlLabel="后台任务视频"
      Animation={BackgroundTasksAnimation}
    />
  )
}
