'use client'

import {
  ArrowUp,
  Check,
  Database,
  Folder,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  PanelTop,
  Paperclip,
  Pause,
  Play,
  Plus,
  Settings
} from 'lucide-react'
import type { ReactElement } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { useDocsDemoPlayback } from './l2-docs-demo-playback'
import { UsageGuideOverview } from './l2-usage-guide-overview'
import { UsageGuideAnalysis } from './l2-usage-guide-analysis'
import workbench from './l2-background-tasks-demo.module.css'
import styles from './l2-usage-guide-demo.module.css'

const steps = [
  {
    title: '从左侧栏底部打开“用量”',
    detail: '当前是完整工作台；从左侧底部快捷区进入模型用量总览。',
    duration: 3000
  },
  {
    title: '先看最近24小时的用量总览',
    detail: '示例输入120k、缓存命中50%，费用只作记录成本参考。',
    duration: 3000
  },
  {
    title: '切换到7天，查看消耗趋势',
    detail: '示例输入变为360k，可从趋势和日历找到消耗较高的日期。',
    duration: 3200
  },
  {
    title: '点击模型A，缩小统计范围',
    detail: '向下找到模型A，筛选后趋势与会话只显示它的记录，示例输入240k。',
    duration: 3000
  },
  {
    title: '展开会话，区分主代理与子代理',
    detail: '模型A在此会话的输入120k：主代理80k，子代理40k。',
    duration: 3400
  },
  {
    title: '回到聊天，从“更多”打开会话分析',
    detail: '先关闭总览，再点击输入框“更多 → 会话分析”，不是从总览跳转。',
    duration: 3200
  },
  {
    title: '查看单会话的消耗趋势',
    detail: '这里重新分析该会话记录；165k总Token含输出，不沿用总览模型筛选。',
    duration: 3600
  },
  {
    title: '在“代理”中查看各自用量',
    detail: '主代理99k、子代理66k，合计165k；不把子代理消耗都算给主代理。',
    duration: 3400
  },
  {
    title: '在“事件”中对照执行过程',
    detail: '查看模型调用、工具与子代理活动，定位消耗发生时正在做什么。',
    duration: 3200
  },
  {
    title: '关闭分析，继续原来的对话',
    detail: '用量页面只提供记录分析；关闭后仍在同一会话中继续。',
    duration: 2800
  }
]

export function UsageGuideAnimation(): ReactElement {
  const { root, step, playing, running, selectStep, togglePlaying } = useDocsDemoPlayback(steps)
  const overview = step >= 1 && step <= 4
  const analysis = step >= 6 && step <= 8
  return (
    <figure ref={root} className={workbench.demo} aria-label="模型用量操作演示">
      <div className={workbench.demoHeading}>
        <span>
          从总览到会话分析 <span>· 操作示意</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={playing ? '暂停模型用量演示' : '播放模型用量演示'}
          onClick={togglePlaying}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? '暂停' : '播放'}
        </Button>
      </div>
      <div data-plugin-demo="usage" data-step={step} data-running={running}>
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
            <aside className={workbench.sessionSidebar} aria-label="示例左侧栏">
              <div className={workbench.sidebarToolbar} aria-hidden="true">
                <MessageSquare size={16} />
                <Folder size={16} />
                <Plus size={14} />
              </div>
              <div className={workbench.selectedSession}>
                <span>轻舟项目</span>
                <strong>完善导出功能</strong>
                <small>刚刚</small>
              </div>
              <div className={workbench.otherSession}>
                <span>轻舟项目</span>
                <strong>整理使用说明</strong>
                <small>15 分钟前</small>
              </div>
              <div className={styles.sidebarShortcuts}>
                <span>
                  <Settings size={17} aria-hidden="true" />
                  设置
                </span>
                <button
                  type="button"
                  aria-label="打开示例模型用量总览"
                  data-highlighted={step === 0}
                  onClick={() => selectStep(1)}
                >
                  <PanelTop size={17} aria-hidden="true" />
                  <span>用量</span>
                  {step === 0 && (
                    <MousePointer2
                      className={styles.shortcutPointer}
                      size={24}
                      aria-hidden="true"
                    />
                  )}
                </button>
              </div>
            </aside>
            <div className={workbench.chatMain}>
              <div className={workbench.chatHeader}>
                <div>
                  <strong>轻舟项目</strong>
                  <span>完善导出功能</span>
                </div>
                <MoreHorizontal size={16} aria-hidden="true" />
              </div>
              <div className={workbench.messages}>
                <div className={workbench.userMessage}>
                  {step === 9
                    ? '看过用量了，继续整理验收报告。'
                    : '完成CSV导出，并让子代理只读调查关键入口。'}
                </div>
                <span className={workbench.toolResult}>
                  <Check size={13} aria-hidden="true" />
                  开发与调查已完成
                </span>
                <div>
                  {step === 9
                    ? '好的，继续沿用这段对话完成报告。'
                    : '导出已完成，子代理也返回了入口与检查建议。'}
                </div>
                <div className={workbench.documentDraft}>
                  <strong>验收清单</strong>
                  <span>空列表 · 列名 · 引号转义</span>
                </div>
              </div>
              <div className={workbench.inputArea}>
                <div className={workbench.composer}>
                  <span>继续输入消息…</span>
                  <div className={workbench.composerTools}>
                    <button
                      type="button"
                      className={styles.moreButton}
                      data-highlighted={step === 5}
                      aria-label="打开示例会话更多"
                      onClick={() => selectStep(5)}
                    >
                      <MoreHorizontal size={16} aria-hidden="true" />
                      {step === 5 && (
                        <MousePointer2
                          className={styles.morePointer}
                          size={24}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                    <Paperclip size={16} aria-hidden="true" />
                    <GitBranch size={13} aria-hidden="true" />
                    <span>main</span>
                    <span>示例模型</span>
                    <ArrowUp size={17} aria-hidden="true" />
                  </div>
                </div>
              </div>
              {step === 5 && (
                <div className={styles.moreMenu} role="group" aria-label="示例会话更多菜单">
                  <small>工具</small>
                  <span>任务中心</span>
                  <span>工具与上下文</span>
                  <span>重载 Pi 配置</span>
                  <small>插件</small>
                  <button type="button" aria-label="打开示例会话分析" onClick={() => selectStep(6)}>
                    <Database size={15} aria-hidden="true" />
                    会话分析
                  </button>
                </div>
              )}
            </div>
          </div>
          {overview && <UsageGuideOverview step={step} onSelectStep={selectStep} />}
          {analysis && <UsageGuideAnalysis step={step} onSelectStep={selectStep} />}
        </div>
        <div className={workbench.demoCaption} aria-label="当前演示步骤">
          <span className={workbench.stepNumber}>{String(step + 1).padStart(2, '0')}</span>
          <div aria-live={playing ? 'off' : 'polite'}>
            <strong>{steps[step].title}</strong>
            <span>{steps[step].detail}</span>
          </div>
          <span className={workbench.stepCount}>
            {step + 1} / {steps.length}
          </span>
        </div>
      </div>
      <nav className={workbench.stepTrack} aria-label="选择模型用量演示步骤">
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
        可点击“用量”、7天、模型A、会话和分析页签。全部为示例，不读取真实会话或查询账户。
      </figcaption>
    </figure>
  )
}
