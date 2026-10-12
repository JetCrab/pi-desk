import { ArrowRight, BarChart3, Database, MessageSquare } from 'lucide-react'
import type { ReactElement } from 'react'
import { UsageGuideChart } from './l2-usage-guide-chart'
import styles from './l2-usage-guide-figures.module.css'

export function UsageGuideEffect(): ReactElement {
  return (
    <figure className={styles.effect} aria-label="模型用量作用示意">
      <div className={styles.title}>
        先看趋势，再找到消耗来自哪里<span>最近 7 天 · 全部数值均为示例</span>
      </div>
      <div className={styles.kpis}>
        <div>
          <strong>360k</strong>
          <span>输入总量</span>
        </div>
        <div>
          <strong>50%</strong>
          <span>缓存命中率</span>
        </div>
        <div>
          <strong>$1.08</strong>
          <span>记录费用 · 示意</span>
        </div>
      </div>
      <div className={styles.effectCharts}>
        <div>
          <strong className={styles.sectionTitle}>输入消耗趋势</strong>
          <UsageGuideChart
            values={[30, 40, 80, 55, 45, 60, 50]}
            labels={['1日', '2日', '3日', '4日', '5日', '6日', '7日']}
            unit="输入 · k tokens"
          />
        </div>
        <div className={styles.distribution}>
          <strong className={styles.sectionTitle}>按模型分布</strong>
          <div>
            <span>
              模型 A <strong>240k</strong>
            </span>
            <i style={{ width: '67%' }} />
          </div>
          <div>
            <span>
              模型 B <strong>120k</strong>
            </span>
            <i style={{ width: '33%' }} />
          </div>
          <small>两种模型合计 360k 输入</small>
        </div>
      </div>
      <figcaption className={styles.note}>
        峰值发生在哪天？哪个模型占得多？从这些线索继续查看会话，不将示例金额当价格标准。
      </figcaption>
    </figure>
  )
}

export function UsageGuidePrinciple(): ReactElement {
  return (
    <figure className={styles.principle} aria-label="模型用量汇总原理示意">
      <div>
        <Database size={20} aria-hidden="true" />
        <strong>会话记录</strong>
        <span>已记录的用量与成本</span>
      </div>
      <ArrowRight size={18} aria-hidden="true" />
      <div>
        <BarChart3 size={20} aria-hidden="true" />
        <strong>汇总消耗</strong>
        <span>时间 · 模型 · 主/子代理</span>
      </div>
      <ArrowRight size={18} aria-hidden="true" />
      <div>
        <MessageSquare size={20} aria-hidden="true" />
        <strong>总览 / 会话分析</strong>
        <span>先找范围，再看过程</span>
      </div>
    </figure>
  )
}

export function UsageGuideConfig(): ReactElement {
  return (
    <figure className={styles.config} aria-label="模型用量配置示意">
      <div className={styles.title}>
        按问题调整筛选<span>筛选示意 · 没有独立设置页</span>
      </div>
      <div className={styles.filterRow}>
        <strong>总览时间</strong>
        <div className={styles.chips}>
          {['24 小时', '今天', '7 天', '30 天', '本月'].map((label) => (
            <span key={label} data-active={label === '7 天'}>
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className={styles.filterRow}>
        <strong>模型</strong>
        <div className={styles.chips}>
          <span data-active="true">示例服务 / 模型 A</span>
          <span>示例服务 / 模型 B</span>
        </div>
      </div>
      <div className={styles.filterRow}>
        <strong>会话趋势</strong>
        <div className={styles.chips}>
          <span data-active="true">Token/分</span>
          <span>调用/分</span>
          <span>费用/分</span>
          <span>命中率</span>
        </div>
      </div>
      <div className={styles.filterRow}>
        <strong>代理筛选</strong>
        <div className={styles.chips}>
          <span data-active="true">全部</span>
          <span>完善导出功能</span>
          <span>代理 1 · 调查导出入口</span>
        </div>
      </div>
      <figcaption className={styles.note}>
        总览筛选与单会话分析分别操作；时间显示沿用宿主当前生效的时区，不在这里配置费率。
      </figcaption>
    </figure>
  )
}
