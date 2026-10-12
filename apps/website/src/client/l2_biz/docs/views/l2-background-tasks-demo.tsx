'use client'

import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleStop,
  Folder,
  GitBranch,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  Paperclip,
  Pause,
  Play,
  Plus,
  Settings,
  Terminal,
  X
} from 'lucide-react'
import type { ReactElement } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { useDocsDemoPlayback } from './l2-docs-demo-playback'
import styles from './l2-background-tasks-demo.module.css'

const steps = [
  {
    title: '启动命令，前台继续独立工作',
    detail: '示例：预览服务在后台运行，助手继续整理使用说明。',
    duration: 2800
  },
  {
    title: '从输入框上方找到任务摘要',
    detail: '点击“1 个任务执行中”，打开当前会话的任务中心。',
    duration: 3200
  },
  {
    title: '在任务列表中选择预览服务',
    detail: '左侧是执行记录，右侧显示所选任务的详情。',
    duration: 3000
  },
  {
    title: '查看运行状态和日志',
    detail: '核对任务名称与输出，确认示例服务已就绪。',
    duration: 3600
  },
  {
    title: '服务用完，点击“打断”',
    detail: '这个按钮会停止当前后台命令，而不是关闭前台对话。',
    duration: 2800
  },
  {
    title: '再次点击“确认打断”',
    detail: '确认停止此任务及其完整进程树。',
    duration: 2400
  },
  {
    title: '任务变为“已停止”',
    detail: '日志仍可查看；关闭任务中心后，继续原来的对话。',
    duration: 3000
  }
]

export function BackgroundTasksAnimation(): ReactElement {
  const { root, step, playing, running, selectStep, togglePlaying } = useDocsDemoPlayback(steps)
  const open = step >= 2
  const stopped = step === 6

  return (
    <figure ref={root} className={styles.demo} aria-label="后台任务操作演示">
      <div className={styles.demoHeading}>
        <span>
          从启动到停止 <span>· 操作示意</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={playing ? '暂停后台任务演示' : '播放后台任务演示'}
          onClick={togglePlaying}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? '暂停' : '播放'}
        </Button>
      </div>
      <div data-plugin-demo="background-tasks" data-step={step} data-running={running}>
        <div className={styles.workbench}>
          <div className={styles.windowChrome}>
            <span aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>Pi Desk</span>
            <span>示例工作台</span>
          </div>
          <div className={styles.workspace}>
            <aside className={styles.sessionSidebar} aria-label="示例会话列表">
              <div className={styles.sidebarToolbar} aria-hidden="true">
                <MessageSquare size={16} />
                <Folder size={16} />
                <Plus size={14} />
              </div>
              <div className={styles.selectedSession}>
                <span>轻舟项目</span>
                <strong>整理使用说明</strong>
                <small>刚刚</small>
              </div>
              <div className={styles.otherSession}>
                <span>轻舟项目</span>
                <strong>完善导出功能</strong>
                <small>15 分钟前</small>
              </div>
              <div className={styles.sidebarFooter}>
                <Settings size={15} aria-hidden="true" />
                <span>设置</span>
              </div>
            </aside>
            <div className={styles.chatMain}>
              <div className={styles.chatHeader}>
                <div>
                  <strong>轻舟项目</strong>
                  <span>整理使用说明</span>
                </div>
                <MoreHorizontal size={16} aria-hidden="true" />
              </div>
              <div className={styles.messages}>
                <div className={styles.userMessage}>启动项目预览服务，同时整理使用说明。</div>
                <div className={styles.toolResult}>
                  <Terminal size={14} aria-hidden="true" />
                  <span>bg_run · 预览服务已启动</span>
                </div>
                <div>服务在后台运行，我先整理使用说明。</div>
                <div className={styles.documentDraft}>
                  <strong>使用说明</strong>
                  <span>1. 打开项目</span>
                  <span>2. 创建第一条任务</span>
                </div>
              </div>
              <div className={styles.inputArea}>
                {!stopped && (
                  <button
                    type="button"
                    className={styles.taskSummary}
                    data-highlighted={step === 1}
                    aria-label="打开示例任务中心"
                    onClick={() => selectStep(2)}
                  >
                    <span className={styles.runningDot} aria-hidden="true" />
                    <strong>1 个任务执行中</strong>
                    <span>预览服务 · 运行中</span>
                    <ChevronRight size={14} aria-hidden="true" />
                    {step === 1 && (
                      <MousePointer2
                        className={styles.summaryPointer}
                        size={24}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                )}
                {step === 1 && (
                  <div className={styles.entryGuide}>
                    从这里打开任务中心 <ArrowDown size={14} aria-hidden="true" />
                  </div>
                )}
                <div className={styles.composer}>
                  <span>继续输入消息…</span>
                  <div className={styles.composerTools} aria-hidden="true">
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
          {open && (
            <div className={styles.panelBackdrop}>
              <div className={styles.taskPanel} role="group" aria-label="示例任务中心">
                <aside className={styles.taskList}>
                  <div className={styles.listHeader}>
                    <ListTodo size={18} aria-hidden="true" />
                    <div>
                      <strong>任务中心</strong>
                      <span>1 条执行记录</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.taskRow}
                    data-highlighted={step === 2}
                    aria-label="查看示例预览服务详情"
                    onClick={() => selectStep(3)}
                  >
                    {stopped ? (
                      <CircleStop size={15} aria-hidden="true" />
                    ) : (
                      <span className={styles.runningDot} aria-hidden="true" />
                    )}
                    <span>
                      <strong>预览服务</strong>
                      <small>后台任务 · Shell</small>
                    </span>
                    {step === 2 && (
                      <MousePointer2 className={styles.listPointer} size={24} aria-hidden="true" />
                    )}
                  </button>
                </aside>
                <div className={styles.taskDetail}>
                  <div className={styles.detailHeader}>
                    <div>
                      <strong>预览服务</strong>
                      <span>{stopped ? '已停止' : '执行中 · 运行中'}</span>
                    </div>
                    {!stopped && (
                      <div
                        className={styles.stopAction}
                        data-highlighted={step === 4 || step === 5}
                      >
                        <Button
                          variant={step === 5 ? 'destructive' : 'outline'}
                          size="sm"
                          aria-label={step === 5 ? '确认打断示例后台任务' : '打断示例后台任务'}
                          onClick={() => selectStep(step === 5 ? 6 : 5)}
                        >
                          <CircleStop />
                          {step === 5 ? '确认打断' : '打断'}
                        </Button>
                        {(step === 4 || step === 5) && (
                          <MousePointer2
                            className={styles.stopPointer}
                            size={24}
                            aria-hidden="true"
                          />
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      className={styles.closePanel}
                      aria-label="关闭示例任务中心"
                      onClick={() => selectStep(stopped ? 0 : 1)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div className={styles.taskInfo}>
                    <span>
                      进程 <strong>{stopped ? 'stopped' : 'PID 1234'}</strong>
                    </span>
                    <span>
                      超时 <strong>1800s</strong>
                    </span>
                    <span>
                      输出 <strong>output.log · 示例日志</strong>
                    </span>
                  </div>
                  <div
                    className={styles.logArea}
                    data-highlighted={step === 3}
                    aria-label="示例后台任务日志"
                  >
                    <div className={styles.logLabel}>日志输出</div>
                    <pre className={styles.log}>
                      {
                        '[Command]\npnpm run preview\n\n[Output]\nPreview ready\nWaiting for requests…'
                      }
                    </pre>
                    {stopped && (
                      <div className={styles.stoppedNotice}>
                        <CircleStop size={15} aria-hidden="true" />
                        任务已停止，进程树已终止。
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
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
      </div>
      <nav className={styles.stepTrack} aria-label="选择后台任务演示步骤">
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
      <figcaption className={styles.demoNote}>
        可点击任务摘要、任务记录和“打断”跟着操作。所有内容均为示意，不执行真实命令。
      </figcaption>
    </figure>
  )
}
