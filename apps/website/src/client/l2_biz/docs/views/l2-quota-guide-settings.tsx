import { ChevronDown, ChevronRight, Check, X } from 'lucide-react'
import type { ReactElement } from 'react'
import { QuotaGuideSourceFields } from './l2-quota-guide-source'
import styles from './l2-quota-guide-demo.module.css'

export function QuotaGuideSettings({
  step,
  onSelectStep
}: {
  step: number
  onSelectStep: (step: number) => void
}): ReactElement {
  const form = step >= 3
  return (
    <div className={styles.overlay}>
      <div className={styles.panel} role="group" aria-label="示例额度设置">
        <div className={styles.panelHeader}>
          <strong>设置</strong>
          <span>表单示意 · 不连接真实服务</span>
          <button type="button" aria-label="关闭示例额度设置" onClick={() => onSelectStep(5)}>
            <X size={16} />
          </button>
        </div>
        <div className={styles.settingsLayout}>
          <nav className={styles.settingsNavigation} aria-label="示例设置分类">
            <span>插件</span>
            <strong>
              插件设置 <ChevronDown size={12} aria-hidden="true" />
            </strong>
            <button type="button" aria-label="选择示例额度设置" onClick={() => onSelectStep(1)}>
              额度设置
            </button>
          </nav>
          <div className={styles.settingsContent}>
            <div className={styles.settingsToolbar}>
              <span data-active="true">额度来源</span>
              <span>显示设置</span>
              <button type="button" aria-label="添加示例额度来源" onClick={() => onSelectStep(2)}>
                添加来源
              </button>
            </div>
            <div className={styles.sourceLayout}>
              <aside className={styles.sourceNavigation}>
                <span>搜索来源</span>
                {form ? (
                  <>
                    <strong>OpenCode Go</strong>
                    <span className={styles.sourceSelected}>
                      轻舟项目（示意）<small>{step === 4 ? '启用' : '未保存'}</small>
                    </span>
                  </>
                ) : (
                  <small>没有匹配来源</small>
                )}
              </aside>
              <div className={styles.sourceEditor}>
                {step === 1 ? (
                  <div className={styles.empty}>
                    <span>尚未配置额度来源</span>
                    <button type="button" onClick={() => onSelectStep(2)}>
                      添加来源
                    </button>
                  </div>
                ) : step === 2 ? (
                  <div className={styles.addSource}>
                    <strong>添加来源</strong>
                    <span>渠道</span>
                    <div className={styles.select}>
                      选择渠道 <ChevronDown size={12} aria-hidden="true" />
                    </div>
                    <div className={styles.channelOptions}>
                      <span>OpenRouter</span>
                      <span>Moonshot / Kimi API</span>
                      <span>SiliconFlow</span>
                      <span>智谱 Coding Plan</span>
                      <button
                        type="button"
                        aria-label="选择示例OpenCode Go渠道"
                        onClick={() => onSelectStep(3)}
                      >
                        OpenCode Go <ChevronRight size={12} aria-hidden="true" />
                      </button>
                      <span>CommandCode</span>
                      <span>Codex（通过 CPA）</span>
                      <span>Devin（通过 CPA）</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.sourceHeading}>
                      <strong>轻舟项目（示意）</strong>
                      <span>OpenCode Go</span>
                    </div>
                    {step === 4 && (
                      <div className={styles.saved}>
                        <Check size={13} aria-hidden="true" />
                        额度设置已保存（示意）
                      </div>
                    )}
                    <div className={styles.compactForm}>
                      <QuotaGuideSourceFields />
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className={styles.settingsFooter}>
              <span>
                {step === 3 ? '有未保存更改' : step === 4 ? '保存配置不等于查询成功' : ''}
              </span>
              <button
                type="button"
                aria-label="保存示例额度来源"
                disabled={!form || step === 4}
                onClick={() => onSelectStep(4)}
              >
                保存全部更改
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
