'use client'

import dynamic from 'next/dynamic'
import type { ReactElement } from 'react'
import { DocsDemoMedia } from './l2-docs-demo-media'

const QuotaGuideAnimation = dynamic(
  () => import('./l2-quota-guide-demo').then((module) => module.QuotaGuideAnimation),
  { ssr: false }
)

export function QuotaGuideDemo(): ReactElement {
  return (
    <DocsDemoMedia
      slug="quota"
      label="额度查看"
      heading="先配置，再查看额度"
      caption="从设置配置示例来源，再打开额度查看器检查窗口与查询状态 · 不连接真实服务"
      controlLabel="额度查看演示"
      Animation={QuotaGuideAnimation}
    />
  )
}
