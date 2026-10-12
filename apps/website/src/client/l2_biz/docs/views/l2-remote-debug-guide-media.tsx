'use client'

import type { ReactElement } from 'react'
import { DocsDemoMedia } from './l2-docs-demo-media'
import { RemoteDebugGuideAnimation } from './l2-remote-debug-guide-demo'

export function RemoteDebugGuideDemo(): ReactElement {
  return (
    <DocsDemoMedia
      slug="remote-debug"
      label="远程调试"
      heading="从启动项到其他设备访问"
      caption="全部命令、网络与地址均为示意，未启动服务或连接隧道。"
      controlLabel="远程调试演示"
      Animation={RemoteDebugGuideAnimation}
    />
  )
}
