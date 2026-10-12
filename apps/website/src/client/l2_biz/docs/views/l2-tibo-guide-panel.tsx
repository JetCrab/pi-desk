import { useEffect, useRef, type ReactElement } from 'react'
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import styles from './l2-tibo-guide.module.css'

const english =
  'Demo only: A change to Codex usage limits is being discussed. No reset is confirmed.'
const translation = '仅为示例：正在讨论 Codex 用量限制的调整，尚未确认重置。'

function TiboSettingsForm({
  step,
  onSelectStep
}: {
  step: number
  onSelectStep: (step: number) => void
}): ReactElement {
  const chosen = step === 3
  return (
    <div className={styles.settingsForm}>
      <div className={styles.field}>
        <span>翻译模型</span>
        <button
          type="button"
          className={styles.fieldValue}
          data-highlighted={step === 1 || step === 2}
          onClick={() => onSelectStep(2)}
        >
          {chosen ? '演示服务 / 示例翻译模型' : '选择翻译模型'}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {step === 2 && (
          <div className={styles.modelOptions} aria-label="示例翻译模型选项">
            <span>选择翻译模型</span>
            <button type="button" onClick={() => onSelectStep(3)}>
              演示服务 / 示例翻译模型
              <Check size={14} aria-hidden="true" />
            </button>
            <small>模型名为演示占位，不调用服务</small>
          </div>
        )}
      </div>
      <button
        type="button"
        role="checkbox"
        aria-checked={chosen}
        className={styles.checkboxRow}
        onClick={() => onSelectStep(chosen ? 1 : 3)}
      >
        <span className={chosen ? styles.checked : styles.unchecked}>
          {chosen && <Check size={12} aria-hidden="true" />}
        </span>
        启用监听
      </button>
      <div className={styles.advancedTitle}>
        {chosen ? (
          <ChevronDown size={13} aria-hidden="true" />
        ) : (
          <ChevronRight size={13} aria-hidden="true" />
        )}
        更多设置
      </div>
      {chosen && (
        <div className={styles.configFields}>
          <label className={styles.field}>
            <span>检查间隔（秒）</span>
            <input aria-label="示例检查间隔（秒）" type="number" value={60} readOnly />
          </label>
          <label className={styles.field}>
            <span>保留动态（条）</span>
            <input aria-label="示例保留动态（条）" type="number" value={100} readOnly />
          </label>
        </div>
      )}
      <div className={styles.actionRow}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!chosen}
          data-highlighted={chosen}
          onClick={() => onSelectStep(4)}
        >
          保存设置
        </button>
        {chosen && <span>未保存</span>}
      </div>
      <div className={styles.advancedTitle}>
        <ChevronRight size={13} aria-hidden="true" />
        运行状态
      </div>
    </div>
  )
}

function TiboFeed({
  step,
  onSelectStep
}: {
  step: number
  onSelectStep: (step: number) => void
}): ReactElement {
  if (step === 4) {
    return (
      <div className={styles.savedState}>
        <div className={styles.saved}>
          <Check size={14} aria-hidden="true" />
          Tibo 监听设置已保存
        </div>
        <div className={styles.loading}>正在读取最新动态…</div>
        <span>首次抓取建立历史基线，不补发历史通知。</span>
      </div>
    )
  }
  return (
    <div className={styles.feed}>
      <div>
        <button
          type="button"
          className={styles.disclosure}
          onClick={() => onSelectStep(step === 5 ? 6 : 5)}
        >
          {step === 5 ? (
            <ChevronDown size={13} aria-hidden="true" />
          ) : (
            <ChevronRight size={13} aria-hidden="true" />
          )}
          最近动态 <span>2</span>
        </button>
        {step === 5 && (
          <div className={styles.records} data-scroll-target="true">
            <button
              type="button"
              className={styles.record}
              data-highlighted="true"
              onClick={() => onSelectStep(6)}
            >
              <div>
                <span>示例时间 · 10:30</span>
                <span className={styles.warning}>可能重置 · 推测</span>
              </div>
              <p>{translation}</p>
            </button>
            <div className={styles.record}>
              <div>
                <span>示例时间 · 09:00</span>
                <span>演示内容，并非真实发文</span>
              </div>
              <p lang="en">Demo only: Documentation updates are being prepared.</p>
            </div>
          </div>
        )}
      </div>
      <div className={styles.post} data-scroll-target={step >= 6 ? 'true' : undefined}>
        <div className={styles.postMeta}>
          <span>示例时间 · 10:30 · UTC</span>
          <button
            type="button"
            className={styles.originalLink}
            data-highlighted={step === 7}
            onClick={() => onSelectStep(7)}
          >
            原帖 ↗
          </button>
        </div>
        <div className={styles.author}>
          Tibo <span>@thsottiaux</span>
        </div>
        <p className={styles.translation}>{translation}</p>
        <div>
          <button
            type="button"
            className={styles.disclosure}
            data-highlighted={step === 6}
            onClick={() => onSelectStep(step === 6 ? 7 : 6)}
          >
            {step === 6 ? (
              <ChevronDown size={13} aria-hidden="true" />
            ) : (
              <ChevronRight size={13} aria-hidden="true" />
            )}
            查看英文原文
          </button>
          {step === 6 && (
            <p className={styles.english} lang="en">
              {english}
            </p>
          )}
        </div>
        <div>
          <button
            type="button"
            className={styles.disclosure}
            data-highlighted={step === 7}
            onClick={() => onSelectStep(step === 7 ? 6 : 7)}
          >
            {step === 7 ? (
              <ChevronDown size={13} aria-hidden="true" />
            ) : (
              <ChevronRight size={13} aria-hidden="true" />
            )}
            <span className={styles.warning}>可能重置 · 推测</span>
          </button>
          {step === 7 && (
            <div className={styles.reason}>
              <p>示例句谈及额度调整，但没有明确宣布重置；仅作为待核实线索，不能确认已重置。</p>
              <strong>模型判断，非官方确认</strong>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function TiboGuidePanel({
  step,
  onSelectStep
}: {
  step: number
  onSelectStep: (step: number) => void
}): ReactElement {
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const target = element.querySelector<HTMLElement>('[data-scroll-target="true"]')
    if (!target) {
      element.scrollTop = 0
      return
    }
    const top =
      target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
    element.scrollTo({
      top: Math.max(0, top - (element.clientHeight - target.offsetHeight) / 2),
      behavior: 'instant'
    })
  }, [step])

  return (
    <div className={styles.overlay}>
      <div className={styles.panel} role="group" aria-label="示例Tibo 动态设置页面">
        <div className={styles.panelHeader}>
          <strong>设置</strong>
          <span>界面示意</span>
          <button type="button" aria-label="关闭示例Tibo设置" onClick={() => onSelectStep(0)}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className={styles.settingsLayout}>
          <nav className={styles.settingsNavigation} aria-label="示例设置分类">
            <span>插件</span>
            <strong>
              插件设置
              <ChevronDown size={12} aria-hidden="true" />
            </strong>
            <button type="button" onClick={() => onSelectStep(1)}>
              Tibo 动态
            </button>
          </nav>
          <div className={styles.settingsContent}>
            <div className={styles.pageHeader}>
              <strong>Tibo 动态</strong>
              <div aria-label="示例Tibo页面切换">
                <span data-active={step >= 4}>动态</span>
                <span data-active={step <= 3}>设置</span>
              </div>
            </div>
            {step >= 4 && <div className={styles.demoDisclosure}>演示内容，并非真实发文</div>}
            <div className={styles.scrollContent} ref={scroll}>
              {step <= 3 ? (
                <TiboSettingsForm step={step} onSelectStep={onSelectStep} />
              ) : (
                <TiboFeed step={step} onSelectStep={onSelectStep} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
