import { ArrowRight, Bell, Check, ChevronDown, Languages, Rss } from 'lucide-react'
import type { ReactElement } from 'react'
import styles from './l2-tibo-guide.module.css'

export function TiboGuideEffect(): ReactElement {
  return (
    <figure className={styles.figure} aria-label="Tibo 动态作用示意">
      <div className={styles.effectFlow}>
        <div>
          <Rss size={20} aria-hidden="true" />
          <strong>公开动态</strong>
          <span>英文正文与引用</span>
          <div className={styles.postSample} lang="en">
            Demo only: A change to Codex usage limits is being discussed. No reset is confirmed.
          </div>
        </div>
        <ArrowRight size={18} aria-hidden="true" />
        <div>
          <Languages size={20} aria-hidden="true" />
          <strong>中文解读</strong>
          <span>保留英文原文供对照</span>
          <div className={styles.postSample}>
            仅为示例：正在讨论 Codex 用量限制的调整，尚未确认重置。
          </div>
        </div>
        <ArrowRight size={18} aria-hidden="true" />
        <div>
          <Bell size={20} aria-hidden="true" />
          <strong>需要关注的提醒</strong>
          <span className={styles.warning}>可能重置 · 推测</span>
          <div className={styles.postSample}>查看判断依据，再回到原帖核实；不代表账户已重置。</div>
        </div>
      </div>
      <figcaption className={styles.note}>
        演示内容，并非真实发文。提醒是模型判断，非官方确认。
      </figcaption>
    </figure>
  )
}

export function TiboGuidePrinciple(): ReactElement {
  return (
    <figure className={`${styles.figure} ${styles.principle}`} aria-label="Tibo 动态运行原理示意">
      <div>
        <strong>内置公开 RSS</strong>
        <span>按间隔检查，保留动态</span>
      </div>
      <ArrowRight size={16} aria-hidden="true" />
      <div>
        <strong>所选翻译模型</strong>
        <span>翻译与判断，可能有费用</span>
      </div>
      <ArrowRight size={16} aria-hidden="true" />
      <div>
        <strong>详情与新动态通知</strong>
        <span>看依据、对照原文</span>
      </div>
    </figure>
  )
}

export function TiboGuideConfig(): ReactElement {
  return (
    <figure className={styles.figure} aria-label="Tibo 动态配置示意">
      <div className={styles.figureTitle}>
        Tibo 动态 → 设置<span>填写后的表单示意，尚未保存</span>
      </div>
      <div className={styles.configForm}>
        <div className={styles.field}>
          <span>翻译模型</span>
          <div className={styles.fieldValue}>
            演示服务 / 示例翻译模型
            <ChevronDown size={14} aria-hidden="true" />
          </div>
        </div>
        <div className={styles.checkboxRow}>
          <span className={styles.checked}>
            <Check size={12} aria-hidden="true" />
          </span>
          启用监听
        </div>
        <div className={styles.advancedTitle}>
          <ChevronDown size={14} aria-hidden="true" />
          更多设置
        </div>
        <div className={styles.configFields}>
          <div className={styles.field}>
            <span>检查间隔（秒）</span>
            <div className={styles.fieldValue}>60</div>
            <small>30–86,400 秒</small>
          </div>
          <div className={styles.field}>
            <span>保留动态（条）</span>
            <div className={styles.fieldValue}>100</div>
            <small>10–200 条</small>
          </div>
        </div>
        <div className={styles.actionRow}>
          <span className={styles.saveExample}>保存设置</span>
          <span>未保存</span>
        </div>
      </div>
      <figcaption className={styles.note}>
        默认监听关闭、模型未选择。来源内置，无 RSS 地址字段；模型名仅为示例。
      </figcaption>
    </figure>
  )
}
