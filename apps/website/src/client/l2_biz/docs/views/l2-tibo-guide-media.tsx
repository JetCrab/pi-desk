'use client'

import type { ReactElement } from 'react'
import { DocsDemoMedia } from './l2-docs-demo-media'
import { TiboGuideAnimation } from './l2-tibo-guide-demo'

export function TiboGuideDemo(): ReactElement {
  return (
    <DocsDemoMedia
      slug="tibo"
      label="Tibo 动态"
      heading="从设置入口到动态解读"
      caption="演示内容，并非真实发文；未抓取来源或调用模型。"
      controlLabel="Tibo 动态演示"
      Animation={TiboGuideAnimation}
    />
  )
}
