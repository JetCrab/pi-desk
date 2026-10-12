import { useEffect, useRef, type ReactElement } from 'react'
import { ChevronDown, RefreshCw, X } from 'lucide-react'
import styles from './l2-quota-guide-demo.module.css'

const windows = [
  {
    label: '5 小时额度',
    remaining: 68,
    used: 32,
    countdown: '2 小时 20 分钟后重置',
    window: '5 小时滚动窗口',
    reset: '05/07 12:20'
  },
  {
    label: '周额度',
    remaining: 43,
    used: 57,
    countdown: '3 天后重置',
    window: '7 天滚动窗口',
    reset: '05/10 10:00'
  },
  {
    label: '月额度',
    remaining: 85,
    used: 15,
    countdown: '19 天后重置',
    window: '账期额度',
    reset: '05/26 10:00'
  }
]

export function QuotaGuideApplication({
  step,
  onSelectStep
}: {
  step: number
  onSelectStep: (step: number) => void
}): ReactElement {
  const expanded = step >= 7
  const failed = step === 8
  const body = useRef<HTMLDivElement>(null)
  const detail = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = body.current
    if (!element) return
    element.scrollTop =
      expanded && !failed && detail.current
        ? element.scrollTop +
          detail.current.getBoundingClientRect().top -
          element.getBoundingClientRect().top
        : 0
  }, [expanded, failed])
  return (
    <div className={styles.overlay}>
      <div className={styles.panel} role="group" aria-label="示例额度查看器">
        <div className={styles.panelHeader}>
          <strong>额度查看器</strong>
          <span>全部为示例响应</span>
          <button type="button" aria-label="关闭示例额度查看器" onClick={() => onSelectStep(5)}>
            <X size={16} />
          </button>
        </div>
        <div className={styles.applicationToolbar}>
          <span className={styles.search}>搜索渠道、来源或账号</span>
          <span className={styles.displayItems}>显示项</span>
          <button type="button" aria-label="刷新示例额度" onClick={() => onSelectStep(8)}>
            <RefreshCw size={12} aria-hidden="true" />
            刷新
          </button>
        </div>
        {failed && (
          <div className={styles.failure} role="status">
            <strong>1 个来源异常</strong>
            <span>轻舟项目（示意）：请求超时（示意）</span>
          </div>
        )}
        <div ref={body} className={styles.applicationBody}>
          <strong className={styles.channelHeading}>OpenCode Go</strong>
          <div className={styles.quotaRecord}>
            <div className={styles.recordHeader}>
              <strong>轻舟项目（示意）</strong>
              {failed && <span>来源异常 · 已过期</span>}
              <button
                type="button"
                aria-label="查看示例额度窗口详情"
                aria-expanded={expanded}
                onClick={() => onSelectStep(expanded ? 6 : 7)}
              >
                {expanded ? '收起' : '详情'}
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            </div>
            <div className={styles.windowMetrics}>
              {windows.map((window) => (
                <div key={window.label}>
                  <span>{window.label} · 剩余</span>
                  <strong>{window.remaining}%</strong>
                  <small>{window.countdown}</small>
                  <div
                    className={styles.progress}
                    role="progressbar"
                    aria-label={`示例${window.label}剩余`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={window.remaining}
                  >
                    <span style={{ width: `${window.remaining}%` }} />
                  </div>
                </div>
              ))}
            </div>
            {expanded && (
              <div ref={detail} className={styles.details}>
                <div className={styles.detailIdentity}>
                  <strong>轻舟项目（示意）</strong>
                  <span>来源：轻舟项目（示意） · 官方产品</span>
                  <span>数据更新于 05/07 10:00{failed ? ' · 已过期' : ''}</span>
                </div>
                {windows.map((window) => (
                  <div className={styles.windowDetail} key={window.label}>
                    <strong>
                      {window.label}
                      <small>{window.window}</small>
                    </strong>
                    <span>
                      剩余 <b>{window.remaining}%</b> · 已用 <b>{window.used}%</b>
                    </span>
                    <span>重置 {window.reset}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <span className={styles.responseNote}>
            {failed
              ? '刷新失败，保留的是上次示例结果，不是新的成功响应。'
              : '窗口百分比与重置时间均来自示例数据，不代表实际可用量。'}
          </span>
        </div>
      </div>
    </div>
  )
}
