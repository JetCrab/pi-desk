import { ArrowDownRight, Check, FileText, History, Layers, MessageSquare } from 'lucide-react'
import type { ReactElement } from 'react'
import styles from './l2-context-guide-effect.module.css'

export function ContextEffect(): ReactElement {
  return (
    <figure className={styles.effect} aria-label="忽略前后的上下文对照">
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>同一段对话 · 发送给模型的内容</span>
          <strong className={styles.title}>保留对话，上下文更轻。</strong>
        </div>
        <span className={styles.difference}>
          <ArrowDownRight size={20} aria-hidden="true" />
          少带 <strong>76k</strong>
        </span>
      </div>
      <div className={styles.comparison}>
        <section className={styles.before} aria-label="忽略前的上下文">
          <div className={styles.stateHeading}>
            <span>忽略前</span>
            <span>
              <strong>120k</strong>
              <small> tokens</small>
            </span>
          </div>
          <div className={styles.meter} aria-label="忽略前发送量：120k">
            <span className={styles.keptMeter} />
            <span className={styles.beforeProcessMeter} />
            <span className={styles.recentMeter} />
          </div>
          <div className={styles.contents}>
            <div className={styles.kept}>
              <MessageSquare size={15} aria-hidden="true" />
              <span>对话与文字结论</span>
              <small>24k</small>
            </div>
            <div className={styles.oldProcess}>
              <div>
                <Layers size={15} aria-hidden="true" />
                <span>旧思考与工具结果正文</span>
                <small>80k</small>
              </div>
              <div className={styles.stack} aria-hidden="true">
                <span>
                  <FileText size={12} />
                  <i />
                  <i />
                </span>
                <span>
                  <FileText size={12} />
                  <i />
                  <i />
                </span>
                <span>
                  <FileText size={12} />
                  <i />
                  <i />
                </span>
              </div>
            </div>
            <div className={styles.recent}>
              <Layers size={15} aria-hidden="true" />
              <span>近期保留过程</span>
              <small>16k</small>
            </div>
          </div>
        </section>
        <section className={styles.after} aria-label="忽略后的上下文">
          <div className={styles.stateHeading}>
            <span>忽略后</span>
            <span>
              <strong>44k</strong>
              <small> tokens</small>
            </span>
          </div>
          <div className={styles.meter} aria-label="忽略后发送量：44k，与忽略前使用相同尺度">
            <span className={styles.keptMeter} />
            <span className={styles.afterProcessMeter} />
            <span className={styles.recentMeter} />
          </div>
          <div className={styles.contents}>
            <div className={styles.kept}>
              <MessageSquare size={15} aria-hidden="true" />
              <span>对话与文字结论</span>
              <small>24k</small>
            </div>
            <div className={styles.summary}>
              <FileText size={15} aria-hidden="true" />
              <span>简要工具记录</span>
              <small>4k</small>
            </div>
            <div className={styles.recent}>
              <Layers size={15} aria-hidden="true" />
              <span>近期保留过程</span>
              <small>16k</small>
            </div>
            <div className={styles.reclaimed}>
              <ArrowDownRight size={22} aria-hidden="true" />
              <span>
                减少旧过程占用
                <br />
                <strong>留出空间，继续对话</strong>
              </span>
            </div>
          </div>
        </section>
      </div>
      <div className={styles.preserved}>
        <span>
          <Check size={14} aria-hidden="true" />
          对话与文字结论保留
        </span>
        <span>
          <History size={14} aria-hidden="true" />
          历史工具结果可回查
        </span>
      </div>
      <figcaption className={styles.caption}>
        两条占用条使用相同尺度。数值仅作示意，不代表固定节省比例。
      </figcaption>
    </figure>
  )
}
