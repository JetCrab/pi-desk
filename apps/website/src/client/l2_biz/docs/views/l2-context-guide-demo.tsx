'use client'

import {
  ArrowDown,
  ArrowUp,
  Check,
  Circle,
  Eraser,
  Folder,
  GitBranch,
  Layers,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  PanelLeft,
  Paperclip,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings
} from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import styles from './l2-context-guide-demo.module.css'

const steps = [
  {
    title: '打开要继续的会话',
    detail: '在左侧选择会话，右侧是这段对话的完整聊天区。',
    duration: 2800
  },
  {
    title: '找到输入框底部的圆环',
    detail: '就在当前会话输入框下方，附件图标的右侧。',
    duration: 3400
  },
  {
    title: '移到圆环，展开用量详情',
    detail: '电脑上悬停展开；在手机端操作时轻点圆环。',
    duration: 3200
  },
  {
    title: '点击面板中的“忽略”',
    detail: '查看可忽略量，再点击用量面板右下方的“忽略”。',
    duration: 3200
  },
  {
    title: '查看忽略后的占用',
    detail: '示例占用从 120k 降到 44k，聊天记录仍然保留。',
    duration: 2800
  },
  { title: '回到原会话继续', detail: '仍在同一个工作台、同一段对话中继续输入。', duration: 2800 }
]

function subscribeMotion(listener: () => void): () => void {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function ContextUsageAnimation(): ReactElement {
  const [step, setStep] = useState(0)
  const [requested, setRequested] = useState<boolean | null>(null)
  const reducedMotion = useSyncExternalStore(subscribeMotion, prefersReducedMotion, () => true)
  const playing = requested ?? !reducedMotion
  const [visible, setVisible] = useState(false)
  const root = useRef<HTMLElement>(null)
  const ignored = step >= 4
  const open = step >= 2 && step <= 4

  useEffect(() => {
    const element = root.current
    if (!element) return
    let inView = false
    const syncVisibility = (): void => setVisible(inView && !document.hidden)
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = entry.intersectionRatio >= 0.35
        syncVisibility()
      },
      { threshold: [0, 0.35] }
    )
    observer.observe(element)
    document.addEventListener('visibilitychange', syncVisibility)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', syncVisibility)
    }
  }, [])

  useEffect(() => {
    if (!playing || !visible) return
    const timer = window.setTimeout(() => {
      setStep((step + 1) % steps.length)
    }, steps[step].duration)
    return () => window.clearTimeout(timer)
  }, [playing, visible, step])

  function selectStep(next: number): void {
    setRequested(false)
    setStep(next)
  }

  return (
    <figure
      ref={root}
      className={styles.usage}
      aria-label="上下文忽略操作演示"
      data-running={playing && visible}
    >
      <div className={styles.demoHeading}>
        <span>
          跟着做一次 <span className={styles.eyebrow}>· 操作示意</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (playing) setRequested(false)
            else {
              if (step === steps.length - 1) setStep(0)
              setRequested(true)
            }
          }}
          aria-label={
            playing ? '暂停操作演示' : step === steps.length - 1 ? '重播操作演示' : '播放操作演示'
          }
        >
          {playing ? <Pause /> : step === steps.length - 1 ? <RotateCcw /> : <Play />}
          {playing ? '暂停' : step === steps.length - 1 ? '重播' : '播放演示'}
        </Button>
      </div>
      <div className={styles.workbench} aria-label="上下文操作示例画面" data-step={step}>
        <div className={styles.windowChrome}>
          <span aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>Pi Desk</span>
          <span />
        </div>
        <div className={styles.workspaceCamera} data-closeup={open}>
          <aside className={styles.sessionSidebar} aria-label="示例工作会话列表">
            <div className={styles.sidebarToolbar}>
              <MessageSquare size={17} />
              <Folder size={17} />
              <Plus size={15} />
            </div>
            <button
              type="button"
              className={styles.selectedSession}
              aria-label="打开示例会话完善导出功能"
              onClick={() => selectStep(1)}
            >
              <span>轻舟项目</span>
              <strong>完善导出功能</strong>
              <small>1 / 4 · 刚刚</small>
              {step === 0 && (
                <MousePointer2 className={styles.sessionPointer} size={23} aria-hidden="true" />
              )}
            </button>
            <div className={styles.otherSession}>
              <span>轻舟项目</span>
              <strong>整理使用文档</strong>
              <small>3 / 12 · 15 分钟前</small>
            </div>
            <div className={styles.otherSession}>
              <span>官网</span>
              <strong>检查移动端布局</strong>
              <small>2 / 8 · 1 小时前</small>
            </div>
            <div className={styles.sidebarFooter}>
              <Settings size={16} />
              <span>设置</span>
            </div>
          </aside>
          <div className={styles.chatMain}>
            <div className={styles.chatHeader}>
              <PanelLeft size={16} aria-hidden="true" />
              <span>
                <strong>轻舟项目</strong>
                <span>完善导出功能</span>
              </span>
              <MoreHorizontal size={16} aria-hidden="true" />
            </div>
            <div className={styles.messages}>
              <div className={styles.userMessage}>为任务列表增加 CSV 导出。</div>
              <span className={styles.processLabel}>
                <Check size={13} aria-hidden="true" />
                处理过程 · 3 次工具调用
              </span>
              <div className={styles.assistantMessage}>
                导出已完成，包含任务名称、状态和完成时间。
              </div>
              {step === 5 && (
                <>
                  <div className={styles.userMessage}>沿用刚才的方案，补充导出测试。</div>
                  <div className={styles.assistantMessage}>好的，继续按已有要求完善测试。</div>
                </>
              )}
            </div>
            {step <= 1 && (
              <div className={styles.locationGuide} data-input={step === 1}>
                <span className={styles.guideNumber}>{step + 1}</span>
                <span>{step === 0 ? '先打开要继续的会话' : '输入框底部 · 附件右侧的圆环'}</span>
                {step === 1 && <ArrowDown size={15} aria-hidden="true" />}
              </div>
            )}
            <div
              className={styles.composer}
              data-highlighted={step === 1}
              aria-label="示例会话输入框"
            >
              <div className={styles.placeholder}>
                {step === 5 ? '继续下一步…' : '输入消息，Enter 发送'}
              </div>
              <div className={styles.composerTools}>
                <MoreHorizontal size={16} aria-hidden="true" />
                <Paperclip size={16} aria-hidden="true" />
                <div className={styles.ringAnchor} data-highlighted={step === 1 || step === 2}>
                  <button
                    className={styles.contextRing}
                    type="button"
                    aria-label="查看示例上下文用量"
                    aria-expanded={open}
                    onClick={() => selectStep(2)}
                    onMouseEnter={() => {
                      if (!playing && step <= 1) selectStep(2)
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="8.5" />
                      <circle cx="12" cy="12" r="8.5" strokeDasharray={`${ignored ? 6 : 16} 54`} />
                    </svg>
                  </button>
                  {(step === 1 || step === 2) && (
                    <MousePointer2
                      key={step}
                      className={styles.ringPointer}
                      size={23}
                      aria-hidden="true"
                    />
                  )}
                </div>
                <span className={styles.branchLabel}>
                  <GitBranch size={13} />
                  main
                </span>
                <span>示例模型</span>
                <ArrowUp size={17} className={styles.send} aria-hidden="true" />
              </div>
            </div>
            {open && (
              <div className={styles.usagePopup} role="group" aria-label="示例上下文用量详情">
                <div className={styles.usageMetrics}>
                  <span>当前占用 / 上限</span>
                  <strong>{ignored ? '44k' : '120k'} / 400k</strong>
                </div>
                <div className={styles.usageTrack}>
                  <span style={{ width: ignored ? '11%' : '30%' }} />
                </div>
                <div className={styles.usageRow}>
                  <span>
                    <Circle size={8} fill="currentColor" />
                    忽略后预计保留
                  </span>
                  <strong>44k · 11%</strong>
                </div>
                <div className={styles.usageRow}>
                  <span>可忽略</span>
                  <strong>{ignored ? '0' : '76k'}</strong>
                </div>
                <div className={styles.usageRow}>
                  <span>已忽略</span>
                  <strong>{ignored ? '76k' : '0'}</strong>
                </div>
                <div className={styles.popupActions}>
                  <div className={styles.ignoreAction} data-highlighted={step === 3}>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={ignored}
                      onClick={() => selectStep(4)}
                      aria-label="忽略示例上下文"
                    >
                      <Eraser />
                      {ignored ? '已忽略' : '忽略'}
                    </Button>
                    {step === 3 && (
                      <MousePointer2
                        className={styles.ignorePointer}
                        size={23}
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <span className={styles.disabledAction}>
                    <Layers size={14} />
                    压缩
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className={styles.demoCaption} aria-label="当前演示步骤">
        <span className={styles.stepNumber}>0{step + 1}</span>
        <div aria-live={playing ? 'off' : 'polite'}>
          <strong>{steps[step].title}</strong>
          <span>{steps[step].detail}</span>
        </div>
        <span className={styles.stepCount}>
          {step + 1} / {steps.length}
        </span>
      </div>
      <nav className={styles.stepTrack} aria-label="选择操作演示步骤">
        {steps.map((item, index) => (
          <button
            key={item.title}
            type="button"
            aria-label={`${index + 1}. ${item.title}`}
            aria-current={step === index ? 'step' : undefined}
            onClick={() => selectStep(index)}
          >
            <span />
          </button>
        ))}
      </nav>
      <figcaption className={styles.demoNote}>
        <ArrowDown size={13} aria-hidden="true" />
        也可以直接点击示例会话、圆环和“忽略”。演示用量为示例。
      </figcaption>
    </figure>
  )
}
