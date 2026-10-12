import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { useEffect, useRef, type ReactElement } from 'react'
import { UsageGuideChart } from './l2-usage-guide-chart'
import styles from './l2-usage-guide-demo.module.css'

export function UsageGuideOverview({
  step,
  onSelectStep
}: {
  step: number
  onSelectStep: (step: number) => void
}): ReactElement {
  const week = step >= 2
  const model = step >= 3
  const expanded = step === 4
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = body.current
    if (element) {
      element.scrollTop = step === 3 || step === 4 ? element.scrollHeight - element.clientHeight : 0
    }
  }, [step])
  const input = model ? '240k' : week ? '360k' : '120k'
  const cost = model ? '$0.72' : week ? '$1.08' : '$0.36'
  return (
    <div className={styles.overlay}>
      <div className={styles.panel} role="group" aria-label="示例模型用量总览">
        <div className={styles.panelHeader}>
          <strong>模型用量</strong>
          <span>全部为示例记录</span>
          <button type="button" aria-label="关闭示例模型用量总览" onClick={() => onSelectStep(5)}>
            <X size={16} />
          </button>
        </div>
        <div ref={body} className={styles.overviewBody}>
          <div className={styles.rangeControls} aria-label="示例时间范围">
            <button type="button" aria-pressed={!week} onClick={() => onSelectStep(1)}>
              24 小时
            </button>
            <span>今天</span>
            <button
              type="button"
              aria-pressed={week}
              data-highlighted={step === 2}
              onClick={() => onSelectStep(2)}
            >
              7 天
            </button>
            <span>30 天</span>
            <span>本月</span>
            <small>刷新</small>
          </div>
          <div className={styles.kpis}>
            <div>
              <strong>{input}</strong>
              <span>输入总量</span>
            </div>
            <div>
              <strong>50%</strong>
              <span>缓存命中率</span>
            </div>
            <div>
              <strong>{cost}</strong>
              <span>费用</span>
            </div>
          </div>
          <div className={styles.secondary}>
            输出 {model ? '24k' : week ? '36k' : '12k'} · 缓存读取{' '}
            {model ? '120k' : week ? '180k' : '60k'}
            {model && <span>模型 A</span>}
          </div>
          {!expanded ? (
            <>
              <div className={styles.trendPanel}>
                <strong>消耗趋势</strong>
                <UsageGuideChart
                  values={
                    model
                      ? [20, 25, 60, 35, 25, 40, 35]
                      : week
                        ? [30, 40, 80, 55, 45, 60, 50]
                        : [10, 15, 25, 20, 30, 20]
                  }
                  labels={
                    week
                      ? ['1日', '2日', '3日', '4日', '5日', '6日', '7日']
                      : ['00时', '04时', '08时', '12时', '16时', '20时']
                  }
                  unit="输入 · k tokens"
                />
              </div>
              {week && (
                <div className={styles.calendar} aria-label="示例7天输入日历">
                  {(model ? [20, 25, 60, 35, 25, 40, 35] : [30, 40, 80, 55, 45, 60, 50]).map(
                    (value, index) => (
                      <div key={index} data-peak={index === 2}>
                        <span>{index + 1}日</span>
                        <strong>{value}k</strong>
                      </div>
                    )
                  )}
                </div>
              )}
              <div className={styles.overviewLower}>
                <div className={styles.sessionSection}>
                  <strong>Session 用量</strong>
                  <button
                    type="button"
                    className={styles.sessionRow}
                    aria-label="展开示例导出会话用量"
                    onClick={() => onSelectStep(4)}
                  >
                    <span>
                      <ChevronRight size={12} aria-hidden="true" />
                      <strong>完善导出功能</strong>
                    </span>
                    <span>
                      输入 {week ? (model ? '120k' : '150k') : '60k'} · 费用{' '}
                      {week ? (model ? '$0.36' : '$0.45') : '$0.18'}
                    </span>
                    <small>主代理 + 1 个子代理</small>
                  </button>
                </div>
                <div className={styles.modelSection}>
                  <strong>模型用量</strong>
                  <button
                    type="button"
                    className={styles.modelRow}
                    aria-label="筛选示例模型 A"
                    data-selected={model}
                    data-highlighted={step === 3}
                    onClick={() => onSelectStep(model ? 2 : 3)}
                  >
                    <strong>示例服务 / 模型 A</strong>
                    <span>{week ? '240k · $0.72' : '80k · $0.24'}</span>
                  </button>
                  <div className={styles.modelRow}>
                    <strong>示例服务 / 模型 B</strong>
                    <span>{week ? '120k · $0.36' : '40k · $0.12'}</span>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className={styles.expandedSession} data-highlighted="true">
              <div className={styles.sessionSection}>
                <strong>Session 用量</strong>
                <button
                  type="button"
                  className={styles.sessionRow}
                  aria-label="收起示例导出会话用量"
                  onClick={() => onSelectStep(3)}
                >
                  <span>
                    <ChevronDown size={12} aria-hidden="true" />
                    <strong>完善导出功能</strong>
                  </span>
                  <span>输入 120k · 命中率 50% · 费用 $0.36</span>
                  <small>已按模型 A 筛选 · 1 个子代理</small>
                </button>
              </div>
              <div className={styles.agentBreakdown}>
                <div>
                  <strong>主代理自身</strong>
                  <span>main</span>
                  <small>输入 80k · 费用 $0.24</small>
                </div>
                <div>
                  <strong>调查导出入口</strong>
                  <span>explore</span>
                  <small>输入 40k · 费用 $0.12</small>
                </div>
              </div>
              <div className={styles.sessionRow}>
                <span>
                  <ChevronRight size={12} aria-hidden="true" />
                  <strong>整理使用说明</strong>
                </span>
                <span>输入 120k · 费用 $0.36</span>
                <small>另一条会话 · 无子代理</small>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
