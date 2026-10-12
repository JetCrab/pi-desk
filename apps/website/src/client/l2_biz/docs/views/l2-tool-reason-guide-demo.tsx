'use client'

import {
  ArrowUp,
  ChevronDown,
  ExternalLink,
  FileText,
  Folder,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  Paperclip,
  Pause,
  Play,
  Plus,
  Settings,
  Terminal
} from 'lucide-react'
import { useEffect, useRef, type ReactElement } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { useDocsDemoPlayback } from './l2-docs-demo-playback'
import workbench from './l2-background-tasks-demo.module.css'
import styles from './l2-tool-reason-guide.module.css'

const steps = [
  {
    title: '在完整工作台提出清楚任务',
    detail: '说明要核对导出字段、运行现有测试，并限制“先不要改代码”。',
    duration: 3200
  },
  {
    title: '读取文件时，同时看到简短目的',
    detail: 'read 旁显示“确认当前导出字段”。点击卡片右侧折叠箭头，不是文件预览图标。',
    duration: 3600
  },
  {
    title: '展开 read，核对路径、范围和内容',
    detail: '完整路径是 src/export/csv.ts；1–4 对应本次读取范围，下方是读取结果。',
    duration: 4200
  },
  {
    title: '后续命令也说明这次检查的目的',
    detail: 'bash 旁显示目的，下方保留测试命令；展开后的输出才是检查结果。',
    duration: 4200
  },
  {
    title: '回到结论，对照工具返回',
    detail: '理由只说明为什么做；真实任务仍需核对实际输出，不能当作执行成功保证。',
    duration: 3600
  }
] as const

function ReadCard({
  step,
  onSelectStep
}: {
  step: number
  onSelectStep: (step: number) => void
}): ReactElement {
  const expanded = step === 2
  return (
    <div className={styles.toolCard} data-scroll-target={expanded ? 'true' : undefined}>
      <div className={styles.toolTop}>
        <button
          type="button"
          className={styles.toolHeader}
          aria-label={expanded ? '收起 read 工具结果' : '展开 read 工具结果'}
          aria-expanded={expanded}
          data-highlighted={step === 1}
          onClick={() => onSelectStep(expanded ? 1 : 2)}
        >
          <FileText size={16} aria-hidden="true" />
          <div>
            <span>
              <code>read</code>
              <span>确认当前导出字段</span>
            </span>
            <small>
              csv.ts <span>· src/export</span>
            </small>
          </div>
          <span className={styles.previewSlot} aria-hidden="true" />
          <span className={styles.disclosure}>
            <ChevronDown
              size={15}
              aria-hidden="true"
              className={expanded ? styles.expanded : undefined}
            />
            {step === 1 && (
              <MousePointer2 className={styles.pointer} size={24} aria-hidden="true" />
            )}
          </span>
          <span className={styles.range}>1-4</span>
        </button>
        <span className={styles.filePreview} aria-label="文件预览入口示意，非展开结果入口">
          <ExternalLink size={14} aria-hidden="true" />
        </span>
      </div>
      {expanded && (
        <div className={styles.toolBody}>
          <div className={styles.fullPath}>src/export/csv.ts</div>
          <pre className={styles.output} aria-label="read 读取内容">
            {'// 教学示例，非真实项目文件\nexport const csvFields = [\n  "name", "email"\n];'}
          </pre>
        </div>
      )}
    </div>
  )
}

function BashCard({
  expanded,
  onSelectStep
}: {
  expanded: boolean
  onSelectStep: (step: number) => void
}): ReactElement {
  return (
    <div className={styles.toolCard} data-scroll-target={expanded ? 'true' : undefined}>
      <button
        type="button"
        className={styles.toolHeader}
        aria-label={expanded ? '收起 bash 工具结果' : '展开 bash 工具结果'}
        aria-expanded={expanded}
        data-highlighted={expanded}
        onClick={() => onSelectStep(expanded ? 4 : 3)}
      >
        <Terminal size={16} aria-hidden="true" />
        <div>
          <span>
            <code>bash</code>
            <span>核对导出字段相关测试</span>
          </span>
          <small>pnpm test -- csv</small>
        </div>
        <ChevronDown
          size={15}
          aria-hidden="true"
          className={expanded ? styles.expanded : undefined}
        />
      </button>
      {expanded && (
        <div className={styles.toolBody}>
          <pre className={styles.output} aria-label="工具输出">
            {'示例输出：2 tests passed\n教学示意，未实际运行命令'}
          </pre>
        </div>
      )}
    </div>
  )
}

export function ToolReasonGuideAnimation(): ReactElement {
  const { root, step, playing, running, selectStep, togglePlaying } = useDocsDemoPlayback(steps)
  const messages = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = messages.current
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
    <figure
      ref={root}
      className={`${workbench.demo} ${styles.demo}`}
      aria-label="工具调用理由操作演示"
    >
      <div className={workbench.demoHeading}>
        <span>
          从任务到简短调用目的 <span>· 操作示意</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={playing ? '暂停工具调用理由演示' : '播放工具调用理由演示'}
          onClick={togglePlaying}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? '暂停' : '播放'}
        </Button>
      </div>
      <div data-plugin-demo="tool-reason" data-step={step} data-running={running}>
        <div className={`${workbench.workbench} ${styles.workbench}`}>
          <div className={workbench.windowChrome}>
            <span aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>Pi Desk</span>
            <span>教学示意 · 未实际执行</span>
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
                <strong>核对 CSV 导出</strong>
                <small>刚刚</small>
              </div>
              <div className={workbench.otherSession}>
                <span>轻舟项目</span>
                <strong>整理项目资料</strong>
                <small>15 分钟前</small>
              </div>
              <div className={workbench.sidebarFooter}>
                <Settings size={15} aria-hidden="true" />
                <span>设置</span>
              </div>
            </aside>
            <div className={`${workbench.chatMain} ${styles.chatMain}`}>
              <div className={`${workbench.chatHeader} ${styles.chatHeader}`}>
                <div>
                  <strong>轻舟项目</strong>
                  <span>核对 CSV 导出</span>
                </div>
                <MoreHorizontal size={16} aria-hidden="true" />
              </div>
              <div className={`${workbench.messages} ${styles.messages}`} ref={messages}>
                <div className={workbench.userMessage}>
                  核对当前 CSV 导出字段，运行现有导出测试，先不要改代码。
                </div>
                {step === 0 ? (
                  <div className={styles.assistant}>先查看当前字段，再运行现有测试。</div>
                ) : (
                  <ReadCard step={step} onSelectStep={selectStep} />
                )}
                {step >= 3 && <BashCard expanded={step === 3} onSelectStep={selectStep} />}
                {step === 4 && (
                  <div className={styles.result} data-scroll-target="true">
                    <strong>示例结论</strong>
                    <span>当前字段为 name、email；示例测试输出为通过，未修改代码。</span>
                    <small>此处为教学示意，不代表实际执行结果。</small>
                  </div>
                )}
              </div>
              <div className={`${workbench.inputArea} ${styles.inputArea}`}>
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
      <nav className={workbench.stepTrack} aria-label="选择工具调用理由演示步骤">
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
        可点击工具卡片或步骤按钮回看。文件、工具调用和输出均为教学示意，不执行命令或读写项目文件。
      </figcaption>
    </figure>
  )
}
