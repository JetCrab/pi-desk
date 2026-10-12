'use client'

import type { ReactElement } from 'react'
import { DocsDemoMedia } from './l2-docs-demo-media'
import { ToolReasonGuideAnimation } from './l2-tool-reason-guide-demo'

export function ToolReasonGuideDemo(): ReactElement {
  return (
    <DocsDemoMedia
      slug="tool-reason"
      label="工具调用理由"
      heading="从任务到简短调用目的"
      caption="文件、工具调用和输出均为教学示意，未实际执行。"
      controlLabel="工具调用理由演示"
      Animation={ToolReasonGuideAnimation}
    />
  )
}
