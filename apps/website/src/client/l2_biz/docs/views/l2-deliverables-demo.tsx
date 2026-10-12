'use client'

import {
  ArrowUp,
  Check,
  ChevronDown,
  Code,
  File,
  FileText,
  Folder,
  GitBranch,
  Image as ImageIcon,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  Paperclip,
  Pause,
  Play,
  Settings,
  Wrench,
  X
} from 'lucide-react'
import type { ReactElement } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { useDocsDemoPlayback } from './l2-docs-demo-playback'
import workbench from './l2-background-tasks-demo.module.css'
import styles from './l2-deliverables-demo.module.css'

const steps = [
  {
    title: '先完成用户要求的文件',
    detail: '示例：助手完成轻舟项目的报告、总览页和封面图片。',
    duration: 3000
  },
  {
    title: '助手登记三项交付物',
    detail: 'deliverable 明确登记标题和路径，不自动扫描所有文件。',
    duration: 3200
  },
  {
    title: '找到左侧栏顶部的交付入口',
    detail: '交付物是左侧栏模式，点击文件图标切换到交付清单。',
    duration: 3200
  },
  {
    title: '从清单中选择任务总览页面',
    detail: '核对标题和项目路径，再点击 HTML 条目打开独立预览。',
    duration: 3000
  },
  {
    title: '查看具体的 HTML 页面',
    detail: '示例总览页在独立预览窗展示；这不是网站发布。',
    duration: 3600
  },
  {
    title: '回到清单，再选择图片',
    detail: '关闭页面预览，选择同一批交付中的项目封面。',
    duration: 2800
  },
  {
    title: '查看完成的封面图片',
    detail: '图片也使用独立预览，不需要离开当前工作台。',
    duration: 3400
  },
  {
    title: '关闭预览，回到对话',
    detail: '查看完成后继续提出要求，登记清单保留在当前会话分支。',
    duration: 2800
  }
]

function OverviewPage(): ReactElement {
  return (
    <div className={styles.overviewPage} aria-label="示例HTML页面预览">
      <div className={styles.pageHeader}>
        <span>轻舟</span>
        <span>任务 · 总览</span>
      </div>
      <div className={styles.pageContent}>
        <strong className={styles.pageTitle}>任务总览</strong>
        <span className={styles.pageSubtitle}>把想法变成可交付的结果。</span>
        <div className={styles.metrics}>
          <div>
            <span>全部任务</span>
            <strong>12</strong>
          </div>
          <div>
            <span>进行中</span>
            <strong>3</strong>
          </div>
          <div>
            <span>已完成</span>
            <strong>9</strong>
          </div>
        </div>
        <div className={styles.pageTasks}>
          <strong>本周交付</strong>
          <span>
            <Check size={14} aria-hidden="true" />
            任务总览页面<small>已完成</small>
          </span>
          <span>
            <Check size={14} aria-hidden="true" />
            项目封面图片<small>已完成</small>
          </span>
          <span>
            <FileText size={14} aria-hidden="true" />
            项目检查报告<small>待验收</small>
          </span>
        </div>
      </div>
    </div>
  )
}

function CoverImage(): ReactElement {
  return (
    <div className={styles.coverImage}>
      <svg viewBox="0 0 560 300" role="img" aria-label="示例轻舟项目封面图片">
        <rect width="560" height="300" rx="8" fill="#e8edf0" />
        <circle cx="442" cy="82" r="36" fill="#f8fafb" />
        <path d="M0 222 Q140 185 280 223 T560 224 V300 H0Z" fill="#cbd8df" />
        <path d="M0 258 Q140 222 280 257 T560 258 V300 H0Z" fill="#b8cbd5" />
        <path d="M365 222 H475 L455 242 H387Z" fill="#334854" />
        <path d="M418 104 V215 H367Z" fill="#ffffff" />
        <path d="M425 136 V215 H468Z" fill="#718d9d" />
        <text x="46" y="115" fill="#243844" fontSize="42" fontWeight="600">
          轻舟
        </text>
        <text x="48" y="151" fill="#526773" fontSize="16">
          从想法，到完成。
        </text>
        <text x="48" y="265" fill="#435a67" fontSize="12">
          项目封面 · 示意
        </text>
      </svg>
    </div>
  )
}

export function DeliverablesAnimation(): ReactElement {
  const { root, step, playing, running, selectStep, togglePlaying } = useDocsDemoPlayback(steps)
  const list = step >= 3 && step <= 6
  const preview = step === 4 || step === 6
  const image = step === 6

  return (
    <figure ref={root} className={workbench.demo} aria-label="交付物操作演示">
      <div className={workbench.demoHeading}>
        <span>
          从完成到预览 <span>· 操作示意</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={playing ? '暂停交付物演示' : '播放交付物演示'}
          onClick={togglePlaying}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? '暂停' : '播放'}
        </Button>
      </div>
      <div data-plugin-demo="deliverables" data-step={step} data-running={running}>
        <div className={workbench.workbench}>
          <div className={workbench.windowChrome}>
            <span aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>Pi Desk</span>
            <span>示例工作台</span>
          </div>
          <div className={`${workbench.workspace} ${styles.workspace}`} data-list={list}>
            <aside className={workbench.sessionSidebar} aria-label="示例左侧栏">
              <div className={styles.sidebarModes} aria-label="示例侧栏模式">
                <button
                  type="button"
                  aria-label="显示示例会话列表"
                  aria-pressed={!list}
                  onClick={() => selectStep(7)}
                >
                  <MessageSquare size={17} aria-hidden="true" />
                </button>
                <span aria-label="文件模式示意">
                  <Folder size={17} aria-hidden="true" />
                </span>
                <button
                  type="button"
                  aria-label="打开示例交付物侧栏"
                  title="交付物"
                  aria-pressed={list}
                  data-highlighted={step === 2}
                  onClick={() => selectStep(3)}
                >
                  <File size={17} aria-hidden="true" />
                  {step === 2 && (
                    <MousePointer2 className={styles.entryPointer} size={24} aria-hidden="true" />
                  )}
                </button>
              </div>
              {list ? (
                <div className={styles.deliveries} aria-label="示例交付物列表">
                  <div className={styles.listHeading}>
                    <strong>交付物</strong>
                    <span>当前会话分支</span>
                    <span>最新交付排在最前</span>
                  </div>
                  <div className={styles.batch}>
                    <div className={styles.fileRow}>
                      <FileText size={17} aria-hidden="true" />
                      <span>
                        <strong>项目检查报告</strong>
                        <small>deliverables/report.md</small>
                      </span>
                    </div>
                    <button
                      type="button"
                      className={styles.fileRow}
                      data-highlighted={step === 3}
                      aria-label="打开示例任务总览页面"
                      onClick={() => selectStep(4)}
                    >
                      <Code size={17} aria-hidden="true" />
                      <span>
                        <strong>任务总览页面</strong>
                        <small>deliverables/overview.html</small>
                      </span>
                      {step === 3 && (
                        <MousePointer2
                          className={styles.filePointer}
                          size={24}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      className={styles.fileRow}
                      data-highlighted={step === 5}
                      aria-label="打开示例项目封面图片"
                      onClick={() => selectStep(6)}
                    >
                      <ImageIcon size={17} aria-hidden="true" />
                      <span>
                        <strong>项目封面图片</strong>
                        <small>deliverables/cover.png</small>
                      </span>
                      {step === 5 && (
                        <MousePointer2
                          className={styles.filePointer}
                          size={24}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className={workbench.selectedSession}>
                    <span>轻舟项目</span>
                    <strong>制作项目交付</strong>
                    <small>刚刚</small>
                  </div>
                  <div className={workbench.otherSession}>
                    <span>轻舟项目</span>
                    <strong>检查 CSV 导出</strong>
                    <small>15 分钟前</small>
                  </div>
                </>
              )}
              <div className={workbench.sidebarFooter}>
                <Settings size={15} aria-hidden="true" />
                <span>设置</span>
              </div>
            </aside>
            <div className={workbench.chatMain}>
              <div className={workbench.chatHeader}>
                <div>
                  <strong>轻舟项目</strong>
                  <span>制作项目交付</span>
                </div>
                <MoreHorizontal size={16} aria-hidden="true" />
              </div>
              <div className={`${workbench.messages} ${styles.messages}`}>
                {step === 7 ? (
                  <>
                    <div className={workbench.userMessage}>页面和封面都看过了，继续完善报告。</div>
                    <div>好的，沿用这份交付清单继续。</div>
                    <span className={styles.finished}>
                      <Check size={14} aria-hidden="true" />
                      交付记录仍保留在这个会话中
                    </span>
                  </>
                ) : (
                  <>
                    <div className={workbench.userMessage}>
                      完成报告、总览页和封面，并登记交付物。
                    </div>
                    <div>三个文件已完成，{step === 0 ? '准备登记。' : '已登记交付物。'}</div>
                    {step === 0 ? (
                      <div className={styles.completedFiles}>
                        <span>
                          <Check size={13} aria-hidden="true" />
                          项目检查报告 · Markdown
                        </span>
                        <span>
                          <Check size={13} aria-hidden="true" />
                          任务总览页面 · HTML
                        </span>
                        <span>
                          <Check size={13} aria-hidden="true" />
                          项目封面图片 · PNG
                        </span>
                      </div>
                    ) : (
                      <div
                        className={styles.registration}
                        data-highlighted={step === 1}
                        aria-label="示例交付登记消息"
                      >
                        <div className={styles.toolHeading}>
                          <Wrench size={14} aria-hidden="true" />
                          <code>deliverable</code>
                          <ChevronDown size={14} aria-hidden="true" />
                        </div>
                        <div className={styles.registerOutput}>
                          <span>已登记 3 个交付物：</span>
                          <span>
                            - 项目检查报告：<code>deliverables/report.md</code>
                          </span>
                          <span>
                            - 任务总览页面：<code>deliverables/overview.html</code>
                          </span>
                          <span>
                            - 项目封面图片：<code>deliverables/cover.png</code>
                          </span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className={workbench.inputArea}>
                <div className={workbench.composer}>
                  <span>继续输入消息…</span>
                  <div className={workbench.composerTools} aria-hidden="true">
                    <MoreHorizontal size={16} />
                    <Paperclip size={16} />
                    <GitBranch size={13} />
                    <span>main</span>
                    <span>示例模型</span>
                    <ArrowUp size={17} />
                  </div>
                </div>
              </div>
            </div>
          </div>
          {step === 2 && <div className={styles.entryGuide}>← 左侧栏顶部 · 交付物文件图标</div>}
          {preview && (
            <div className={styles.previewBackdrop}>
              <div className={styles.previewPanel} role="group" aria-label="示例独立文件预览">
                <div className={styles.previewHeader}>
                  <div>
                    <strong>{image ? 'cover.png' : 'overview.html'}</strong>
                    <span>轻舟项目 · deliverables/{image ? 'cover.png' : 'overview.html'}</span>
                  </div>
                  <button
                    type="button"
                    aria-label="关闭示例交付物预览"
                    onClick={() => selectStep(image ? 7 : 5)}
                  >
                    <X size={17} />
                  </button>
                </div>
                {image ? <CoverImage /> : <OverviewPage />}
              </div>
            </div>
          )}
        </div>
        <div className={workbench.demoCaption} aria-label="当前演示步骤">
          <span className={workbench.stepNumber}>0{step + 1}</span>
          <div aria-live={playing ? 'off' : 'polite'}>
            <strong>{steps[step].title}</strong>
            <span>{steps[step].detail}</span>
          </div>
          <span className={workbench.stepCount}>
            {step + 1} / {steps.length}
          </span>
        </div>
      </div>
      <nav className={workbench.stepTrack} aria-label="选择交付物演示步骤">
        {steps.map((item, index) => (
          <button
            key={item.title}
            type="button"
            aria-label={`演示步骤 ${index + 1}`}
            aria-current={step === index ? 'step' : undefined}
            onClick={() => selectStep(index)}
          >
            <span />
          </button>
        ))}
      </nav>
      <figcaption className={workbench.demoNote}>
        可点击交付入口、HTML 与图片条目、预览关闭按钮。项目、文件和画面均为示意。
      </figcaption>
    </figure>
  )
}
