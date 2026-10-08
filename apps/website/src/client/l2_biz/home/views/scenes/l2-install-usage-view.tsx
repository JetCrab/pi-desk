'use client'

import { PanelTop, Database } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Action, Modal } from '../l2-demo-ui'
import { usageRecords, sumUsage, usageMetrics, type UsageRecord } from './l2-usage-demo-data'
import styles from './l2-install-scene.module.css'

function Trend({ records = usageRecords }: { records?: readonly UsageRecord[] }): ReactElement {
  const totals = [0, 1, 2, 3].map((slot) =>
    sumUsage(records.filter((record) => record.slot === slot))
  )
  const max = Math.max(1, ...totals.map((total) => total.input))
  return (
    <div className={styles.trend} role="img" aria-label="示例输入总量和缓存命中率趋势">
      <svg viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true">
        {[24, 64, 104].map((y) => (
          <line key={y} x1="0" x2="600" y1={y} y2={y} />
        ))}
        {totals.map((total, index) => (
          <rect
            key={index}
            className={styles.area}
            x={index * 150 + 20}
            y={130 - (total.input / max) * 110}
            width="80"
            height={(total.input / max) * 110}
          />
        ))}
        <polyline
          className={styles.rate}
          points={totals
            .map(
              (total, index) =>
                `${index * 150 + 60},${130 - (total.input ? total.cached / total.input : 0) * 110}`
            )
            .join(' ')}
        />
      </svg>
      <div>
        {['昨天 18:00', '昨天 20:00', '今天 10:00', '今天 11:00'].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  )
}
function Metrics({ items }: { items: readonly (readonly [string, string])[] }): ReactElement {
  return (
    <div className={styles.metrics}>
      {items.map(([label, value]) => (
        <div key={label}>
          <strong>{value}</strong>
          <span>{label}</span>
        </div>
      ))}
    </div>
  )
}
export function InstallUsageView({
  onClose,
  expandedInitially = false
}: {
  onClose: () => void
  expandedInitially?: boolean
}): ReactElement {
  const [range, setRange] = useState('24 小时')
  const [expanded, setExpanded] = useState(expandedInitially)
  const [expandedPhase, setExpandedPhase] = useState(expandedInitially)
  if (expandedPhase !== expandedInitially) {
    setExpandedPhase(expandedInitially)
    if (expandedInitially) setExpanded(true)
  }
  const [model, setModel] = useState<string | null>(null)
  const [refreshed, setRefreshed] = useState(false)
  const sessionRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!expandedInitially) return
    const card = sessionRef.current,
      viewport = card
        ?.closest('[aria-label="模型用量演示面板"]')
        ?.querySelector<HTMLElement>('[data-demo-modal-scroll]')
    if (card && viewport)
      viewport.scrollTop +=
        card.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 12
  }, [expandedInitially])
  const ranged = usageRecords.filter((record) => range !== '今天' || record.today)
  const records = ranged.filter((record) => !model || record.model === model)
  const total = sumUsage(records)
  return (
    <Modal title="模型用量" icon={<PanelTop size={20} />} wide onClose={onClose}>
      <div className={styles.usage}>
        <div className={styles.toolbar}>
          <div className={styles.rangeTabs}>
            {['24 小时', '今天', '7 天', '30 天', '本月'].map((value) => (
              <Action key={value} active={range === value} onClick={() => setRange(value)}>
                {value}
              </Action>
            ))}
          </div>
          <Action onClick={() => setRefreshed(true)}>刷新</Action>
          {refreshed && <span>刚刚更新</span>}
        </div>
        <div data-guide-target="usage-overview">
          <Metrics items={usageMetrics(total)} />
        </div>
        <div className={styles.secondary}>
          输出 <strong>{total.output / 1000}k</strong>缓存读取{' '}
          <strong>{total.cached / 1000}k</strong>
          {model && <span>{model}</span>}
        </div>
        <section className={styles.chartPanel}>
          <h3>消耗趋势</h3>
          <Trend records={records} />
        </section>
        {['7 天', '30 天', '本月'].includes(range) && (
          <div className={styles.calendar} aria-label="示例使用日历">
            {[false, true].map((today) => (
              <span key={String(today)}>
                {today ? '今天' : '昨天'}
                <strong>
                  {sumUsage(records.filter((record) => record.today === today)).input / 1000}k
                </strong>
              </span>
            ))}
          </div>
        )}
        <div className={styles.usageLower}>
          <section>
            <h3>Session 用量</h3>
            <button
              type="button"
              ref={sessionRef}
              className={styles.sessionCard}
              aria-label="展开开发导出功能用量"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              <div>
                <strong>{expanded ? '▾' : '▸'} 开发导出功能</strong>
                <small>今天 10:24</small>
              </div>
              <p>/projects/qingzhou</p>
              <Metrics items={usageMetrics(total)} />
              <p>
                主代理{' '}
                {sumUsage(records.filter((record) => record.agent === '主代理自身')).input / 1000}k
                · 1 个子代理 · 输出 {total.output / 1000}k
              </p>
            </button>
            {expanded && (
              <div className={styles.sessionChildren} data-guide-target="usage-agents">
                {['主代理自身', '导出逻辑调查'].map((agent) => {
                  const value = sumUsage(records.filter((record) => record.agent === agent))
                  return (
                    <div key={agent}>
                      <strong>{agent}</strong>
                      <Metrics items={usageMetrics(value)} />
                    </div>
                  )
                })}
              </div>
            )}
          </section>
          <section>
            <h3>模型用量</h3>
            {['Claude Sonnet 4.6', 'GPT-5.4'].map((name) => {
              const value = sumUsage(ranged.filter((record) => record.model === name))
              return (
                <button
                  key={name}
                  type="button"
                  aria-label={`筛选模型 ${name}`}
                  aria-pressed={model === name}
                  className={styles.modelRow}
                  onClick={() => setModel(model === name ? null : name)}
                >
                  <strong>{name}</strong>
                  <small>
                    {value.calls} 次 · 输出 {value.output / 1000}k · 缓存 {value.cached / 1000}k
                  </small>
                  <Metrics items={usageMetrics(value)} />
                </button>
              )
            })}
          </section>
        </div>
      </div>
    </Modal>
  )
}
export function InstallSessionAnalysis({ onClose }: { onClose: () => void }): ReactElement {
  const [tab, setTab] = useState('趋势')
  const total = sumUsage(usageRecords)
  return (
    <Modal title="会话分析" icon={<Database size={20} />} panel onClose={onClose}>
      <div className={styles.analysis}>
        <div className={styles.toolbar}>
          <div className={styles.rangeTabs}>
            {['趋势', '代理', '事件'].map((value) => (
              <Action key={value} active={tab === value} onClick={() => setTab(value)}>
                {value}
              </Action>
            ))}
          </div>
          <Action onClick={() => setTab('趋势')}>刷新</Action>
        </div>
        <Metrics
          items={[
            ['总 Token', `${(total.input + total.output) / 1000}k`],
            ['费用', `$${total.cost.toFixed(2)}`],
            ['模型调用', String(total.calls)],
            ['缓存命中', `${((total.cached / total.input) * 100).toFixed(1)}%`],
            ['会话时长', '40 分钟']
          ]}
        />
        {tab === '趋势' ? (
          <>
            <h3>使用量 · Token / 分</h3>
            <Trend />
            <h3>上下文</h3>
            <div className={styles.contextChart}>
              <svg viewBox="0 0 600 64" aria-hidden="true">
                <path d="M0 55H100V45H200V31H310V47H400V36H500V18H600" />
              </svg>
            </div>
            <h3>活动</h3>
            <p>主代理 · bash 验证导出</p>
            <p>导出逻辑调查 · 只读调查</p>
          </>
        ) : tab === '代理' ? (
          <div className={styles.agentsList}>
            {['主代理自身', '导出逻辑调查'].map((agent) => (
              <div key={agent}>
                <strong>{agent}</strong>
                <Metrics
                  items={usageMetrics(
                    sumUsage(usageRecords.filter((record) => record.agent === agent))
                  )}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.agentsList}>
            <p>10:24 · 模型调用</p>
            <p>10:25 · read · src/export.ts</p>
            <p>10:26 · 子代理运行结束</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
