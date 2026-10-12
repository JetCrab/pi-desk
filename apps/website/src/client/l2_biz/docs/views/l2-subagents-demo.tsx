'use client'

import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  FileSearch,
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
  X
} from 'lucide-react'
import type { ReactElement } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { useDocsDemoPlayback } from './l2-docs-demo-playback'
import workbench from './l2-background-tasks-demo.module.css'
import styles from './l2-subagents-demo.module.css'

const steps = [
  {
    title: '在主会话派发独立调查',
    detail: 'explore 只读查找导出入口，主代理继续整理验收清单。',
    duration: 3000
  },
  {
    title: '找到输入框上方的任务摘要',
    detail: '子代理启动后，点击“1 个任务执行中”进入任务中心。',
    duration: 3000
  },
  {
    title: '选择子代理的执行记录',
    detail: '当前任务是 explore；右侧是这个子代理自己的对话。',
    duration: 3000
  },
  {
    title: '查看子任务的工具过程',
    detail: '示例中先查找文件，再读取导出入口，没有修改项目。',
    duration: 3600
  },
  {
    title: '子任务完成，形成调查结论',
    detail: '详情显示关键文件和建议，任务状态变为“已完成”。',
    duration: 3000
  },
  {
    title: '结果主动回到主会话',
    detail: '关闭任务中心，主会话收到“返回结果”，主代理被唤醒。',
    duration: 3000
  },
  {
    title: '展开结果，主代理复核后继续',
    detail: '查看文件与入口，再由主代理决定下一步，不重复整段调查。',
    duration: 3400
  }
]

function InvestigationResult(): ReactElement {
  return (
    <div className={styles.result}>
      <span>
        入口：<code>src/export/csv.ts</code> → <code>exportTasks</code>
      </span>
      <span>
        调用方：<code>src/views/task-list.tsx</code>
      </span>
      <span>建议：检查空列表与引号转义。</span>
    </div>
  )
}

export function SubagentsAnimation(): ReactElement {
  const { root, step, playing, running, selectStep, togglePlaying } = useDocsDemoPlayback(steps)
  const open = step >= 2 && step <= 4
  const completed = step >= 4

  return (
    <figure ref={root} className={workbench.demo} aria-label="子代理操作演示">
      <div className={workbench.demoHeading}>
        <span>
          从派发到结论 <span>· 操作示意</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={playing ? '暂停子代理演示' : '播放子代理演示'}
          onClick={togglePlaying}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? '暂停' : '播放'}
        </Button>
      </div>
      <div data-plugin-demo="subagents" data-step={step} data-running={running}>
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
          <div className={workbench.workspace}>
            <aside className={workbench.sessionSidebar} aria-label="示例会话列表">
              <div className={workbench.sidebarToolbar} aria-hidden="true">
                <MessageSquare size={16} />
                <Folder size={16} />
                <Plus size={14} />
              </div>
              <div className={workbench.selectedSession}>
                <span>轻舟项目</span>
                <strong>检查 CSV 导出</strong>
                <small>刚刚</small>
              </div>
              <div className={workbench.otherSession}>
                <span>轻舟项目</span>
                <strong>整理使用说明</strong>
                <small>15 分钟前</small>
              </div>
              <div className={workbench.sidebarFooter}>
                <Settings size={15} aria-hidden="true" />
                <span>设置</span>
              </div>
            </aside>
            <div className={workbench.chatMain}>
              <div className={workbench.chatHeader}>
                <div>
                  <strong>轻舟项目</strong>
                  <span>检查 CSV 导出</span>
                </div>
                <MoreHorizontal size={16} aria-hidden="true" />
              </div>
              <div
                className={`${workbench.messages} ${styles.chatMessages}`}
                data-returned={step >= 5}
              >
                {step < 5 ? (
                  <>
                    <div className={workbench.userMessage}>
                      派发只读调查：查清 CSV 导出入口，返回关键文件。
                    </div>
                    <div>交给 explore；我先整理验收清单。</div>
                    {step >= 1 ? (
                      <div className={styles.agentCard}>
                        <div className={styles.cardHeader}>
                          <Bot size={16} aria-hidden="true" />
                          <strong>子代理</strong>
                          <span className={styles.role}>explore</span>
                          <small>启动任务</small>
                          <span className={styles.cardStatus}>已启动</span>
                        </div>
                        <div className={styles.cardTitle}>
                          调查 CSV 导出入口 <small>#demo0001</small>
                        </div>
                      </div>
                    ) : (
                      <div className={workbench.documentDraft}>
                        <strong>验收清单</strong>
                        <span>核对列名、空列表、引号转义</span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className={styles.agentCard} data-highlighted={step === 5}>
                      <button
                        type="button"
                        className={styles.returnHeader}
                        aria-label="展开示例子代理返回结果"
                        aria-expanded={step === 6}
                        onClick={() => selectStep(step === 6 ? 5 : 6)}
                      >
                        <span className={styles.cardHeader}>
                          <Bot size={16} aria-hidden="true" />
                          <strong>子代理</strong>
                          <span className={styles.role}>explore</span>
                          <small>返回结果</small>
                          <span className={styles.cardStatus}>
                            <Check size={12} aria-hidden="true" />
                            已完成
                            <ChevronDown size={14} aria-hidden="true" />
                          </span>
                        </span>
                        <span className={styles.cardTitle}>
                          调查 CSV 导出入口 <small>#demo0001</small>
                        </span>
                        {step === 5 && (
                          <MousePointer2
                            className={styles.returnPointer}
                            size={24}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                      {step === 6 && (
                        <div className={styles.returnResult}>
                          <strong>执行结果</strong>
                          <InvestigationResult />
                        </div>
                      )}
                    </div>
                    <div className={styles.mainReply}>
                      {step === 6
                        ? '根据调查结论，我继续复核导出规则。'
                        : '调查结果已收到，我来复核关键入口。'}
                    </div>
                  </>
                )}
              </div>
              <div className={workbench.inputArea}>
                {step >= 1 && !completed && (
                  <button
                    type="button"
                    className={workbench.taskSummary}
                    data-highlighted={step === 1}
                    aria-label="打开示例子代理任务中心"
                    onClick={() => selectStep(2)}
                  >
                    <span className={workbench.runningDot} aria-hidden="true" />
                    <strong>1 个任务执行中</strong>
                    <span>调查 CSV 导出入口 · 执行中</span>
                    <ChevronRight size={14} aria-hidden="true" />
                    {step === 1 && (
                      <MousePointer2
                        className={workbench.summaryPointer}
                        size={24}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                )}
                {step === 1 && (
                  <div className={workbench.entryGuide}>
                    从这里打开任务中心 <ArrowDown size={14} aria-hidden="true" />
                  </div>
                )}
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
          {open && (
            <div className={workbench.panelBackdrop}>
              <div className={workbench.taskPanel} role="group" aria-label="示例子代理任务中心">
                <aside className={workbench.taskList}>
                  <div className={workbench.listHeader}>
                    <ListTodo size={18} aria-hidden="true" />
                    <div>
                      <strong>任务中心</strong>
                      <span>1 条执行记录</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={workbench.taskRow}
                    data-highlighted={step === 2}
                    aria-label="查看示例子代理调查详情"
                    onClick={() => selectStep(3)}
                  >
                    {completed ? (
                      <Check size={15} aria-hidden="true" />
                    ) : (
                      <span className={workbench.runningDot} aria-hidden="true" />
                    )}
                    <span>
                      <strong>调查 CSV 导出入口</strong>
                      <small>子代理 · explore</small>
                    </span>
                    {step === 2 && (
                      <MousePointer2
                        className={workbench.listPointer}
                        size={24}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </aside>
                <div className={workbench.taskDetail}>
                  <div className={workbench.detailHeader}>
                    <div>
                      <strong>调查 CSV 导出入口</strong>
                      <span>子代理 · explore · {completed ? '已完成' : '执行中'}</span>
                    </div>
                    {!completed && (
                      <span className={styles.interruptLabel}>
                        <CircleStop size={14} aria-hidden="true" />
                        打断
                      </span>
                    )}
                    <button
                      type="button"
                      className={workbench.closePanel}
                      aria-label="关闭示例子代理任务中心"
                      onClick={() => selectStep(completed ? 5 : 1)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div className={workbench.taskInfo}>
                    <span>
                      运行信息 <strong>示例模型 · 8,000/128,000 tokens</strong>
                    </span>
                    <span>
                      消息数 <strong>{completed ? '1/6' : '1/4'}（用户/总数）</strong>
                    </span>
                  </div>
                  <div
                    className={styles.childConversation}
                    aria-label="示例子代理对话过程"
                    data-highlighted={step === 3}
                  >
                    <span className={styles.processLabel}>子代理对话 · 示意</span>
                    {!completed && (
                      <div className={styles.childRequest}>
                        只读查找导出入口，返回关键文件和建议。
                      </div>
                    )}
                    {step >= 3 ? (
                      <div className={styles.toolSteps}>
                        <span>
                          <Check size={12} aria-hidden="true" />
                          <code>find</code> 找到导出文件
                        </span>
                        <span>
                          <Check size={12} aria-hidden="true" />
                          <code>read</code> <code>src/export/csv.ts</code>
                        </span>
                      </div>
                    ) : (
                      <div className={styles.searching}>
                        <FileSearch size={16} aria-hidden="true" />
                        正在定位导出入口…
                      </div>
                    )}
                    {completed ? (
                      <div className={styles.childConclusion}>
                        <strong>调查结论</strong>
                        <InvestigationResult />
                      </div>
                    ) : (
                      step === 3 && (
                        <div className={styles.childObservation}>
                          已找到 exportTasks，接着核对调用位置。
                        </div>
                      )
                    )}
                  </div>
                </div>
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
      <nav className={workbench.stepTrack} aria-label="选择子代理演示步骤">
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
        可点击任务摘要、执行记录和返回结果。项目、文件与结果均为示意，不执行真实调查。
      </figcaption>
    </figure>
  )
}
