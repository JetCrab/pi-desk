import {
  ArrowRight,
  ChevronDown,
  ExternalLink,
  FileText,
  MessageSquare,
  Wrench
} from 'lucide-react'
import type { ReactElement } from 'react'
import styles from './l2-tool-reason-guide.module.css'

export function ToolReasonGuideEffect(): ReactElement {
  return (
    <figure className={styles.figure} aria-label="工具调用理由作用示意">
      <div className={styles.comparison}>
        <div>
          <strong className={styles.comparisonTitle}>只看到动作</strong>
          <div className={styles.toolCard}>
            <div className={styles.toolHeader}>
              <FileText size={16} aria-hidden="true" />
              <div>
                <span>
                  <code>read</code>
                </span>
                <small>
                  csv.ts <span>· src/export</span>
                </small>
              </div>
              <ExternalLink size={14} aria-hidden="true" />
              <ChevronDown size={14} aria-hidden="true" />
            </div>
          </div>
          <span className={styles.comparisonNote}>知道它读取了文件</span>
        </div>
        <div>
          <strong className={styles.comparisonTitle}>同时看到简短目的</strong>
          <div className={styles.toolCard}>
            <div className={styles.toolHeader}>
              <FileText size={16} aria-hidden="true" />
              <div>
                <span>
                  <code>read</code>
                  <span>确认当前导出字段</span>
                </span>
                <small>
                  csv.ts <span>· src/export</span>
                </small>
              </div>
              <ExternalLink size={14} aria-hidden="true" />
              <ChevronDown size={14} aria-hidden="true" />
            </div>
          </div>
          <span className={styles.comparisonNote}>也知道这次想确认什么</span>
        </div>
      </div>
      <figcaption className={styles.note}>
        示例路径：<code>src/export/csv.ts</code>。目的帮助理解调用，不代替核对结果。
      </figcaption>
    </figure>
  )
}

export function ToolReasonGuidePrinciple(): ReactElement {
  return (
    <figure className={`${styles.figure} ${styles.flow}`} aria-label="工具调用理由运行原理示意">
      <div>
        <MessageSquare size={18} aria-hidden="true" />
        <strong>用户任务</strong>
        <span>说明目标与操作限制</span>
      </div>
      <ArrowRight size={16} aria-hidden="true" />
      <div>
        <Wrench size={18} aria-hidden="true" />
        <strong>助手附简短目的</strong>
        <span>这一步希望确认什么</span>
      </div>
      <ArrowRight size={16} aria-hidden="true" />
      <div>
        <FileText size={18} aria-hidden="true" />
        <strong>原工具执行 / 消息可读</strong>
        <span>理由不传给原工具执行</span>
      </div>
    </figure>
  )
}

export function ToolReasonGuideConfig(): ReactElement {
  return (
    <figure className={styles.figure} aria-label="工具调用理由配置示意">
      <div className={styles.figureTitle}>
        安装加载后生效<span>没有额外设置表单</span>
      </div>
      <div className={styles.activation}>
        <div>
          <span>01</span>
          <strong>安装插件并按提示加载</strong>
          <small>设置 → 插件</small>
        </div>
        <div>
          <span>02</span>
          <strong>已有会话重载 Pi 配置</strong>
          <small>会话空闲时：更多 → 重载 Pi 配置</small>
        </div>
        <div>
          <span>03</span>
          <strong>查看后续工具消息</strong>
          <small>工具名旁显示助手附上的目的</small>
        </div>
      </div>
      <div className={styles.tools} aria-label="适用基础工具">
        <span>适用工具</span>
        {['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'].map((name) => (
          <code key={name}>{name}</code>
        ))}
      </div>
      <figcaption className={styles.note}>
        不会补写旧调用的理由，也不会自动包裹所有第三方工具。
      </figcaption>
    </figure>
  )
}
