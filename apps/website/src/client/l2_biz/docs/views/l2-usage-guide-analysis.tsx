import { Check, X } from 'lucide-react'
import type { ReactElement } from 'react'
import { UsageGuideChart } from './l2-usage-guide-chart'
import styles from './l2-usage-guide-demo.module.css'

export function UsageGuideAnalysis({
  step,
  onSelectStep
}: {
  step: number
  onSelectStep: (step: number) => void
}): ReactElement {
  return (
    <div className={styles.overlay}>
      <div className={styles.panel} role="group" aria-label="示例会话分析">
        <div className={styles.panelHeader}>
          <strong>会话分析</strong>
          <span>完善导出功能 · 示例记录</span>
          <button type="button" aria-label="关闭示例会话分析" onClick={() => onSelectStep(9)}>
            <X size={16} />
          </button>
        </div>
        <div className={styles.analysisTabs} aria-label="示例会话分析视图">
          {['趋势', '代理', '事件'].map((label, index) => (
            <button
              key={label}
              type="button"
              aria-pressed={step === index + 6}
              onClick={() => onSelectStep(index + 6)}
            >
              {label}
            </button>
          ))}
          <span>刷新</span>
        </div>
        <div className={styles.analysisBody}>
          <div className={styles.analysisKpis}>
            <div>
              <strong>165k</strong>
              <span>总 Token</span>
            </div>
            <div>
              <strong>$0.45</strong>
              <span>费用</span>
            </div>
            <div>
              <strong>10</strong>
              <span>模型调用</span>
            </div>
            <div>
              <strong>50%</strong>
              <span>缓存命中</span>
            </div>
          </div>
          {step === 6 ? (
            <>
              <div className={styles.metricControls}>
                <span data-active="true">Token/分</span>
                <span>调用/分</span>
                <span>费用/分</span>
                <span>命中率</span>
              </div>
              <div className={styles.sourceFilters}>
                <span data-active="true">全部</span>
                <span>完善导出功能</span>
                <span>代理 1 · 调查导出入口</span>
              </div>
              <div className={styles.analysisTrend}>
                <UsageGuideChart
                  values={[2, 4, 6, 7, 4]}
                  labels={['10:00', '10:08', '10:15', '10:23', '10:30']}
                  unit="Token/分 · k tokens"
                />
              </div>
              <div className={styles.totalsStrip}>
                <span>全会话汇总</span>
                <strong>输入 150k</strong>
                <strong>输出 15k</strong>
              </div>
              <small className={styles.scopeNote}>
                全会话记录 · 总 Token 含输出，不是当前上下文占用
              </small>
            </>
          ) : step === 7 ? (
            <div className={styles.agentTable} aria-label="示例主子代理用量">
              <div className={styles.tableHead}>
                <span>代理</span>
                <span>Token</span>
                <span>费用</span>
                <span>调用</span>
              </div>
              <div>
                <span>
                  <strong>主代理</strong>
                  <small>当前会话代理</small>
                </span>
                <strong>99k</strong>
                <span>$0.27</span>
                <span>6</span>
              </div>
              <div>
                <span>
                  <strong>调查导出入口</strong>
                  <small>explore · 1 次运行</small>
                </span>
                <strong>66k</strong>
                <span>$0.18</span>
                <span>4</span>
              </div>
              <div className={styles.share}>
                <span>主代理 60%</span>
                <span>子代理 40%</span>
                <div>
                  <i />
                  <i />
                </div>
              </div>
              <small className={styles.scopeNote}>
                99k + 66k = 165k，总费用 $0.45 · 所有数值均为示例
              </small>
            </div>
          ) : (
            <div className={styles.events} aria-label="示例会话活动列表">
              <div>
                <span className={styles.eventTime}>10:24</span>
                <span>
                  <strong>主代理 · 模型调用</strong>
                  <small>示例服务 / 模型 A · 21k Token · $0.063</small>
                </span>
                <Check size={13} aria-hidden="true" />
              </div>
              <div>
                <span className={styles.eventTime}>10:18</span>
                <span>
                  <strong>调查导出入口 · read</strong>
                  <small>读取 src/export/csv.ts · 完成</small>
                </span>
                <Check size={13} aria-hidden="true" />
              </div>
              <div>
                <span className={styles.eventTime}>10:10</span>
                <span>
                  <strong>调查导出入口 · 子代理运行</strong>
                  <small>只读调查导出入口 · 完成</small>
                </span>
                <Check size={13} aria-hidden="true" />
              </div>
              <div>
                <span className={styles.eventTime}>10:02</span>
                <span>
                  <strong>主代理 · write</strong>
                  <small>补充验收清单 · 完成</small>
                </span>
                <Check size={13} aria-hidden="true" />
              </div>
              <small className={styles.scopeNote}>
                记录中的可观测活动 · 工具事件本身不等于一笔模型费用
              </small>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
