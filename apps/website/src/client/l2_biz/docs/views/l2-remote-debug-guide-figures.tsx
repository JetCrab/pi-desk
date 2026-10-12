import { ArrowRight, Globe, Laptop, Smartphone, Terminal } from 'lucide-react'
import type { ReactElement } from 'react'
import styles from './l2-remote-debug-guide.module.css'

export function RemoteDebugGuideEffect(): ReactElement {
  return (
    <figure className={styles.figure} aria-label="远程调试作用示意">
      <div className={styles.flow}>
        <div>
          <Laptop size={20} aria-hidden="true" />
          <strong>本地项目</strong>
          <span>纸舟示例网页</span>
        </div>
        <ArrowRight size={16} aria-hidden="true" />
        <div>
          <Terminal size={20} aria-hidden="true" />
          <strong>调试服务 / 本地端口</strong>
          <span>127.0.0.1:43120</span>
        </div>
        <ArrowRight size={16} aria-hidden="true" />
        <div>
          <Globe size={20} aria-hidden="true" />
          <strong>已配置隧道</strong>
          <span>桌面端托管连接</span>
        </div>
        <ArrowRight size={16} aria-hidden="true" />
        <div>
          <Smartphone size={20} aria-hidden="true" />
          <strong>其他设备访问</strong>
          <span>查看项目页面</span>
        </div>
      </div>
      <div className={styles.projectPreview}>
        <div>
          <span>纸舟 · 示例项目</span>
          <strong>导出预览</strong>
          <span>姓名、邮箱两列，检查窄屏布局</span>
        </div>
        <div className={styles.previewRows}>
          <span>
            姓名<span>邮箱</span>
          </span>
          <span>
            示例用户<span>reader@example.invalid</span>
          </span>
        </div>
      </div>
      <figcaption className={styles.note}>
        共享的是项目网页，不是聊天消息同步。端口、页面和网络过程均为示意。
      </figcaption>
    </figure>
  )
}

export function RemoteDebugGuideConfig(): ReactElement {
  return (
    <figure className={styles.figure} aria-label="远程调试配置示意">
      <div className={styles.figureTitle}>
        设置 → 插件设置 → 远程调试<span>全局设置的两个页签示意</span>
      </div>
      <div className={styles.configSections}>
        <div>
          <strong>连接</strong>
          <span>连接地址</span>
          <div className={styles.fieldValue}>http://tunnel.example.invalid</div>
          <small>在桌面端设置连接，这里只读展示</small>
        </div>
        <div>
          <strong>端口分配</strong>
          <div className={styles.rangeRow}>
            <span>本机端口</span>
            <span className={styles.fieldValue}>43000</span>
            <span>至</span>
            <span className={styles.fieldValue}>43999</span>
          </div>
          <div className={styles.rangeRow}>
            <span>公网端口</span>
            <span className={styles.fieldValue}>11001</span>
            <span>至</span>
            <span className={styles.fieldValue}>11099</span>
          </div>
          <span className={styles.saveExample}>保存端口范围</span>
        </div>
      </div>
      <div className={styles.registryNote}>
        <strong>端口登记</strong>
        <span>查项目、启动项与端口归属；不等于端口当前正在运行。</span>
      </div>
      <figcaption className={styles.note}>
        项目启动命令仍放在项目的 .pi/remote_debug.yaml；示例域名不连接任何服务。
      </figcaption>
    </figure>
  )
}
