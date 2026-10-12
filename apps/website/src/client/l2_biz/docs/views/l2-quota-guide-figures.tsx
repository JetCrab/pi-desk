import { ArrowRight, Database, ListTree, Settings } from 'lucide-react'
import type { ReactElement } from 'react'
import { QuotaGuideSourceFields } from './l2-quota-guide-source'
import styles from './l2-quota-guide-figures.module.css'

export function QuotaGuideEffect(): ReactElement {
  return (
    <figure className={styles.effect} aria-label="额度查看作用示意">
      <div className={styles.title}>
        看清剩余量，也看清单位与重置时间<span>全部为示例，不是实际账户数据</span>
      </div>
      <div className={styles.effectBody}>
        <div className={styles.windowExample}>
          <strong>OpenCode Go · 示例来源</strong>
          <div>
            <span>5 小时额度 · 剩余</span>
            <strong>68%</strong>
          </div>
          <div
            className={styles.progress}
            role="progressbar"
            aria-label="示例5小时额度剩余"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={68}
          >
            <span style={{ width: '68%' }} />
          </div>
          <span>2 小时 20 分钟后重置</span>
          <small>百分比是这个窗口的剩余额度，不代表金额。</small>
        </div>
        <div className={styles.balanceExample}>
          <strong>Moonshot / Kimi API · 示例来源</strong>
          <span>可用余额</span>
          <strong className={styles.balance}>¥18.50</strong>
          <span>CNY · 人民币</span>
          <small>账户余额是金额，不是5小时窗口的剩余比例。</small>
        </div>
      </div>
      <figcaption className={styles.note}>
        额度窗口、账户余额、重置时间分别读取；未知不能当成0。
      </figcaption>
    </figure>
  )
}

export function QuotaGuidePrinciple(): ReactElement {
  return (
    <figure className={styles.principle} aria-label="额度查看运行原理示意">
      <div>
        <Settings size={20} aria-hidden="true" />
        <strong>配置来源</strong>
        <span>选渠道，提供所需认证</span>
      </div>
      <ArrowRight size={18} aria-hidden="true" />
      <div>
        <Database size={20} aria-hidden="true" />
        <strong>查询对应服务</strong>
        <span>返回余额或额度数据</span>
      </div>
      <ArrowRight size={18} aria-hidden="true" />
      <div>
        <ListTree size={20} aria-hidden="true" />
        <strong>按账户 / 窗口展示</strong>
        <span>同时查看状态与更新时间</span>
      </div>
    </figure>
  )
}

export function QuotaGuideConfig(): ReactElement {
  return (
    <figure className={styles.config} aria-label="额度查看配置示意">
      <div className={styles.title}>
        额度设置 → 额度来源<span>OpenCode Go 表单示意</span>
      </div>
      <div className={styles.channel}>
        <span>渠道</span>
        <strong>OpenCode Go</strong>
        <small>本例查询5小时、周、月额度百分比，需要对应套餐。</small>
      </div>
      <QuotaGuideSourceFields />
      <figcaption className={styles.note}>
        其他渠道字段不同。这里只有认证占位符，未保存配置或连接服务。
      </figcaption>
    </figure>
  )
}
