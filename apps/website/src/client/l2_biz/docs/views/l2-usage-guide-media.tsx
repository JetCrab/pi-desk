'use client'

import dynamic from 'next/dynamic'
import type { ReactElement } from 'react'
import { DocsDemoMedia } from './l2-docs-demo-media'

const UsageGuideAnimation = dynamic(
  () => import('./l2-usage-guide-demo').then((module) => module.UsageGuideAnimation),
  { ssr: false }
)

export function UsageGuideDemo(): ReactElement {
  return (
    <DocsDemoMedia
      slug="usage"
      label="模型用量"
      heading="从总览到会话分析"
      caption="从左侧用量入口查看趋势，再从聊天更多菜单分析当前会话 · 全部为示例记录"
      controlLabel="模型用量演示"
      Animation={UsageGuideAnimation}
    />
  )
}
