'use client'

import { GitBranch, Search, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { ShowcaseSceneProps } from '../../l2-showcase-story'
import { useDemoState } from '../../hooks/l2-use-demo-state'
import { DemoDevices } from '../l2-demo-devices'
import {
  Action,
  AssistantMessage,
  Chat,
  Composer,
  Desk,
  IconButton,
  Menu,
  MenuItem,
  ProcessRow,
  UserMessage
} from '../l2-demo-ui'
import {
  branchEntries,
  branchPath,
  selectBranchEntry,
  originalBranchRequest,
  revisedBranchRequest,
  type BranchConversation,
  type BranchEntryId
} from './l2-branch-demo-state'
import styles from './l2-branches-scene.module.css'

type BranchState = {
  source: BranchConversation
  forks: BranchConversation[]
  active: number
  selected: BranchEntryId
  picker: boolean
  menu: boolean
}
function branchFrame(step: number): BranchState {
  const fork = selectBranchEntry('full-request')
  if (step >= 6) fork.draft = revisedBranchRequest
  if (step >= 7) {
    fork.sent = [fork.draft]
    fork.draft = ''
  }
  return {
    source: selectBranchEntry(step >= 3 ? 'open-only' : 'complete'),
    forks: step >= 5 ? [fork] : [],
    active: step >= 5 ? 0 : -1,
    selected: step === 4 ? 'full-request' : 'open-only',
    picker: step === 2 || step === 4,
    menu: step === 1
  }
}
function advanceBranch(previous: BranchState, step: number): BranchState {
  const state = { ...previous, menu: step === 1, picker: step === 2 || step === 4 }
  if (step === 3) state.source = selectBranchEntry(state.selected)
  if (step === 4) state.selected = 'full-request'
  if (step === 5 && !state.forks.length) {
    state.forks = [selectBranchEntry('full-request')]
    state.active = 0
  }
  if (step === 6)
    state.forks = state.forks.map((fork, index) =>
      index === state.active && fork.draft === originalBranchRequest
        ? { ...fork, draft: revisedBranchRequest }
        : fork
    )
  if (step === 7)
    state.forks = state.forks.map((fork, index) =>
      index === state.active && fork.draft.trim()
        ? { ...fork, sent: [...fork.sent, fork.draft], draft: '' }
        : fork
    )
  return state
}
function BranchDevice({
  step,
  onStep,
  mobile
}: ShowcaseSceneProps & { mobile: boolean }): ReactElement {
  const [state, setState] = useDemoState(step, branchFrame, advanceBranch)
  const [drawer, setDrawer] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('默认')
  const treeRef = useRef<HTMLDivElement>(null)
  const conversation = state.active < 0 ? state.source : state.forks[state.active]
  const forked = state.active >= 0
  const title = forked ? `新会话${state.active ? ` ${state.active + 1}` : ''}` : '开发导出功能'
  const rows = branchEntries.filter(
    (entry) =>
      (filter !== '只看用户' || entry.kind === '用户') &&
      (filter !== '不含工具' || entry.kind !== '工具') &&
      `${entry.kind} ${entry.text}`.includes(query)
  )
  const selected = rows.find((entry) => entry.id === state.selected) ?? rows[0]
  function patch(value: Partial<BranchState>): void {
    setState((previous) => ({ ...previous, ...value }))
    onStep(step)
  }
  function updateConversation(value: Partial<BranchConversation>): void {
    setState((previous) =>
      previous.active < 0
        ? { ...previous, source: { ...previous.source, ...value } }
        : {
            ...previous,
            forks: previous.forks.map((fork, index) =>
              index === previous.active ? { ...fork, ...value } : fork
            )
          }
    )
    onStep(step)
  }
  function switchEntry(id: BranchEntryId): void {
    if (state.active === -1 && state.source.leaf === id && state.source.sent.length === 0) {
      patch({ picker: false, menu: false })
      return
    }
    patch({ source: selectBranchEntry(id), active: -1, picker: false, menu: false })
  }
  function forkEntry(id: BranchEntryId): void {
    patch({
      forks: [...state.forks, selectBranchEntry(id)],
      active: state.forks.length,
      picker: false,
      menu: false
    })
    setDrawer(false)
  }
  function selectSession(active: number): void {
    patch({ active, picker: false, menu: false })
    setDrawer(false)
  }
  useEffect(() => {
    const viewport = treeRef.current,
      row = viewport?.querySelector<HTMLElement>(`[data-branch-entry="${selected?.id}"]`)
    if (!viewport || !row) return
    const bounds = viewport.getBoundingClientRect(),
      item = row.getBoundingClientRect()
    if (item.bottom > bounds.bottom) viewport.scrollTop += item.bottom - bounds.bottom
    else if (item.top < bounds.top) viewport.scrollTop += item.top - bounds.top
  }, [selected?.id, state.picker])
  const overlay = state.picker ? (
    <div className={styles.pickerLayer}>
      <div className={styles.pickerShade} />
      <section
        className={styles.picker}
        aria-label="会话分支选择器"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            patch({ picker: false })
            return
          }
          if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)
            return
          const index = rows.findIndex((entry) => entry.id === selected?.id)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const next =
              rows[
                Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
              ]
            if (next) patch({ selected: next.id })
          } else if (event.key === 'Enter' && selected && event.target === treeRef.current) {
            event.preventDefault()
            switchEntry(selected.id)
          }
        }}
      >
        <header>
          <strong>会话分支</strong>
          <span>{rows.length} 条</span>
          <IconButton label="关闭会话分支" onClick={() => patch({ picker: false })}>
            <X size={16} />
          </IconButton>
        </header>
        <div className={styles.search}>
          <Search size={14} />
          <input
            aria-label="搜索会话分支消息"
            placeholder="搜索消息、工具或标签"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <select
            aria-label="筛选会话分支"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          >
            {['默认', '不含工具', '只看用户', '全部'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </div>
        <div className={styles.detail} aria-label="选中的消息详情">
          {selected ? (
            <>
              <div>
                <strong>{selected.kind}</strong>
                <time>今天 10:24</time>
              </div>
              <p>{selected.text}</p>
            </>
          ) : (
            <p>没有匹配消息</p>
          )}
        </div>
        <div ref={treeRef} tabIndex={0} className={styles.tree} role="tree" aria-label="会话分支树">
          {rows.map((entry) => (
            <div
              key={entry.id}
              role="treeitem"
              data-branch-entry={entry.id}
              aria-level={entry.depth + 1}
              aria-selected={selected?.id === entry.id}
              className={`${styles.row} ${selected?.id === entry.id ? styles.selected : ''}`}
              style={{ paddingLeft: entry.depth * 10 }}
            >
              <button
                type="button"
                className={styles.node}
                aria-label={`选择历史消息 ${entry.id}`}
                onClick={() => patch({ selected: entry.id })}
              >
                <span className={styles.connector}>·</span>
                <span className={styles.kind}>{entry.kind}</span>
                <span className={styles.text}>{entry.text}</span>
              </button>
              {mobile && (
                <Action label={`切换到历史消息 ${entry.id}`} onClick={() => switchEntry(entry.id)}>
                  切换
                </Action>
              )}
              {entry.kind === '用户' && (
                <Action
                  label={`从用户消息 ${entry.id} Fork 新会话`}
                  onClick={() => forkEntry(entry.id)}
                >
                  Fork
                </Action>
              )}
            </div>
          ))}
        </div>
        <footer>
          <span>
            {rows.length ? rows.findIndex((entry) => entry.id === selected?.id) + 1 : 0} /{' '}
            {rows.length}
          </span>
          {!mobile && (
            <Action
              primary
              label="切换到选中的会话分支"
              disabled={!selected}
              onClick={selected ? () => switchEntry(selected.id) : undefined}
            >
              切换
            </Action>
          )}
        </footer>
      </section>
    </div>
  ) : undefined
  const path = branchPath(conversation.leaf)
  return (
    <Desk
      className={styles.desk}
      mobile={mobile}
      mobileSidebar={drawer}
      sessions={[
        {
          id: 'source',
          title: '开发导出功能',
          active: !forked,
          counts: { user: 2, total: 6 },
          updated: '1 分钟前',
          onSelect: () => selectSession(-1)
        },
        ...state.forks.map((fork, index) => ({
          id: `fork-${index}`,
          title: `新会话${index ? ` ${index + 1}` : ''}`,
          active: state.active === index,
          counts: {
            user:
              branchPath(fork.leaf).filter((entry) => entry.kind === '用户').length +
              fork.sent.length,
            total: branchPath(fork.leaf).length + fork.sent.length * 2
          },
          updated: '刚刚',
          onSelect: () => selectSession(index)
        }))
      ]}
    >
      <Chat
        title={title}
        focused
        autoScroll={conversation.sent.length > 0}
        empty={!path.length && !conversation.sent.length}
        onMenu={() => setDrawer(true)}
        overlay={overlay}
        composer={
          <Composer
            draft={conversation.draft}
            onDraftChange={(value) => updateConversation({ draft: value })}
            onSend={
              conversation.draft.trim()
                ? () =>
                    updateConversation({
                      sent: [...conversation.sent, conversation.draft],
                      draft: ''
                    })
                : undefined
            }
            onMore={() => patch({ menu: !state.menu })}
            panel={
              state.menu ? (
                <Menu title="会话">
                  <MenuItem
                    icon={<GitBranch size={16} />}
                    onClick={() => patch({ picker: true, menu: false })}
                  >
                    会话分支
                  </MenuItem>
                  <span className={styles.menuReference}>克隆当前会话</span>
                  <span className={styles.menuReference}>替换为新会话</span>
                </Menu>
              ) : undefined
            }
          />
        }
      >
        {path.map((entry) =>
          entry.kind === '用户' ? (
            <UserMessage key={entry.id}>{entry.text}</UserMessage>
          ) : entry.kind === '工具' ? (
            <ProcessRow key={entry.id}>{entry.text}</ProcessRow>
          ) : (
            <AssistantMessage key={entry.id}>{entry.text}</AssistantMessage>
          )
        )}
        {conversation.sent.map((text, index) => (
          <div key={index}>
            <UserMessage>{text}</UserMessage>
            <AssistantMessage>
              <p
                data-guide-target={
                  index === conversation.sent.length - 1 ? 'fork-result' : undefined
                }
              >
                {text === revisedBranchRequest
                  ? '按新要求继续：仅导出未完成任务，文件名为 qingzhou-tasks.csv。'
                  : `收到：${text} 我会从当前选定的历史继续处理。`}
              </p>
            </AssistantMessage>
          </div>
        ))}
      </Chat>
    </Desk>
  )
}
export function BranchesScene(props: ShowcaseSceneProps): ReactElement {
  return <DemoDevices>{(mobile) => <BranchDevice {...props} mobile={mobile} />}</DemoDevices>
}
