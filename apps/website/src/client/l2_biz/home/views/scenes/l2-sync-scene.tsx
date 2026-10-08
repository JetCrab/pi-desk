'use client'

import { LoaderCircle } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { ShowcaseSceneProps } from '../../l2-showcase-story'
import { DemoDevices } from '../l2-demo-devices'
import { AssistantMessage, Chat, Composer, Desk, ProcessRow, UserMessage } from '../l2-demo-ui'
import styles from './l2-sync-scene.module.css'

const request = '给轻舟项目加上任务导出，已完成的任务也要包含在内。'
const followup = '再补一下手机上的空状态，没有任务时显示「还没有任务」。'

function SyncDevice({
  step,
  elapsed = 0,
  onStep,
  mobile
}: ShowcaseSceneProps & { mobile: boolean }): ReactElement {
  const reduced = useReducedMotion()
  const [drawer, setDrawer] = useState<{ step: number; open: boolean } | null>(null)
  const draft = (!mobile && step === 0) || (mobile && step === 3)
  const text = step === 0 ? request : followup
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const viewport = content.current?.parentElement
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [step])
  return (
    <Desk
      mobile={mobile}
      mobileSidebar={drawer?.step === step && drawer.open}
      sessions={[
        {
          id: 'development',
          title: '开发导出功能',
          active: true,
          counts: {
            user: step === 0 ? 0 : step >= 4 ? 2 : 1,
            total: step === 0 ? 0 : step >= 5 ? 6 : step >= 4 ? 4 : step >= 2 ? 3 : 1
          },
          updated: step === 0 ? '--' : '刚刚',
          running: step === 1 || step === 4,
          onSelect: () => setDrawer({ step, open: false })
        },
        {
          id: 'documentation',
          title: '整理使用文档',
          counts: { user: 1, total: 4 },
          updated: '8 分钟前'
        }
      ]}
      className={styles.desk}
    >
      <Chat
        title="开发导出功能"
        empty={step === 0}
        focused
        focusKey={mobile ? 'sync-mobile' : 'sync-desktop'}
        onMenu={() => setDrawer({ step, open: true })}
        composer={
          <Composer
            draft={
              draft
                ? reduced
                  ? text
                  : text.slice(0, Math.floor((elapsed / 900) * text.length))
                : ''
            }
            onSend={
              draft && (reduced || elapsed >= 900) ? () => onStep(step === 0 ? 1 : 4) : undefined
            }
          />
        }
      >
        <div ref={content}>
          {step > 0 && <UserMessage time="10:24">{request}</UserMessage>}
          {step >= 2 && (
            <AssistantMessage>
              <p data-guide-target="sync-reply">
                导出功能已完成，包含已完成任务。文件名为 qingzhou-tasks.csv。
              </p>
            </AssistantMessage>
          )}
          {step >= 4 && <UserMessage time="10:26">{followup}</UserMessage>}
          {step === 5 && (
            <AssistantMessage>
              <p data-guide-target="sync-followup">
                手机空状态已补齐，没有任务时显示「还没有任务」。导出功能保持不变。
              </p>
            </AssistantMessage>
          )}
          {(step === 1 || step === 4) && (
            <ProcessRow>
              <span className={styles.working} data-guide-target="sync-working">
                <LoaderCircle size={14} />
                正在处理这条要求
              </span>
            </ProcessRow>
          )}
        </div>
      </Chat>
    </Desk>
  )
}

export function SyncScene(props: ShowcaseSceneProps): ReactElement {
  return <DemoDevices>{(mobile) => <SyncDevice {...props} mobile={mobile} />}</DemoDevices>
}
