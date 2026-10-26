import { ArrowRight, FileCheck, FileText, Images, ListChecks } from 'lucide-react'
import type { ReactElement } from 'react'
import base from './l2-background-tasks-figures.module.css'
import styles from './l2-deliverables-figures.module.css'

export function DeliverablesEffect(): ReactElement {
  return (
    <figure className={base.effect} aria-label="交付物作用示意">
      <div className={base.figureTitle}>
        完成的结果，集中交给你查看<span>轻舟项目 · 示意</span>
      </div>
      <div className={`${base.flow} ${styles.effectFlow}`}>
        <div>
          <FileCheck size={22} aria-hidden="true" />
          <strong>文件已完成</strong>
          <span>报告 · HTML · 图片</span>
        </div>
        <ArrowRight className={base.flowArrow} size={18} aria-hidden="true" />
        <div>
          <ListChecks size={22} aria-hidden="true" />
          <strong>助手明确登记</strong>
          <span>标题 + 文件或文件夹路径</span>
        </div>
        <ArrowRight className={base.flowArrow} size={18} aria-hidden="true" />
        <div>
          <Images size={22} aria-hidden="true" />
          <strong>集中预览</strong>
          <span>当前会话的交付物清单</span>
        </div>
      </div>
      <figcaption className={base.note}>
        先完成，再登记；你选择要看的结果，不自动搜集项目里的所有文件。
      </figcaption>
    </figure>
  )
}

export function DeliverablesPrinciple(): ReactElement {
  return (
    <figure className={styles.principle} aria-label="交付物登记原理示意">
      <FileText size={18} aria-hidden="true" />
      <div>
        <strong>登记的是引用，不是副本</strong>
        <span>会话保留登记记录，预览仍依赖原路径的内容。</span>
      </div>
    </figure>
  )
}

export function DeliverablesConfig(): ReactElement {
  return (
    <figure className={base.config} aria-label="交付物配置示意">
      <div className={base.figureTitle}>
        deliverable 的登记参数<span>以下是一项交付物的示例</span>
      </div>
      <div className={styles.itemsHeader}>
        <code>items</code>
        <span>数组 · 每次 1–20 项</span>
      </div>
      <dl className={base.parameters}>
        <div>
          <dt>
            文件或文件夹路径 <code>path</code>
          </dt>
          <dd>
            <code>deliverables/overview.html</code>
            <span>支持相对路径或服务端绝对路径</span>
          </dd>
        </div>
        <div>
          <dt>
            简短标题 <code>title</code>
          </dt>
          <dd>
            <strong>任务总览页面</strong>
            <span>面向用户，1–40 个字符</span>
          </dd>
        </div>
      </dl>
      <figcaption className={base.note}>
        没有独立设置页；多项交付物放进同一个 items 数组登记。
      </figcaption>
    </figure>
  )
}
