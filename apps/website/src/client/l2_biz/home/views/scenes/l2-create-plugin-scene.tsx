'use client'

import {
  Check,
  ChevronDown,
  ClipboardCheck,
  FileText,
  GitBranch,
  ListTodo,
  LoaderCircle,
  RefreshCw
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
  CheckRow,
  CodeView,
  Composer,
  Desk,
  Menu,
  MenuItem,
  Modal,
  ProcessRow,
  Settings,
  UserMessage
} from '../l2-demo-ui'
import styles from './l2-create-plugin-scene.module.css'

const request =
  '做一个「交付清单」插件：独立清单、默认项设置、当前轮检查选项，检查结果显示在聊天里。'
const items = ['代码检查', '文档更新', '测试验证']

function PluginDevice({
  step,
  elapsed = 0,
  onStep,
  mobile,
  defaults,
  results,
  onSave,
  onRun
}: ShowcaseSceneProps & {
  mobile: boolean
  defaults: string[]
  results: string[] | null
  onSave: (items: string[]) => void
  onRun: (items: string[]) => void
}): ReactElement {
  const reduced = useReducedMotion()
  const [view, setView] = useDemoState(
    step,
    (next) => ({
      page: next === 5 ? 'application' : next === 7 ? 'settings' : next === 9 ? 'panel' : '',
      drawer: mobile && (next === 4 || next === 6),
      menu: next === 8
    }),
    (_, next) => ({
      page: next === 5 ? 'application' : next === 7 ? 'settings' : next === 9 ? 'panel' : '',
      drawer: mobile && (next === 4 || next === 6),
      menu: next === 8
    })
  )
  function open(page: string): void {
    setChecks(defaults)
    setView((previous) => ({ ...previous, page, menu: false, drawer: false }))
    onStep(step)
  }
  function setDrawer(drawer: boolean): void {
    setView((previous) => ({ ...previous, drawer }))
    onStep(step)
  }
  const { drawer, menu } = view
  const [commandDetail, setCommandDetail] = useState<'install' | 'reload' | null>(null)
  const [checks, setChecks] = useState(defaults)
  const [detail, setDetail] = useState(false)
  const loaded = step >= 4
  function toggle(item: string): void {
    setChecks((current) =>
      current.includes(item) ? current.filter((value) => value !== item) : [...current, item]
    )
    onStep(step)
  }
  const more = (
    <Menu title="更多操作">
      <p className={styles.menuLabel}>会话</p>
      <span className={styles.menuReference}>
        <GitBranch size={16} />
        会话分支
      </span>
      <p className={styles.menuLabel}>工具</p>
      <span className={styles.menuReference}>
        <ListTodo size={16} />
        任务中心
      </span>
      <MenuItem
        icon={<RefreshCw size={16} />}
        onClick={() => {
          setCommandDetail('reload')
          open('')
        }}
      >
        重载 Pi 配置
      </MenuItem>
      {loaded && (
        <>
          <p className={styles.menuLabel}>插件</p>
          <MenuItem icon={<ClipboardCheck size={16} />} onClick={() => open('panel')}>
            本轮检查
          </MenuItem>
        </>
      )}
    </Menu>
  )
  return (
    <Desk
      className={styles.desk}
      mobile={mobile}
      mobileSidebar={drawer}
      onSettings={loaded ? () => open('settings') : undefined}
      sessions={[
        {
          id: 'plugin',
          title: '制作交付清单',
          active: true,
          counts: {
            user: step === 0 ? 0 : 1,
            total: step === 0 ? 0 : results ? 8 : step >= 2 ? 6 : 2
          },
          updated: step === 0 ? '--' : '刚刚',
          onSelect: () => setDrawer(false)
        }
      ]}
      shortcuts={
        loaded
          ? [
              {
                label: '交付清单',
                icon: <FileText size={20} />,
                onClick: () => open('application')
              }
            ]
          : []
      }
    >
      <Chat
        title="制作交付清单"
        focused
        autoScroll={step === 2 || step === 3 || Boolean(results)}
        scrollKey={`${step}:${results?.length ?? 0}`}
        empty={step === 0}
        onMenu={() => setDrawer(true)}
        composer={
          <Composer
            draft={
              step === 0
                ? reduced
                  ? request
                  : request.slice(0, Math.floor((elapsed / 1000) * request.length))
                : ''
            }
            onSend={step === 0 && (reduced || elapsed >= 1000) ? () => onStep(1) : undefined}
            onMore={
              loaded
                ? () => {
                    setView((previous) => ({ ...previous, menu: !menu }))
                    onStep(step)
                  }
                : undefined
            }
            panel={menu ? more : undefined}
          />
        }
      >
        {step > 0 && <UserMessage>{request}</UserMessage>}
        {step === 1 && (
          <ProcessRow>
            <span className={styles.working} data-guide-target="plugin-working">
              <LoaderCircle size={14} />
              正在生成并构建示例插件
            </span>
          </ProcessRow>
        )}
        {step >= 2 && (
          <>
            <ProcessRow>处理过程 · 生成代码与构建</ProcessRow>
            <div data-guide-target="plugin-install">
              <ProcessRow
                expanded={commandDetail === 'install'}
                onClick={() => setCommandDetail(commandDetail === 'install' ? null : 'install')}
              >
                pidesk · {step === 2 ? '正在安装并加载交付清单' : '交付清单已安装'}
              </ProcessRow>
              {commandDetail === 'install' && (
                <CodeView
                  lines={[
                    '{ "args": ["plugins", "install", "delivery-list", "--scope", "global"] }'
                  ]}
                />
              )}
            </div>
            {step >= 3 && (
              <div data-guide-target="plugin-reload">
                <ProcessRow
                  expanded={commandDetail === 'reload'}
                  onClick={() => setCommandDetail(commandDetail === 'reload' ? null : 'reload')}
                >
                  pidesk · {step === 3 ? '等待当前会话空闲后重载配置' : '当前会话配置已重载'}
                </ProcessRow>
                {commandDetail === 'reload' && (
                  <CodeView lines={['{ "args": ["session", "reload"] }']} />
                )}
              </div>
            )}
            <AssistantMessage>
              <p>
                {step === 2
                  ? '本地插件已构建，正在通过 pidesk 工具安装并加载。'
                  : step === 3
                    ? '安装已完成，已提交当前会话重载。完成通知到达后，就可以使用新增工具。'
                    : '交付清单的工具、应用和设置已就绪。可以从左下角打开清单。'}
              </p>
            </AssistantMessage>
          </>
        )}
        {results && (
          <>
            <UserMessage>检查本次{results.join('、')}。</UserMessage>
            <div className={styles.checkMessage}>
              <button
                type="button"
                aria-label="展开交付检查结果"
                onClick={() => {
                  setDetail(!detail)
                  onStep(step)
                }}
              >
                <Check size={16} />
                <span>交付检查 · {results.length} 项通过</span>
                <ChevronDown size={16} />
              </button>
              {detail && (
                <div>
                  {results.map((item) => (
                    <p key={item}>{item}：示例检查通过。</p>
                  ))}
                </div>
              )}
            </div>
            <AssistantMessage>
              <p>检查已完成。清单、输入选项和聊天结果都可以继续按你的使用习惯调整。</p>
            </AssistantMessage>
          </>
        )}
      </Chat>
      {view.page === 'application' && (
        <Modal title="交付清单" icon={<FileText size={20} />} onClose={() => open('')}>
          <div className={styles.application}>
            <div>
              <h3>本次交付</h3>
              <span>3 项检查</span>
            </div>
            {items.map((item) => (
              <div key={item} className={styles.applicationRow}>
                <ClipboardCheck size={16} />
                <span>{item}</span>
                <small>{results?.includes(item) ? '已通过' : '待检查'}</small>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {view.page === 'settings' && (
        <Settings title="交付清单" onClose={() => open('')}>
          <div className={styles.settingsForm}>
            <h3>默认检查项</h3>
            {items.map((item) => (
              <CheckRow key={item} checked={checks.includes(item)} onClick={() => toggle(item)}>
                {item}
              </CheckRow>
            ))}
            <Action
              primary
              onClick={() => {
                onSave(checks)
                open('')
              }}
            >
              保存默认项
            </Action>
          </div>
        </Settings>
      )}
      {view.page === 'panel' && (
        <Modal title="本轮检查" icon={<ClipboardCheck size={20} />} panel onClose={() => open('')}>
          <div className={styles.panel}>
            <h3>本轮检查</h3>
            {items.map((item) => (
              <CheckRow key={item} checked={checks.includes(item)} onClick={() => toggle(item)}>
                {item}
              </CheckRow>
            ))}
            <div className={styles.panelFooter}>
              <span>已选 {checks.length} 项</span>
              <Action
                primary
                disabled={!checks.length}
                onClick={() => {
                  onRun(checks)
                  open('')
                }}
              >
                开始检查
              </Action>
            </div>
          </div>
        </Modal>
      )}
    </Desk>
  )
}

export function CreatePluginScene(props: ShowcaseSceneProps): ReactElement {
  const [defaults, setDefaults] = useState(['代码检查', '文档更新'])
  const [results, setResults] = useState<string[] | null>(props.step === 10 ? defaults : null)
  const [phase, setPhase] = useState(props.step)
  if (phase !== props.step) {
    setPhase(props.step)
    if (props.step === 0) {
      setDefaults(['代码检查', '文档更新'])
      setResults(null)
    } else if (props.step === 10 && !results) setResults(defaults)
  }
  return (
    <DemoDevices>
      {(mobile) => (
        <PluginDevice
          {...props}
          mobile={mobile}
          defaults={defaults}
          results={results}
          onSave={(items) => {
            setDefaults(items)
            props.onStep(props.step)
          }}
          onRun={(items) => {
            setResults(items)
            props.onStep(props.step)
          }}
        />
      )}
    </DemoDevices>
  )
}
