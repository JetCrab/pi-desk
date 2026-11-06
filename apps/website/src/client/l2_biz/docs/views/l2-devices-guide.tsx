import { Fragment, type ReactElement } from 'react'
import { ArrowDown, Monitor, Server, Smartphone } from 'lucide-react'
import { DevicesGuideDemo } from './l2-devices-guide-demo'
import styles from './l2-devices-guide.module.css'

function DevicesConnection(): ReactElement {
  return (
    <figure className={styles.connection} aria-label="公网访问连接示意">
      <figcaption>公网访问 · 连接示意</figcaption>
      <div className={styles.route}>
        <div>
          <Smartphone aria-hidden="true" />
          <strong>手机 / 其他设备</strong>
          <span>打开公网地址，输入访问密码</span>
        </div>
        <ArrowDown className={styles.arrow} aria-hidden="true" />
        <div>
          <Server aria-hidden="true" />
          <strong>公网服务器</strong>
          <span>网关接收访问，relay 辅助连通</span>
        </div>
        <ArrowDown className={styles.arrow} aria-hidden="true" />
        <div>
          <Monitor aria-hidden="true" />
          <strong>你的电脑</strong>
          <span>桌面端共享 Pi Desk 本机端口</span>
        </div>
      </div>
      <p>任务留在电脑上，手机打开同一个工作台。</p>
    </figure>
  )
}

const visuals: Record<string, () => ReactElement> = {
  connection: DevicesConnection,
  demo: DevicesGuideDemo
}

export function DevicesGuide({ html }: { html: string }): ReactElement {
  const parts = html.split(/&lt;!-- devices-(connection|demo) --&gt;\s*/)
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) return <div key={index} dangerouslySetInnerHTML={{ __html: part }} />
        const Visual = visuals[part]
        return (
          <Fragment key={part}>
            <Visual />
          </Fragment>
        )
      })}
    </>
  )
}
