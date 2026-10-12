'use client'

import {
  ArrowUp,
  Folder,
  GitBranch,
  Globe,
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
import { RemoteDebugGuidePanel } from './l2-remote-debug-guide-panel'
import workbench from './l2-background-tasks-demo.module.css'
import styles from './l2-remote-debug-guide.module.css'

const steps = [
  {
    title: '从工作台左侧打开“远程调试”',
    detail: '它用于访问项目开发网页，不是打开另一台设备的 Pi Desk 聊天。',
    duration: 2800
  },
  {
    title: '选择项目，找到已有启动项',
    detail: '本例选择 paperboat-demo 的 web-preview，当前“未启动”。',
    duration: 3000
  },
  {
    title: '点“详情”，核对启动项配置',
    detail: '命令必须监听配置的本地端口；启动项来自项目 .pi/remote_debug.yaml。',
    duration: 3600
  },
  {
    title: '在全局设置中核对连接前置条件',
    detail: '关闭应用，从“设置 → 插件设置 → 远程调试 → 连接”查看；连接须在桌面端配置。',
    duration: 3400
  },
  {
    title: '返回启动项，点击“启动”',
    detail: '显示“启动中”，按命令启动项目，等待本地端口，再连接隧道；尚无访问地址。',
    duration: 3200
  },
  {
    title: '“运行中”后查看远程访问地址',
    detail: '其他设备使用远程地址查看项目；本地地址只供托管主机访问。',
    duration: 4000
  },
  {
    title: '展开“详情 → 查看日志”',
    detail: '阅读项目命令与隧道日志；这里只展示示例记录，没有真实进程或网络连接。',
    duration: 4200
  },
  {
    title: '回到启动项头部，点击“停止”',
    detail: '显示“停止中…”，访问地址撤下；等待隧道、网关和项目命令清理完成。',
    duration: 3000
  },
  {
    title: '确认“已停止”，保留原启动项',
    detail: '本地、远程地址不再显示，可按“重新启动”；本次演示未实际开放端口。',
    duration: 3200
  }
] as const

export function RemoteDebugGuideAnimation(): ReactElement {
  const { root, step, playing, running, selectStep, togglePlaying } = useDocsDemoPlayback(steps)
  return (
    <figure ref={root} className={`${workbench.demo} ${styles.demo}`} aria-label="远程调试操作演示">
      <div className={workbench.demoHeading}>
        <span>
          从启动项到其他设备访问 <span>· 操作示意</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={playing ? '暂停远程调试演示' : '播放远程调试演示'}
          onClick={togglePlaying}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? '暂停' : '播放'}
        </Button>
      </div>
      <div data-plugin-demo="remote-debug" data-step={step} data-running={running}>
        <div className={`${workbench.workbench} ${styles.workbench}`}>
          <div className={workbench.windowChrome}>
            <span aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>Pi Desk</span>
            <span>教学示意 · 无真实网络</span>
          </div>
          <div className={workbench.workspace}>
            <aside className={workbench.sessionSidebar} aria-label="示例左侧栏">
              <div className={workbench.sidebarToolbar} aria-hidden="true">
                <MessageSquare size={16} />
                <Folder size={16} />
                <Plus size={14} />
              </div>
              <div className={workbench.selectedSession}>
                <span>paperboat-demo</span>
                <strong>检查窄屏导出页面</strong>
                <small>刚刚</small>
              </div>
              <div className={workbench.otherSession}>
                <span>notebook-demo</span>
                <strong>整理项目资料</strong>
                <small>15 分钟前</small>
              </div>
              <div className={styles.shortcuts}>
                <button type="button" onClick={() => selectStep(3)}>
                  <Settings size={17} aria-hidden="true" />
                  <span>设置</span>
                </button>
                <button type="button" data-highlighted={step === 0} onClick={() => selectStep(1)}>
                  <Globe size={17} aria-hidden="true" />
                  <span>远程调试</span>
                  {step === 0 && (
                    <MousePointer2 className={styles.entryPointer} size={24} aria-hidden="true" />
                  )}
                </button>
              </div>
            </aside>
            <div className={workbench.chatMain}>
              <div className={workbench.chatHeader}>
                <div>
                  <strong>paperboat-demo</strong>
                  <span>检查窄屏导出页面</span>
                </div>
                <MoreHorizontal size={16} aria-hidden="true" />
              </div>
              <div className={workbench.messages}>
                <div className={workbench.userMessage}>用其他设备检查这个项目的网页布局。</div>
                <div>先核对启动项和桌面隧道，再开始临时调试。</div>
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
          {step >= 1 && <RemoteDebugGuidePanel step={step} onSelectStep={selectStep} />}
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
      <nav className={workbench.stepTrack} aria-label="选择远程调试演示步骤">
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
        所有命令、网络与地址均为示意。地址只展示，不打开或复制；可用步骤按钮回看，不保存配置、分配端口或连接隧道。
      </figcaption>
    </figure>
  )
}
