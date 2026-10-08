'use client'

import { Database, LoaderCircle, PanelTop } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useState, type ReactElement } from 'react'
import type { ShowcaseSceneProps } from '../../l2-showcase-story'
import { useDemoState } from '../../hooks/l2-use-demo-state'
import { DemoDevices } from '../l2-demo-devices'
import { DemoPluginManagement } from '../l2-demo-plugin-management'
import {
  Action,
  AssistantMessage,
  Chat,
  Composer,
  Desk,
  Menu,
  MenuItem,
  Modal,
  ProcessRow,
  Settings,
  UserMessage
} from '../l2-demo-ui'
import { InstallSessionAnalysis, InstallUsageView } from './l2-install-usage-view'
import styles from './l2-install-scene.module.css'

const request = '安装额度查看器和模型用量插件，查看套餐剩余额度，以及已有会话的模型用量。'
const plugins = [
  {
    name: '@jetcrab/pi-desk-quota-viewer',
    description: '查询额度来源与套餐剩余额度。',
    capabilities: ['独立应用 · 额度', '设置页 · 额度设置']
  },
  {
    name: '@jetcrab/pi-desk-usage',
    description: '查看Pi会话记录中的模型使用量。',
    capabilities: ['独立应用 · 用量', '输入辅助 · 会话分析']
  }
]
const quota = [
  { label: '5 小时额度', value: 76, reset: '2 小时 10 分后重置' },
  { label: '周额度', value: 62, reset: '3 天 5 小时后重置' },
  { label: '月额度', value: 85, reset: '12 天 8 小时后重置' }
]
type Source = { name: string; apiKey: string; enabled: boolean }
const exampleSource: Source = {
  name: '轻舟 · 示例账户',
  apiKey: 'demo-not-a-secret',
  enabled: true
}
type InstallState = {
  page: string
  drawer: boolean
  menu: boolean
  source: Source | null
  draft: Source | null
  hidden: string[]
  detail: boolean
  format: string
  draftFormat: string
}
function installFrame(step: number): InstallState {
  return {
    page:
      step === 3
        ? 'management'
        : step === 4
          ? 'settings'
          : step === 6 || step === 7
            ? 'quota'
            : step === 9 || step === 10
              ? 'usage'
              : step === 12
                ? 'analysis'
                : '',
    drawer: step === 2 || step === 5 || step === 8,
    menu: step === 11,
    source: step >= 5 ? exampleSource : null,
    draft: step >= 4 ? exampleSource : null,
    hidden: [],
    detail: step === 7,
    format: '倒计时',
    draftFormat: '倒计时'
  }
}
function advanceInstall(previous: InstallState, step: number): InstallState {
  const next = installFrame(step)
  return {
    ...previous,
    page: next.page,
    drawer: next.drawer,
    menu: next.menu,
    detail: next.detail,
    draft: step === 4 ? (previous.source ?? exampleSource) : previous.draft,
    source:
      step === 5 &&
      previous.page === 'settings' &&
      previous.draft?.name.trim() &&
      previous.draft.apiKey.trim()
        ? previous.draft
        : previous.source
  }
}
function QuotaView({
  source,
  hidden,
  onHidden,
  expanded,
  onDetail,
  onClose,
  onInteract,
  format
}: {
  source: Source | null
  hidden: string[]
  onHidden: (items: string[]) => void
  expanded: boolean
  onDetail: () => void
  onClose: () => void
  onInteract: () => void
  format: string
}): ReactElement {
  const [display, setDisplay] = useState(false)
  const [query, setQuery] = useState('')
  const [refreshed, setRefreshed] = useState(false)
  const [draftHidden, setDraftHidden] = useState(hidden)
  const visible = quota.filter((item) => !hidden.includes(item.label))
  const record = source?.enabled && `${source.name} OpenCode Go`.includes(query)
  if (display)
    return (
      <Modal title="显示项" onClose={() => setDisplay(false)}>
        <div className={styles.displayItems}>
          <strong>OpenCode Go</strong>
          {quota.map((item) => (
            <label key={item.label}>
              <input
                type="checkbox"
                checked={!draftHidden.includes(item.label)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked
                  setDraftHidden((current) =>
                    checked
                      ? current.filter((label) => label !== item.label)
                      : [...current, item.label]
                  )
                }}
              />
              {item.label}
            </label>
          ))}
          <Action
            onClick={() => {
              onHidden(draftHidden)
              setDisplay(false)
            }}
          >
            完成
          </Action>
        </div>
      </Modal>
    )
  return (
    <Modal title="额度查看器" icon={<Database size={20} />} wide intrinsic onClose={onClose}>
      <div className={styles.quota}>
        <div className={styles.toolbar}>
          <input
            aria-label="搜索额度记录"
            placeholder="搜索渠道、来源或账号"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Action
            onClick={() => {
              setDraftHidden(hidden)
              setDisplay(true)
              onInteract()
            }}
          >
            显示项
          </Action>
          <Action
            onClick={() => {
              setRefreshed(true)
              onInteract()
            }}
          >
            刷新
          </Action>
        </div>
        {record ? (
          <>
            <h3 className={styles.channelHeading}>OpenCode Go</h3>
            <section className={styles.quotaRecord}>
              <div className={styles.quotaSummary}>
                <div className={styles.recordIdentity}>
                  <strong>{source.name}</strong>
                </div>
                <div className={styles.quotaMetrics}>
                  {visible.map((item) => (
                    <div key={item.label}>
                      <span>{item.label} · 剩余</span>
                      <div>
                        <small>
                          {format === '倒计时'
                            ? item.reset
                            : ['今天 12:34 重置', '10月4日 15:24 重置', '10月13日 18:24 重置'][
                                quota.indexOf(item)
                              ]}
                        </small>
                        <strong>{item.value}%</strong>
                      </div>
                      <div
                        className={styles.quotaProgress}
                        role="progressbar"
                        aria-label={`${item.label}剩余额度`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={item.value}
                      >
                        <i style={{ width: `${item.value}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
                <Action label="查看示例账户额度详情" onClick={onDetail}>
                  {expanded ? '收起' : '详情'}
                </Action>
              </div>
              {expanded && (
                <div className={styles.quotaDetails}>
                  <strong>{source.name}</strong>
                  <p>来源：{source.name} · 官方产品接口</p>
                  <p>{refreshed ? '示例数据刚刚刷新' : '数据更新于今天 10:24'}</p>
                  {visible.map((item) => (
                    <div key={item.label}>
                      <strong>{item.label}</strong>
                      <span>
                        剩余 {item.value}% · 已用 {100 - item.value}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : (
          <p>{source ? '没有匹配的已启用来源' : '尚未配置额度来源，请在设置中添加并保存。'}</p>
        )}
        <div className={styles.pagination}>
          共 {record ? 1 : 0} 条记录<span>{record ? '1 / 1' : '0 / 0'}</span>
        </div>
      </div>
    </Modal>
  )
}
function InstallDevice({
  step,
  elapsed = 0,
  onStep,
  mobile
}: ShowcaseSceneProps & { mobile: boolean }): ReactElement {
  const reduced = useReducedMotion()
  const [state, setState] = useDemoState(step, installFrame, advanceInstall)
  const [settingsTab, setSettingsTab] = useState('额度来源')
  const loaded = step >= 2
  const dirty =
    JSON.stringify(state.source) !== JSON.stringify(state.draft) ||
    state.format !== state.draftFormat
  function patch(value: Partial<InstallState>): void {
    setState((previous) => ({ ...previous, ...value }))
    onStep(step)
  }
  function open(page: string): void {
    patch({
      page,
      drawer: false,
      menu: false,
      ...(page === 'settings' ? { draft: state.source, draftFormat: state.format } : {})
    })
  }
  function updateSource(value: Partial<Source>): void {
    patch({ draft: { ...(state.draft ?? { name: '', apiKey: '', enabled: true }), ...value } })
  }
  return (
    <Desk
      className={styles.desk}
      mobile={mobile}
      mobileSidebar={mobile && state.drawer}
      onSettings={() => open('management')}
      sessions={[
        {
          id: 'install',
          title: '安装额度与用量插件',
          active: true,
          counts: { user: step === 0 ? 0 : 1, total: step === 0 ? 0 : loaded ? 5 : 2 },
          updated: step === 0 ? '--' : '刚刚',
          onSelect: () => patch({ drawer: false })
        }
      ]}
      shortcuts={
        loaded
          ? [
              { label: '额度', icon: <Database size={20} />, onClick: () => open('quota') },
              { label: '用量', icon: <PanelTop size={20} />, onClick: () => open('usage') }
            ]
          : []
      }
    >
      <Chat
        title="安装额度与用量插件"
        focused
        empty={step === 0}
        onMenu={() => patch({ drawer: true })}
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
            onMore={loaded ? () => patch({ menu: !state.menu }) : undefined}
            panel={
              state.menu ? (
                <Menu title="插件">
                  <MenuItem icon={<Database size={16} />} onClick={() => open('analysis')}>
                    会话分析
                  </MenuItem>
                </Menu>
              ) : undefined
            }
          />
        }
      >
        {step > 0 && <UserMessage>{request}</UserMessage>}
        {step === 1 && (
          <ProcessRow>
            <span className={styles.working} data-guide-target="install-working">
              <LoaderCircle size={14} />
              正在安装并加载插件
            </span>
          </ProcessRow>
        )}
        {loaded && (
          <>
            <ProcessRow>处理过程 · 软件包安装与界面加载</ProcessRow>
            <AssistantMessage>
              <p>额度和用量入口已加载。额度先配置来源，模型用量可以直接读取已有会话记录。</p>
            </AssistantMessage>
          </>
        )}
      </Chat>
      {state.page === 'management' && (
        <DemoPluginManagement
          plugins={loaded ? plugins : []}
          onReload={() => onStep(step)}
          onSettings={() => open('settings')}
          onClose={() => open('')}
        />
      )}
      {state.page === 'settings' && loaded && (
        <Settings
          title="额度设置"
          onClose={() => open('')}
          onPlugins={() => open('management')}
          footer={
            <>
              <span>{dirty ? '有未保存更改' : '更改已保存'}</span>
              <Action
                primary
                disabled={
                  !dirty ||
                  Boolean(state.draft && (!state.draft.name.trim() || !state.draft.apiKey.trim()))
                }
                onClick={() => {
                  patch({ source: state.draft, format: state.draftFormat })
                }}
              >
                保存全部更改
              </Action>
            </>
          }
        >
          <div className={styles.settingsToolbar}>
            <div className={styles.rangeTabs}>
              {['额度来源', '显示设置'].map((value) => (
                <Action
                  key={value}
                  active={settingsTab === value}
                  onClick={() => setSettingsTab(value)}
                >
                  {value}
                </Action>
              ))}
            </div>
            <Action onClick={() => patch({ draft: state.source, draftFormat: state.format })}>
              重新加载
            </Action>
            <Action
              disabled={Boolean(state.draft)}
              onClick={() => patch({ draft: { name: '', apiKey: '', enabled: true } })}
            >
              添加来源
            </Action>
          </div>
          {settingsTab === '显示设置' ? (
            <label className={styles.resetFormat}>
              重置时间格式
              <select
                value={state.draftFormat}
                onChange={(event) => patch({ draftFormat: event.currentTarget.value })}
              >
                <option>倒计时</option>
                <option>具体时间</option>
              </select>
            </label>
          ) : state.draft ? (
            <div className={styles.sourceEditor}>
              <aside>
                <small>OpenCode Go</small>
                <strong>{state.draft.name || '新来源'}</strong>
                <span>{dirty ? '未保存' : '已保存'}</span>
              </aside>
              <div className={styles.sourceForm}>
                <h3>{state.draft.name || '新来源'}</h3>
                <p>OpenCode Go</p>
                <label>
                  显示名称
                  <input
                    value={state.draft.name}
                    onChange={(event) => updateSource({ name: event.currentTarget.value })}
                  />
                </label>
                <label className={styles.enabled}>
                  <input
                    type="checkbox"
                    checked={state.draft.enabled}
                    onChange={(event) => updateSource({ enabled: event.currentTarget.checked })}
                  />
                  启用来源
                </label>
                <label>
                  API Key
                  <input
                    type="password"
                    value={state.draft.apiKey}
                    onChange={(event) => updateSource({ apiKey: event.currentTarget.value })}
                    autoComplete="off"
                  />
                </label>
              </div>
            </div>
          ) : (
            <p>添加来源后填写名称和 API Key。</p>
          )}
        </Settings>
      )}
      {state.page === 'quota' && (
        <QuotaView
          source={state.source}
          format={state.format}
          hidden={state.hidden}
          onHidden={(hidden) => patch({ hidden })}
          expanded={state.detail}
          onDetail={() => patch({ detail: !state.detail })}
          onClose={() => open('')}
          onInteract={() => onStep(step)}
        />
      )}
      {state.page === 'usage' && (
        <InstallUsageView expandedInitially={step === 10} onClose={() => open('')} />
      )}
      {state.page === 'analysis' && <InstallSessionAnalysis onClose={() => open('')} />}
    </Desk>
  )
}
export function InstallScene(props: ShowcaseSceneProps): ReactElement {
  return <DemoDevices>{(mobile) => <InstallDevice {...props} mobile={mobile} />}</DemoDevices>
}
