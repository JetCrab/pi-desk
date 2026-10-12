import type { ReactElement } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  FileText,
  Files,
  Search
} from 'lucide-react'
import styles from './l2-context-guide-figures.module.css'

export function ContextPrincipleFigure(): ReactElement {
  return (
    <figure
      className={styles.figure}
      aria-label="上下文忽略原理：保留聊天存档，精简发送给模型的副本"
    >
      <div className={styles.principleGrid}>
        <div className={styles.archive}>
          <div className={styles.columnHeading}>
            <Files size={18} aria-hidden="true" />
            <span>聊天记录</span>
            <span className={styles.headingNote}>完整存档</span>
          </div>
          <div className={styles.contentStack}>
            <div className={styles.keptStrip}>
              <span>用户消息</span>
              <span className={styles.shortLine} aria-hidden="true" />
            </div>
            <div className={styles.keptStrip}>
              <span>助手文字</span>
              <span className={styles.longLine} aria-hidden="true" />
            </div>
            <div className={styles.oldContent}>
              <span className={styles.contentLabel}>旧思考</span>
              <div className={styles.textLines} aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </div>
            <div className={styles.oldContent}>
              <span className={styles.contentLabel}>旧工具结果正文</span>
              <div className={styles.textLines} aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </div>
            <div className={styles.recentGroup}>
              <span className={styles.contentLabel}>近期保留过程</span>
              <span className={styles.recentItems}>思考 · 工具结果</span>
            </div>
          </div>
        </div>

        <div className={styles.forwardPath}>
          <span>上下文忽略插件</span>
          <ArrowRight className={styles.horizontalArrow} size={30} aria-hidden="true" />
          <ArrowDown className={styles.verticalArrow} size={26} aria-hidden="true" />
          <span className={styles.pathNote}>整理发送副本</span>
        </div>

        <div className={styles.model}>
          <div className={styles.columnHeading}>
            <FileText size={18} aria-hidden="true" />
            <span>发送给模型</span>
            <span className={styles.headingNote}>精简副本</span>
          </div>
          <div className={styles.contentStack}>
            <div className={styles.keptStrip}>
              <span>用户消息</span>
              <span className={styles.shortLine} aria-hidden="true" />
            </div>
            <div className={styles.keptStrip}>
              <span>助手文字</span>
              <span className={styles.longLine} aria-hidden="true" />
            </div>
            <div className={styles.omittedContent}>
              <span>旧思考省略</span>
              <span className={styles.omissionDots} aria-hidden="true">
                ···
              </span>
            </div>
            <div className={styles.toolSummary}>
              <span className={styles.contentLabel}>简要工具记录</span>
              <span className={styles.toolExample}>read · 文件读取记录</span>
            </div>
            <div className={styles.recentGroup}>
              <span className={styles.contentLabel}>近期保留过程</span>
              <span className={styles.recentItems}>思考 · 工具结果</span>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.recallPath}>
        <ArrowLeft className={styles.horizontalArrow} size={18} aria-hidden="true" />
        <ArrowUp className={styles.verticalArrow} size={18} aria-hidden="true" />
        <span className={styles.recallLine} aria-hidden="true" />
        <span className={styles.recallLabel}>
          <Search size={14} aria-hidden="true" />
          工具记录 → 按需回查原始工具结果
        </span>
      </div>

      <figcaption className={styles.principleCaption}>
        <span className={styles.preservationNote}>忽略不会删除原始聊天记录</span>
        <span className={styles.legend}>
          <span>
            <i className={styles.solidKey} aria-hidden="true" />
            保留
          </span>
          <span>
            <i className={styles.dashedKey} aria-hidden="true" />
            省略 / 简化旧过程
          </span>
        </span>
      </figcaption>
    </figure>
  )
}

export function ContextSettingsFigure(): ReactElement {
  return (
    <figure className={styles.figure} aria-label="上下文忽略配置示意，400k 容量模型的推荐设置">
      <figcaption className={styles.exampleCaption}>配置示意 · 400k 容量模型</figcaption>
      <div className={styles.settingsLayout}>
        <div className={styles.settingsPanel}>
          <div className={styles.settingsHeader}>
            <span className={styles.settingsTitle}>上下文忽略</span>
            <span className={styles.autoEnabled}>
              <span className={styles.checkedBox}>
                <Check size={12} aria-hidden="true" />
              </span>
              自动忽略<span className={styles.enabledLabel}>开</span>
            </span>
          </div>

          <div className={styles.settingsBody}>
            <div className={styles.settingsSection}>
              <div className={styles.sectionHeading}>
                <span className={styles.number}>①</span>
                <span>模型上下文容量</span>
              </div>
              <div className={styles.capacityTabs}>
                <span className={styles.selectedTab}>
                  <Check size={12} aria-hidden="true" />
                  ≤400k
                </span>
                <span>400k–600k</span>
                <span>其他模型</span>
              </div>
            </div>

            <div className={styles.settingsSection}>
              <div className={styles.sectionHeading}>
                <span className={styles.number}>②</span>
                <span>何时忽略</span>
              </div>
              <div className={styles.rule}>
                <div className={styles.field}>
                  <span>当前用量</span>
                  <span className={styles.amount}>
                    <span>≥</span>
                    <span>280</span>
                    <span className={styles.unit}>k</span>
                  </span>
                </div>
                <span className={styles.and}>且</span>
                <div className={styles.field}>
                  <span>忽略后预计</span>
                  <span className={styles.amount}>
                    <span>≤</span>
                    <span>50</span>
                    <span className={styles.unit}>k</span>
                  </span>
                </div>
              </div>
            </div>

            <div className={styles.settingsSection}>
              <div className={styles.sectionHeading}>
                <span className={styles.number}>③</span>
                <span>保留最近的过程</span>
              </div>
              <span className={styles.sectionNote}>对话与结论始终保留</span>
              <div className={styles.retentionFields}>
                <div className={styles.field}>
                  <span>最近对话轮数</span>
                  <span className={styles.amount}>
                    <span>≤</span>
                    <span>3</span>
                    <span className={styles.unit}>轮</span>
                  </span>
                </div>
                <div className={styles.field}>
                  <span>过程用量上限</span>
                  <span className={styles.amount}>
                    <span>≤</span>
                    <span>30</span>
                    <span className={styles.unit}>k</span>
                  </span>
                </div>
              </div>
            </div>

            <div className={styles.advanced}>
              <ChevronRight size={16} aria-hidden="true" />
              <span>高级设置</span>
              <span className={styles.sectionNote}>收起</span>
            </div>
          </div>

          <div className={styles.settingsFooter}>
            <span className={styles.restoreExample}>恢复推荐</span>
            <span className={styles.footerNote}>操作仅示意</span>
            <span className={styles.saveExample}>保存</span>
          </div>
        </div>

        <div className={styles.annotations}>
          <div className={styles.annotation}>
            <span className={styles.number}>①</span>
            <div>
              <span className={styles.annotationTitle}>按模型容量选配置</span>
              <span>400k 模型使用 ≤400k 档。k 表示 1,000 tokens。</span>
            </div>
          </div>
          <div className={styles.annotation}>
            <span className={styles.number}>②</span>
            <div>
              <span className={styles.annotationTitle}>两个条件同时满足</span>
              <span>当前 ≥280k，且忽略后预计 ≤50k 才触发。同一规则是“且”，多条规则是“或”。</span>
            </div>
          </div>
          <div className={styles.annotation}>
            <span className={styles.number}>③</span>
            <div>
              <span className={styles.annotationTitle}>轮数与预算共同限制</span>
              <span>最多保留最近 3 轮的过程，同时不超过 30k；并非保证完整保留 3 轮。</span>
            </div>
          </div>
        </div>
      </div>
    </figure>
  )
}
