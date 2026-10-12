'use client'

import {
  ArrowUp,
  Database,
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
import { QuotaGuideSettings } from './l2-quota-guide-settings'
import { QuotaGuideApplication } from './l2-quota-guide-application'
import workbench from './l2-background-tasks-demo.module.css'
import styles from './l2-quota-guide-demo.module.css'

const steps = [
  {
    title: '从左侧栏底部打开“设置”',
    detail: '先在完整工作台找到设置入口，再配置额度来源。',
    duration: 2800
  },
  {
    title: '进入“插件设置 → 额度设置”',
    detail: '在额度来源页点击“添加来源”，不是在聊天中填入凭据。',
    duration: 3000
  },
  {
    title: '添加来源，选择OpenCode Go渠道',
    detail: '渠道决定查询方式与表单字段；这里选择真实支持的简单来源。',
    duration: 3000
  },
  {
    title: '填写显示名称与API Key占位符',
    detail: '本例启用轻舟项目来源；Key只是明确占位符，不连接真实服务。',
    duration: 3600
  },
  {
    title: '点击“保存全部更改”',
    detail: '这里只演示保存配置；保存成功不证明套餐、认证或查询成功。',
    duration: 2800
  },
  {
    title: '关闭设置，从左侧快捷区打开“额度”',
    detail: '配置和查看查询结果是两个步骤，应用标题是“额度查看器”。',
    duration: 2800
  },
  {
    title: '查看返回的额度窗口',
    detail: '示例5小时、周、月剩余分别为68%、43%、85%，不是金额。',
    duration: 3600
  },
  {
    title: '展开详情，核对窗口与更新时间',
    detail: '查看已用、剩余和重置时间；本例没有单独的账户名，使用来源名显示。',
    duration: 3600
  },
  {
    title: '刷新失败时，辨认保留的旧结果',
    detail: '示例显示来源异常和已过期，仍保留上次数据；失败不能当作额度归零。',
    duration: 3600
  }
]

export function QuotaGuideAnimation(): ReactElement {
  const { root, step, playing, running, selectStep, togglePlaying } = useDocsDemoPlayback(steps)
  const settings = step >= 1 && step <= 4
  const application = step >= 6
  return (
    <figure ref={root} className={workbench.demo} aria-label="额度查看操作演示">
      <div className={workbench.demoHeading}>
        <span>
          先配置，再查看额度 <span>· 操作示意</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={playing ? '暂停额度查看演示' : '播放额度查看演示'}
          onClick={togglePlaying}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? '暂停' : '播放'}
        </Button>
      </div>
      <div data-plugin-demo="quota" data-step={step} data-running={running}>
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
                <strong>整理项目资料</strong>
                <small>刚刚</small>
              </div>
              <div className={workbench.otherSession}>
                <span>轻舟项目</span>
                <strong>完善导出功能</strong>
                <small>15 分钟前</small>
              </div>
              <div className={styles.sidebarShortcuts}>
                <button
                  type="button"
                  aria-label="打开示例额度设置入口"
                  data-highlighted={step === 0}
                  onClick={() => selectStep(1)}
                >
                  <Settings size={17} aria-hidden="true" />
                  <span>设置</span>
                  {step === 0 && (
                    <MousePointer2
                      className={styles.shortcutPointer}
                      size={24}
                      aria-hidden="true"
                    />
                  )}
                </button>
                <button
                  type="button"
                  aria-label="打开示例额度查看器"
                  data-highlighted={step === 5}
                  onClick={() => selectStep(6)}
                >
                  <Database size={17} aria-hidden="true" />
                  <span>额度</span>
                  {step === 5 && (
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
                  <span>整理项目资料</span>
                </div>
                <MoreHorizontal size={16} aria-hidden="true" />
              </div>
              <div className={workbench.messages}>
                <div className={workbench.userMessage}>继续整理项目资料，我先查看服务额度。</div>
                <div>好的，当前对话保留在这里。</div>
                {step === 5 && (
                  <div className={workbench.documentDraft}>
                    <strong>来源已配置（示意）</strong>
                    <span>接下来打开“额度”检查查询结果。</span>
                  </div>
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
          {settings && <QuotaGuideSettings step={step} onSelectStep={selectStep} />}
          {application && <QuotaGuideApplication step={step} onSelectStep={selectStep} />}
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
      <nav className={workbench.stepTrack} aria-label="选择额度查看演示步骤">
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
        可点击设置、渠道、保存、额度、详情与刷新。全部是界面示意，不保存真实配置或访问服务。
      </figcaption>
    </figure>
  )
}
