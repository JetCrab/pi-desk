'use client'

import dynamic from 'next/dynamic'
import type { ReactElement } from 'react'
import { DocsDemoMedia } from './l2-docs-demo-media'

const SubagentsAnimation = dynamic(
  () => import('./l2-subagents-demo').then((module) => module.SubagentsAnimation),
  { ssr: false }
)

export function SubagentsUsage(): ReactElement {
  return (
    <DocsDemoMedia
      slug="subagents"
      label="子代理"
      heading="从派发到结论"
      caption="从主会话派发调查，查看子任务过程，再拿回结论 · 所有内容均为示意"
      controlLabel="子代理演示"
      Animation={SubagentsAnimation}
    />
  )
}
