'use client'

import { Copy, Eraser, Layers3 } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { useDemoState } from '../../hooks/l2-use-demo-state'
import type { ShowcaseSceneProps } from '../../l2-showcase-story'
import { DemoDevices } from '../l2-demo-devices'
import {
  Action,
  AssistantMessage,
  Chat,
  CodeView,
  Composer,
  Desk,
  ProcessRow,
  UserMessage
} from '../l2-demo-ui'
import styles from './l2-context-scene.module.css'

const followup = '接着加上日期筛选。'
type ContextState = {
  ignored: boolean
  panel: boolean
  expanded: boolean
  sent: string[]
  draft: string
}
function contextFrame(step: number): ContextState {
  return {
    ignored: step >= 2,
    panel: step === 1 || step === 2,
    expanded: step === 3,
    sent: step >= 4 ? [followup] : [],
    draft: step === 3 ? followup : ''
  }
}
const csv = [
  '项目,任务,状态',
  '轻舟,CSV 导出,已完成',
  '轻舟,移动端空状态,待处理',
  '轻舟,导出文件命名,已完成'
]
function ContextDevice({
  step,
  onStep,
  mobile
}: ShowcaseSceneProps & { mobile: boolean }): ReactElement {
  const [drawer, setDrawer] = useState(false)
  const [state, setState] = useDemoState(step, contextFrame, (previous, next) => ({
    ...contextFrame(next),
    ignored: previous.ignored || next >= 2,
    sent: previous.sent.length ? previous.sent : next >= 4 ? [previous.draft || followup] : []
  }))
  const { ignored, panel, expanded, sent, draft } = state
  function patch(value: Partial<typeof state>): void {
    setState((previous) => ({ ...previous, ...value }))
    onStep(step)
  }
  return (
    <Desk
      className={styles.desk}
      mobile={mobile}
      mobileSidebar={drawer}
      sessions={[
        {
          id: 'context',
          title: '开发导出功能',
          active: true,
          counts: { user: 1 + sent.length, total: 6 + sent.length * 2 },
          updated: '刚刚',
          onSelect: () => setDrawer(false)
        }
      ]}
    >
      <Chat
        title="开发导出功能"
        focused
        autoScroll={sent.length > 0}
        scrollKey={sent.length}
        onMenu={() => setDrawer(true)}
        composer={
          <Composer
            context={ignored ? '36%' : '74%'}
            draft={draft}
            onDraftChange={(value) => patch({ draft: value })}
            onSend={
              draft.trim()
                ? () => patch({ sent: [...sent, draft], draft: '', panel: false })
                : undefined
            }
            onContext={() => patch({ panel: !panel })}
            panel={
              panel ? (
                <section className={styles.contextPanel} aria-label="上下文用量详情">
                  <div className={styles.current} data-guide-target="context-current">
                    <span>
                      {ignored && !sent.length
                        ? '当前预计占用 / 上限 / 百分比'
                        : '当前占用 / 上限 / 百分比'}
                    </span>
                    <strong>
                      {ignored ? '72K' : '148K'} / 200K / {ignored ? '36%' : '74%'}
                    </strong>
                  </div>
                  <div className={styles.track}>
                    <i style={{ width: '36%' }} />
                    {!ignored && <span style={{ width: '38%' }} />}
                  </div>
                  <dl>
                    <div>
                      <dt>
                        <i />
                        忽略后预计保留
                      </dt>
                      <dd>72K · 36%</dd>
                    </div>
                    <div>
                      <dt>
                        <span />
                        可忽略
                      </dt>
                      <dd>{ignored ? '0' : '76K'}</dd>
                    </div>
                    <div>
                      <dt>已忽略</dt>
                      <dd>{ignored ? '88K' : '12K'}</dd>
                    </div>
                  </dl>
                  <div className={styles.panelActions}>
                    <Action
                      label={ignored ? '没有可忽略的上下文' : '立即忽略 76K 示例上下文'}
                      disabled={ignored}
                      onClick={!ignored ? () => patch({ ignored: true }) : undefined}
                    >
                      <Eraser size={16} />
                      忽略
                    </Action>
                    <Action disabled label="压缩上下文">
                      <Layers3 size={16} />
                      压缩
                    </Action>
                  </div>
                  <div className={styles.identity}>
                    <div>
                      <span>Session ID</span>
                      <code>demo-session-01</code>
                      <Copy size={14} />
                    </div>
                    <div>
                      <span>项目目录</span>
                      <code>/projects/qingzhou</code>
                      <Copy size={14} />
                    </div>
                  </div>
                </section>
              ) : undefined
            }
          />
        }
      >
        <UserMessage>给任务列表增加 CSV 导出，包含已完成任务，文件名加上项目名称。</UserMessage>
        <ProcessRow onClick={() => patch({ expanded: !expanded })} expanded={expanded}>
          <span data-guide-target="context-history">早期处理过程 · read · qingzhou-tasks.csv</span>
        </ProcessRow>
        {expanded && (
          <section className={styles.history} aria-label="早期 read 的原始工具结果">
            <header>read · qingzhou-tasks.csv</header>
            <CodeView lines={csv} />
          </section>
        )}
        <AssistantMessage>
          <p>导出功能已完成，包含已完成任务，文件名为 qingzhou-tasks.csv。</p>
        </AssistantMessage>
        {sent.map((message, index) => (
          <div key={index}>
            <UserMessage>{message}</UserMessage>
            <AssistantMessage>
              <p data-guide-target={index === sent.length - 1 ? 'context-next' : undefined}>
                {message === followup
                  ? '加上日期筛选，仍然包含已完成任务，文件名继续用 qingzhou-tasks.csv。'
                  : '收到，沿用前面的导出范围和项目文件名，继续处理这条要求。'}
              </p>
            </AssistantMessage>
          </div>
        ))}
      </Chat>
    </Desk>
  )
}
export function ContextScene(props: ShowcaseSceneProps): ReactElement {
  return <DemoDevices>{(mobile) => <ContextDevice {...props} mobile={mobile} />}</DemoDevices>
}
