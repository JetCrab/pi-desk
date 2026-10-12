'use client'

import dynamic from 'next/dynamic'
import type { ReactElement } from 'react'
import { DocsDemoMedia } from './l2-docs-demo-media'

const DeliverablesAnimation = dynamic(
  () => import('./l2-deliverables-demo').then((module) => module.DeliverablesAnimation),
  { ssr: false }
)

export function DeliverablesUsage(): ReactElement {
  return (
    <DocsDemoMedia
      slug="deliverables"
      label="交付物"
      heading="从完成到预览"
      caption="从左侧交付入口查看清单，独立预览页面和图片，再回到对话 · 所有内容均为示意"
      controlLabel="交付物演示"
      Animation={DeliverablesAnimation}
    />
  )
}
