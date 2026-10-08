'use client'

import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ListTodo,
  LoaderCircle,
  X
} from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useState, type ReactElement } from 'react'
import type { ShowcaseSceneProps } from '../../l2-showcase-story'
import { useDemoState } from '../../hooks/l2-use-demo-state'
import { DemoDevices } from '../l2-demo-devices'
import {
  Action,
  AssistantMessage,
  Chat,
  CodeView,
  Composer,
  Desk,
  IconButton,
  Menu,
  MenuItem,
  ProcessRow,
  UserMessage
} from '../l2-demo-ui'
import styles from './l2-agents-scene.module.css'

const taskTitle = '只读调查 CSV 导出实现'
const prompt =
  '只读调查现有 CSV 导出实现，找到入口、导出范围和文件名来源，返回文件路径和关键函数。不要修改文件。'
const findings = [
  '入口：src/export.ts 中的 exportTasks。',
  '范围：直接读取 tasks，没有排除已完成任务。',
  '文件名：由项目标识拼接为 qingzhou-tasks.csv。'
]
function AgentsDevice({
  step,
  elapsed = 0,
  onStep,
  mobile
}: ShowcaseSceneProps & { mobile: boolean }): ReactElement {
  const reduced = useReducedMotion()
  const [drawer, setDrawer] = useState(false)
  const [menu, setMenu] = useState(false)
  const [state, setState] = useDemoState(
    step,
    (next) => ({
      center: next >= 2 && next <= 4,
      detail: next >= 3,
      returned: next === 6,
      started: false,
      tool: next === 3
    }),
    (previous, next) => ({
      ...previous,
      center: next >= 2 && next <= 4,
      detail: next >= 3,
      returned: next === 6,
      tool: previous.tool || next === 3
    })
  )
  function patch(value: Partial<typeof state>): void {
    setState((previous) => ({ ...previous, ...value }))
    setMenu(false)
    onStep(step)
  }
  const { center, tool } = state
  const completed = step >= 4
  function messageCard(returned: boolean): ReactElement {
    const message = returned ? state.returned : state.started
    return (
      <div className={styles.messageCard}>
        <button
          type="button"
          aria-label={returned ? '展开子代理返回结论' : '展开子代理启动要求'}
          aria-expanded={message}
          onClick={() => {
            patch(returned ? { returned: !message } : { started: !message })
          }}
        >
          <span className={styles.successMark}>✓</span>
          <div>
            <strong>
              {returned ? '子代理返回' : '启动子代理'}
              <small> · explore</small>
            </strong>
            <span>{taskTitle}</span>
          </div>
          <ChevronDown size={15} />
        </button>
        {message && (
          <div className={styles.messageDetail}>
            {returned ? (
              <ul>
                {findings.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            ) : (
              <p>{prompt}</p>
            )}
          </div>
        )}
      </div>
    )
  }
  return (
    <Desk
      className={styles.desk}
      mobile={mobile}
      mobileSidebar={drawer}
      sessions={[
        {
          id: 'agents',
          title: '开发导出功能',
          active: true,
          counts: { user: step > 0 ? 2 : 1, total: step >= 5 ? 10 : step >= 1 ? 7 : 4 },
          updated: '刚刚',
          onSelect: () => setDrawer(false)
        }
      ]}
    >
      <Chat
        title="开发导出功能"
        focused
        autoScroll={step >= 5}
        scrollKey={`${step}:${state.returned}`}
        onMenu={() => setDrawer(true)}
        composer={
          <Composer
            draft={
              step === 0
                ? reduced
                  ? prompt
                  : prompt.slice(0, Math.floor((elapsed / 1000) * prompt.length))
                : ''
            }
            onSend={step === 0 && (reduced || elapsed >= 1000) ? () => onStep(1) : undefined}
            task={step === 1 ? '1 项运行中 · 只读调查 CSV 导出实现' : undefined}
            taskRunning={step === 1}
            onTask={step > 0 ? () => patch({ center: true, detail: false }) : undefined}
            onMore={() => {
              setMenu(!menu)
              onStep(step)
            }}
            panel={
              menu ? (
                <Menu title="工具">
                  <MenuItem
                    icon={<ListTodo size={16} />}
                    onClick={() => patch({ center: true, detail: false })}
                  >
                    任务中心
                  </MenuItem>
                </Menu>
              ) : undefined
            }
          />
        }
      >
        <UserMessage>给任务列表增加 CSV 导出，包含已完成任务。</UserMessage>
        <AssistantMessage>
          <p>导出功能已完成，文件名为 qingzhou-tasks.csv。</p>
        </AssistantMessage>
        {step > 0 && <UserMessage>{prompt}</UserMessage>}
        {step >= 1 && (
          <>
            {messageCard(false)}
            <AssistantMessage>
              <p>
                只读调查已交给
                explore。我先整理不依赖代码调查的发布清单：文档更新、桌面与手机验收、发布说明。
              </p>
            </AssistantMessage>
          </>
        )}
        {step >= 5 && (
          <>
            {messageCard(true)}
            <AssistantMessage>
              <p data-guide-target="agent-parent-result">
                收到调查结论，接着核对 exportTasks 的导出范围与文件名检查。
              </p>
            </AssistantMessage>
          </>
        )}
      </Chat>
      {center && (
        <div className={styles.centerBackdrop}>
          <section className={styles.taskCenter} data-detail={state.detail} aria-label="任务中心">
            <aside className={styles.taskList}>
              <header>
                <ListTodo size={20} />
                <div>
                  <strong>任务中心</strong>
                  <small>1 条记录</small>
                </div>
                <IconButton label="关闭任务中心" onClick={() => patch({ center: false })}>
                  <X size={16} />
                </IconButton>
              </header>
              <div className={styles.listBody}>
                <button
                  type="button"
                  className={styles.taskRow}
                  aria-label={`查看任务 ${taskTitle}`}
                  onClick={() => patch({ detail: true })}
                >
                  {completed ? (
                    <CheckCircle2 size={16} className={styles.success} />
                  ) : (
                    <LoaderCircle size={16} className={styles.spinner} />
                  )}
                  <div>
                    <strong>{taskTitle}</strong>
                    <small>子代理 / explore</small>
                    <span>{completed ? '48 秒' : '12 秒'} · 10:42</span>
                  </div>
                  <ChevronRight size={15} />
                </button>
              </div>
            </aside>
            <div className={styles.taskDetail}>
              <div className={styles.mobileNavigation}>
                <IconButton label="返回任务列表" onClick={() => patch({ detail: false })}>
                  <ArrowLeft size={16} />
                </IconButton>
                <span>{taskTitle}</span>
                <IconButton label="关闭子代理对话" onClick={() => patch({ center: false })}>
                  <X size={16} />
                </IconButton>
              </div>
              <header className={styles.detailHeader}>
                <div>
                  {completed ? (
                    <CheckCircle2 size={16} className={styles.success} />
                  ) : (
                    <LoaderCircle size={16} className={styles.spinner} />
                  )}
                  <h3>子代理 / explore · {taskTitle}</h3>
                </div>
                <p data-guide-target="agent-working">
                  <span>{completed ? '已完成' : '运行中'}</span>
                  {completed ? '48 秒 · 调查完成' : '12 秒 · 正在读取导出入口'}
                </p>
                {!completed && (
                  <Action disabled label="当前演示只展示只读调查完成流程">
                    中断
                  </Action>
                )}
              </header>
              <dl className={styles.info}>
                <div>
                  <dt>运行信息</dt>
                  <dd>示例模型 · {completed ? '3,240' : '1,820'} / 128,000 tokens</dd>
                </div>
                <div>
                  <dt>会话文件</dt>
                  <dd>/home/demo/.pi/agent/sessions/subagents/export-explore.jsonl</dd>
                </div>
              </dl>
              <div className={styles.conversation} tabIndex={0} aria-label="子代理完整执行过程">
                <UserMessage>{prompt}</UserMessage>
                <AssistantMessage>
                  <p>先定位导出入口，再检查过滤条件与下载文件名。全程只读。</p>
                </AssistantMessage>
                <ProcessRow
                  expanded={tool}
                  onClick={() => {
                    patch({ tool: !tool })
                  }}
                >
                  <span data-guide-target="agent-read">read · src/export.ts</span>
                </ProcessRow>
                {tool && (
                  <div className={styles.toolOutput}>
                    <CodeView
                      lines={[
                        'export function exportTasks(tasks, project) {',
                        '  const rows = tasks.map(toCsvRow)',
                        '  downloadCsv(rows, `${project.slug}-tasks.csv`)',
                        '}'
                      ]}
                    />
                  </div>
                )}
                {completed ? (
                  <AssistantMessage>
                    <ul>
                      {findings.map((text) => (
                        <li key={text}>{text}</li>
                      ))}
                    </ul>
                    <p>未修改任何文件。</p>
                  </AssistantMessage>
                ) : (
                  <div className={styles.activity}>
                    <LoaderCircle size={14} className={styles.spinner} />
                    正在只读检查导出实现
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </Desk>
  )
}
export function AgentsScene(props: ShowcaseSceneProps): ReactElement {
  return <DemoDevices>{(mobile) => <AgentsDevice {...props} mobile={mobile} />}</DemoDevices>
}
