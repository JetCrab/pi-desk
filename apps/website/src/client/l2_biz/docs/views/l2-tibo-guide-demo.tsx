'use client'

import {
  ArrowUp,
  Folder,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  Paperclip,
  Pause,
  Play,
  Plus,
  Settings
} from 'lucide-react'
import type { ReactElement } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { useDocsDemoPlayback } from './l2-docs-demo-playback'
import { TiboGuidePanel } from './l2-tibo-guide-panel'
import workbench from './l2-background-tasks-demo.module.css'
import styles from './l2-tibo-guide.module.css'

const steps = [
  {
    title: '从工作台左侧底部打开“设置”',
    detail: 'Tibo 动态在插件设置内，没有独立应用入口。',
    duration: 3000
  },
  {
    title: '进入“插件设置 → Tibo 动态”',
    detail: '首次默认显示设置：模型未选择，监听未启用。',
    duration: 3200
  },
  {
    title: '打开“翻译模型”，选择可用模型',
    detail: '这里选择演示模型；实际翻译会调用服务，可能产生费用。',
    duration: 3000
  },
  {
    title: '勾选“启用监听”，点击“保存设置”',
    detail: '保留默认60秒、100条。当前仍是未保存的设置草稿。',
    duration: 3200
  },
  {
    title: '保存成功，自动切到“动态”',
    detail: '开始读取；首次抓取只建立历史基线，不补发历史通知。',
    duration: 3000
  },
  {
    title: '展开“最近动态”，选择一条',
    detail: '这里已载入两条演示记录；当前详情按需翻译，历史不批量通知。',
    duration: 3600
  },
  {
    title: '列表收起，对照译文与英文原文',
    detail: '展开“查看英文原文”，阅读相同内容的两种表达。',
    duration: 4200
  },
  {
    title: '展开疑似重置提醒，核对依据与原帖入口',
    detail: '这是模型推测，不代表账户已重置；“原帖 ↗”用于回查来源。',
    duration: 4600
  }
] as const

export function TiboGuideAnimation(): ReactElement {
  const { root, step, playing, running, selectStep, togglePlaying } = useDocsDemoPlayback(steps)
  return (
    <figure
      ref={root}
      className={`${workbench.demo} ${styles.demo}`}
      aria-label="Tibo 动态操作演示"
    >
      <div className={workbench.demoHeading}>
        <span>
          从设置入口到动态解读 <span>· 操作示意</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={playing ? '暂停Tibo 动态演示' : '播放Tibo 动态演示'}
          onClick={togglePlaying}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? '暂停' : '播放'}
        </Button>
      </div>
      <div data-plugin-demo="tibo" data-step={step} data-running={running}>
        <div className={`${workbench.workbench} ${styles.workbench}`}>
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
                <strong>整理项目资料</strong>
                <small>刚刚</small>
              </div>
              <div className={workbench.otherSession}>
                <span>轻舟项目</span>
                <strong>完善导出功能</strong>
                <small>15 分钟前</small>
              </div>
              <button
                type="button"
                className={styles.settingsShortcut}
                data-highlighted={step === 0}
                onClick={() => selectStep(1)}
              >
                <Settings size={17} aria-hidden="true" />
                <span>设置</span>
                {step === 0 && (
                  <MousePointer2 className={styles.pointer} size={24} aria-hidden="true" />
                )}
              </button>
            </aside>
            <div className={workbench.chatMain}>
              <div className={workbench.chatHeader}>
                <div>
                  <strong>轻舟项目</strong>
                  <span>整理项目资料</span>
                </div>
                <MoreHorizontal size={16} aria-hidden="true" />
              </div>
              <div className={workbench.messages}>
                <div className={workbench.userMessage}>我先看一下公开动态，再继续整理。</div>
                <div>好的，当前对话保留在这里。</div>
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
          {step >= 1 && <TiboGuidePanel step={step} onSelectStep={selectStep} />}
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
      <nav className={workbench.stepTrack} aria-label="选择Tibo 动态演示步骤">
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
        演示内容，并非真实发文。可用步骤按钮回看；不保存真实配置、不抓取 RSS、不调用模型或访问原帖。
      </figcaption>
    </figure>
  )
}
