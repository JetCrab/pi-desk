'use client'

import { Check, Database, Globe, LoaderCircle, SquareChartGantt, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { ShowcaseSceneProps } from '../../l2-showcase-story'
import { useDemoState } from '../../hooks/l2-use-demo-state'
import { useDemoColumnMotion } from '../../hooks/l2-use-demo-column-motion'
import { DemoActivity } from '../../hooks/l2-demo-activity'
import {
  AssistantMessage,
  Chat,
  Composer,
  Desk,
  IconButton,
  Modal,
  Action,
  Phone,
  ProcessRow,
  UserMessage,
  type DemoSession
} from '../l2-demo-ui'
import { useDemoViewport } from '../../hooks/l2-use-demo-viewport'
import { DemoDeviceContent, DesktopWindow } from '../l2-demo-devices'
import deviceStyles from '../l2-demo-devices.module.css'
import styles from './l2-pin-scene.module.css'

const titles = ['开发导出功能', '整理使用文档', '移动端验收']
const request = '对照文档和验收结果，整理本次发布清单。'
const result = '导出、文档和移动端检查均已完成，可以进入发布检查。'
type PinnedState = { step: number; docs: boolean; qa: boolean; deleted: string[] }

const pluginShortcuts = [
  { label: '额度', icon: <Database size={20} /> },
  { label: '远程调试', icon: <Globe size={20} /> },
  { label: '用量', icon: <SquareChartGantt size={20} /> }
]
const backgroundSessions: DemoSession[] = [
  {
    id: 'notes',
    projectName: '文档站',
    cwd: '/projects/docs',
    title: '把安装和第一次对话的操作整理清楚。',
    counts: { user: 6, total: 44 },
    updated: '昨天'
  },
  {
    id: 'website',
    projectName: '官网',
    cwd: '/projects/website',
    title: '检查手机端的菜单、图片预览与底部入口。',
    counts: { user: 3, total: 27 },
    updated: '2 小时前'
  }
]
const primaryIds = ['dev', 'docs', 'qa', 'release']
type DeviceState = { step: number; primary: number; focus: number }

function advancePins(current: PinnedState, step: number): PinnedState {
  const next = { ...current, step }
  if (step === 0 || step === 10) return { step, docs: false, qa: false, deleted: [] }
  if (step === 1) next.docs = true
  if (step === 2) next.qa = true
  if (step === 8) next.qa = false
  if (step === 9) next.docs = false
  return next
}

function Conversation({
  index,
  release,
  step,
  elapsed
}: {
  index: number
  release?: boolean
  step: number
  elapsed: number
}): ReactElement {
  if (release)
    return (
      <>
        <UserMessage>这次发布先确认导出、文档和手机适配。</UserMessage>
        <AssistantMessage>
          <p>好的，等三个检查结果齐后整理发布清单。</p>
        </AssistantMessage>
        {step >= 4 && step <= 9 && <UserMessage>{request}</UserMessage>}
        {step === 4 && (
          <ProcessRow>
            <span className={styles.working} data-guide-target="pin-working">
              <LoaderCircle size={14} />
              正在整理发布清单
            </span>
          </ProcessRow>
        )}
        {step >= 5 && step <= 9 && (
          <AssistantMessage>
            <p data-guide-target="pin-result">
              {step === 5 ? result.slice(0, Math.floor(elapsed / 32) + 1) : result}
            </p>
            {(step > 5 || elapsed > 1200) && (
              <ul className={styles.checks}>
                <li>
                  <Check size={15} />
                  CSV 导出
                </li>
                <li>
                  <Check size={15} />
                  使用说明
                </li>
                <li>
                  <Check size={15} />
                  移动端验收
                </li>
              </ul>
            )}
          </AssistantMessage>
        )}
      </>
    )
  if (index === 1)
    return (
      <>
        <UserMessage>把导出操作写进使用说明。</UserMessage>
        <ProcessRow>处理过程 · 2 次工具调用</ProcessRow>
        <AssistantMessage>
          <p>使用说明已更新。</p>
          <ol className={styles.list}>
            <li>选择要导出的任务</li>
            <li>导出为 CSV 文件</li>
            <li>在表格软件中打开</li>
          </ol>
          <p className={styles.file}>README.md</p>
        </AssistantMessage>
      </>
    )
  if (index === 2)
    return (
      <>
        <UserMessage>检查手机上的任务列表和空状态。</UserMessage>
        <ProcessRow>
          {step < 5 ? (
            <span className={styles.working}>
              <LoaderCircle size={14} />
              正在检查手机布局
            </span>
          ) : (
            '处理过程 · 3 次工具调用'
          )}
        </ProcessRow>
        {step >= 5 && (
          <AssistantMessage>
            <p>移动端检查完成。</p>
            <ul className={styles.checks}>
              <li>
                <Check size={15} />
                列表无横向溢出
              </li>
              <li>
                <Check size={15} />
                空状态入口可见
              </li>
              <li>
                <Check size={15} />
                导出按钮可操作
              </li>
            </ul>
          </AssistantMessage>
        )}
      </>
    )
  return (
    <>
      <UserMessage>给任务列表增加 CSV 导出，包含已完成的任务。</UserMessage>
      <ProcessRow>处理过程 · 3 次工具调用</ProcessRow>
      <AssistantMessage>
        <p>导出功能已完成。</p>
        <p>
          文件名为 <code>qingzhou-tasks.csv</code>，包含任务名称、状态和完成时间。
        </p>
      </AssistantMessage>
    </>
  )
}

type DeviceProps = ShowcaseSceneProps & {
  elapsed: number
  pins: PinnedState
  onPin: (kind: 'docs' | 'qa') => void
  onDelete: (session: DemoSession) => void
  mobile?: boolean
  primaryDevice: boolean
}

function DeviceWorkbench({
  step,
  onStep,
  elapsed,
  pins,
  onPin,
  onDelete,
  mobile = false,
  primaryDevice
}: DeviceProps): ReactElement {
  const [device, setDevice] = useState<DeviceState>(() => ({
    step,
    primary: primaryDevice && step >= 3 && step < 10 ? 3 : 0,
    focus: step === 6 ? 1 : step === 7 ? 2 : 0
  }))
  let current = device
  const primaryBecameFixed =
    !mobile && ((device.primary === 1 && pins.docs) || (device.primary === 2 && pins.qa))
  if (
    device.step !== step ||
    pins.deleted.includes(primaryIds[device.primary]) ||
    primaryBecameFixed
  ) {
    current = { ...device, step }
    if (step === 0 || step === 10) current = { step, primary: 0, focus: 0 }
    if (step === 3 && primaryDevice) current = { step, primary: 3, focus: 0 }
    if (step === 6) current.focus = pins.docs ? 1 : 0
    if (step === 7) current.focus = pins.qa ? 2 : 0
    if (step === 8 || step === 9) current.focus = 0
    if (pins.deleted.includes(primaryIds[current.primary])) current.primary = -1
    if (!mobile && ((current.primary === 1 && pins.docs) || (current.primary === 2 && pins.qa))) {
      current.focus = current.primary
      current.primary = -1
    }
    setDevice(current)
  }
  const [drawer, setDrawer] = useState<{ step: number; open: boolean } | null>(null)
  const drawerOpen =
    drawer?.step === step
      ? drawer.open
      : primaryDevice && (step <= 2 || (step === 7 && elapsed >= 1400) || step === 8 || step === 9)
  const columnsRef = useRef<HTMLDivElement>(null)
  const gestureStart = useRef<number | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = columnsRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  function focusWindow(focus: number): void {
    if (current.focus === focus) return
    setDevice({ ...current, focus })
    onStep(step)
  }
  function selectPrimary(primary: number): void {
    setDevice({ ...current, primary, focus: 0 })
    setDrawer({ step, open: false })
    onStep(step)
  }
  const focusedSession =
    current.focus === 1 && pins.docs ? 1 : current.focus === 2 && pins.qa ? 2 : current.primary
  const [chatState, setChatState] = useDemoState(
    step,
    () => ({ drafts: {} as Record<string, string>, messages: {} as Record<string, string[]> }),
    (previous) => previous
  )
  function sendLocal(id: string, draft: string): void {
    setChatState((previous) => ({
      drafts: { ...previous.drafts, [id]: '' },
      messages: { ...previous.messages, [id]: [...(previous.messages[id] ?? []), draft] }
    }))
    onStep(step)
  }
  const sessions: DemoSession[] = [
    {
      id: 'dev',
      title: titles[0],
      active: focusedSession === 0,
      onSelect: () => selectPrimary(0),
      counts: { user: 1, total: 4 },
      updated: '1 小时前'
    },
    {
      id: 'release',
      title: '发布前检查',
      active: focusedSession === 3,
      onSelect: () => selectPrimary(3),
      counts: {
        user: step >= 4 && step <= 9 ? 2 : 1,
        total: step >= 5 && step <= 9 ? 6 : step >= 4 && step <= 9 ? 4 : 2
      },
      updated: step >= 4 && step <= 9 ? '刚刚' : '15 分钟前',
      running: step === 4
    },
    {
      id: 'docs',
      title: titles[1],
      pinned: pins.docs,
      active: focusedSession === 1,
      onPin: () => onPin('docs'),
      counts: { user: 1, total: 4 },
      updated: '8 分钟前',
      onSelect: () => {
        if (pins.docs && current.primary !== 1) focusWindow(1)
        else selectPrimary(1)
        setDrawer({ step, open: false })
      }
    },
    {
      id: 'qa',
      title: titles[2],
      pinned: pins.qa,
      active: focusedSession === 2,
      onPin: () => onPin('qa'),
      counts: { user: 1, total: step >= 5 ? 8 : 3 },
      updated: '刚刚',
      running: step >= 2 && step < 5,
      onSelect: () => {
        if (pins.qa && current.primary !== 2) focusWindow(2)
        else selectPrimary(2)
        setDrawer({ step, open: false })
      }
    }
  ]
  const allSessions = [...sessions, ...backgroundSessions]
    .filter((item) => !pins.deleted.includes(item.id))
    .map((item) => ({ ...item, onDelete: () => onDelete(item) }))
  const ordered = [
    ...allSessions.filter((item) => !item.pinned),
    ...allSessions.filter((item) => item.pinned)
  ]
  const active = [
    ...(current.primary >= 0 ? [0] : []),
    ...(pins.docs && !pins.deleted.includes('docs') && current.primary !== 1 ? [1] : []),
    ...(pins.qa && !pins.deleted.includes('qa') && current.primary !== 2 ? [2] : [])
  ]
  const focus = active.includes(current.focus) ? current.focus : (active[0] ?? -1)
  const page = active.indexOf(focus)
  const expandedCount = mobile
    ? active.length
    : Math.min(active.length, Math.max(1, Math.floor((width - active.length * 48) / 252)))
  const collapsed = new Set<number>()
  for (const index of [...active].reverse()) {
    if (collapsed.size < active.length - expandedCount && index !== focus) collapsed.add(index)
  }
  useDemoColumnMotion(columnsRef, `${active.join(',')}:${[...collapsed].join(',')}`, !mobile)
  const expandedWidth = expandedCount ? (width - collapsed.size * 48) / expandedCount : 0
  const showIndicator = mobile && (step === 6 || step === 7) && elapsed < 1100 && !drawerOpen
  const primaryTitle =
    current.primary === 3 ? '发布前检查' : (titles[current.primary] ?? '选择会话')

  return (
    <div
      className={mobile ? styles.mobileWorkbench : styles.desktopWorkbench}
      data-drawer={drawerOpen}
    >
      <Desk
        sessions={ordered}
        shortcuts={pluginShortcuts}
        mobile={mobile}
        animateSessions
        mobileSidebar={drawerOpen}
        onSessions={() => setDrawer({ step, open: !drawerOpen })}
        className={styles.desk}
      >
        {mobile && drawerOpen && (
          <button
            type="button"
            className={styles.drawerBackdrop}
            aria-label="收起会话列表"
            onClick={() => setDrawer({ step, open: false })}
          />
        )}
        <div
          ref={columnsRef}
          className={styles.columns}
          style={{ '--page': page } as CSSProperties}
          onPointerDown={(event) => {
            gestureStart.current = event.clientX
          }}
          onPointerUp={(event) => {
            if (
              mobile &&
              gestureStart.current !== null &&
              Math.abs(event.clientX - gestureStart.current) > 45
            ) {
              focusWindow(
                active[
                  Math.max(
                    0,
                    Math.min(
                      active.length - 1,
                      page + (event.clientX < gestureStart.current ? 1 : -1)
                    )
                  )
                ]
              )
            }
            gestureStart.current = null
          }}
          onPointerCancel={() => {
            gestureStart.current = null
          }}
        >
          {active.map((index) => {
            const title = index === 0 ? primaryTitle : titles[index]
            const chatId = primaryIds[index === 0 ? current.primary : index]
            const draft =
              chatState.drafts[chatId] ??
              (index === 0 && current.primary === 3 && step === 3
                ? request.slice(0, Math.floor(elapsed / 38))
                : '')
            return (
              <div
                key={index}
                data-demo-column={index}
                data-folded={collapsed.has(index)}
                className={styles.column}
                style={{ width: collapsed.has(index) ? 48 : width ? expandedWidth : '100%' }}
              >
                <button
                  type="button"
                  className={styles.foldedColumn}
                  aria-label={`展开${index === 0 ? '当前' : '固定'}会话 ${title}`}
                  onClick={() => focusWindow(index)}
                >
                  <span className={styles.railProject}>轻舟项目</span>
                  <span className={styles.railTitle}>{title}</span>
                </button>
                <Chat
                  key={chatId}
                  title={title}
                  fixed={index > 0}
                  focused={focus === index}
                  focusKey={index === 1 ? 'docs' : index === 2 ? 'qa' : 'primary'}
                  onFocus={() => focusWindow(index)}
                  onMenu={() => setDrawer({ step, open: true })}
                  className={styles.columnChat}
                  composer={
                    <Composer
                      draft={draft}
                      onDraftChange={(value) => {
                        setChatState((previous) => ({
                          ...previous,
                          drafts: { ...previous.drafts, [chatId]: value }
                        }))
                        onStep(step)
                      }}
                      onSend={
                        draft.trim()
                          ? () => {
                              if (
                                index === 0 &&
                                current.primary === 3 &&
                                step === 3 &&
                                draft === request
                              )
                                onStep(4)
                              else sendLocal(chatId, draft)
                            }
                          : undefined
                      }
                    />
                  }
                  badge={
                    index > 0 ? (
                      <IconButton
                        label={`取消固定会话 ${title}`}
                        onClick={() => onPin(index === 1 ? 'docs' : 'qa')}
                      >
                        <X size={14} />
                      </IconButton>
                    ) : undefined
                  }
                >
                  {/* 与工作台一样只让会话整体入场，不叠加每条消息的位移。 */}
                  <DemoActivity.Provider value={false}>
                    <Conversation
                      index={index === 0 ? current.primary : index}
                      release={index === 0 && current.primary === 3}
                      step={step}
                      elapsed={elapsed}
                    />
                    {chatState.messages[chatId]?.map((message, messageIndex) => (
                      <div key={messageIndex}>
                        <UserMessage>{message}</UserMessage>
                        <AssistantMessage>收到，接着这份会话继续处理。</AssistantMessage>
                      </div>
                    ))}
                  </DemoActivity.Provider>
                </Chat>
              </div>
            )
          })}
        </div>
        {mobile && active.length > 0 && (
          <>
            <div className={styles.mobileIndicator} data-visible={showIndicator} aria-hidden="true">
              <span>{focus === 0 ? '主会话' : '固定会话'}</span>
              <strong>{focus === 0 ? primaryTitle : titles[focus]}</strong>
              <span>
                {page + 1} / {active.length}
              </span>
              <div>
                <i
                  style={{
                    width: `${100 / active.length}%`,
                    transform: `translateX(${page * 100}%)`
                  }}
                />
              </div>
            </div>
            {(step === 5 || step === 6) && (
              <motion.div
                key={step}
                className={styles.swipe}
                aria-hidden="true"
                initial={{ x: 0, opacity: 0 }}
                animate={{ x: [0, 0, -110, -110], opacity: [0, 0.7, 0.7, 0] }}
                transition={{
                  delay: step === 5 ? 1.6 : 0.8,
                  duration: 0.7,
                  times: [0, 0.15, 0.85, 1]
                }}
              />
            )}
          </>
        )}
      </Desk>
    </div>
  )
}

export function PinScene({
  step,
  onStep,
  elapsed = 0
}: ShowcaseSceneProps & { elapsed?: number }): ReactElement {
  const [pins, setPins] = useState<PinnedState>(() => ({
    step,
    docs: step >= 1 && step < 9,
    qa: step >= 2 && step < 8,
    deleted: []
  }))
  const [deleting, setDeleting] = useState<DemoSession | null>(null)
  const current = pins.step === step ? pins : advancePins(pins, step)
  if (current !== pins) setPins(current)
  const sceneRef = useRef<HTMLDivElement>(null)
  const width = useDemoViewport(sceneRef)
  function togglePin(kind: 'docs' | 'qa'): void {
    setPins({ ...current, [kind]: !current[kind] })
    onStep(step)
  }
  const props = { step, onStep, elapsed, pins: current, onPin: togglePin, onDelete: setDeleting }
  return (
    <div ref={sceneRef} className={deviceStyles.frame}>
      <div className={deviceStyles.scene}>
        <DesktopWindow>
          <DemoDeviceContent visible={width === null || width >= 640}>
            {() => <DeviceWorkbench {...props} primaryDevice />}
          </DemoDeviceContent>
        </DesktopWindow>
        <div className={deviceStyles.mobile} aria-label="手机演示">
          <Phone>
            <DemoDeviceContent visible={width === null || width < 640 || width >= 960}>
              {() => (
                <DeviceWorkbench {...props} mobile primaryDevice={width === null || width < 640} />
              )}
            </DemoDeviceContent>
          </Phone>
        </div>
      </div>
      {deleting && (
        <Modal
          title="删除工作会话"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Action onClick={() => setDeleting(null)}>取消</Action>
              <Action
                onClick={() => {
                  setPins({
                    ...current,
                    docs: deleting.id === 'docs' ? false : current.docs,
                    qa: deleting.id === 'qa' ? false : current.qa,
                    deleted: [...current.deleted, deleting.id]
                  })
                  setDeleting(null)
                  onStep(step)
                }}
                primary
              >
                删除
              </Action>
            </>
          }
        >
          <p>从 Pi Desk 移除“{deleting.title}”？原始 Pi 会话文件不会被删除。</p>
        </Modal>
      )}
    </div>
  )
}
