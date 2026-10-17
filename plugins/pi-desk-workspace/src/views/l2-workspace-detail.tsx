import { useEffect, useId, useState } from 'react'
import {
  PluginActionRow,
  PluginButton,
  PluginEmptyState,
  PluginList,
  PluginListItem,
  PluginSection,
  PluginTab,
  PluginTabList
} from '@jetcrab/pi-desk-sdk/react/base'
import type { WorkspaceCommandSummary, WorkspaceSnapshotItem } from '../contract.js'
import {
  workspaceDisplayName,
  workspaceDuration,
  workspaceTime,
  type WorkspaceDetailTab
} from '../l2-workspace-browser-model.js'
import { WorkspaceRecords } from './l2-workspace-records.js'

const TABS: { value: WorkspaceDetailTab; label: string }[] = [
  { value: 'records', label: '活动记录' },
  { value: 'actions', label: '项目命令' },
  { value: 'info', label: '工作区信息' }
]

export function WorkspaceOccupationTime({
  occupiedAt,
  timeFormatter
}: {
  occupiedAt: number
  timeFormatter: Intl.DateTimeFormat
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="workspace-occupation-time">
      <span>
        占用时间{' '}
        <time dateTime={new Date(occupiedAt).toISOString()}>
          {workspaceTime(occupiedAt, timeFormatter)}
        </time>
      </span>
      <span>已占用 {workspaceDuration(now - occupiedAt)}</span>
    </span>
  )
}

export function WorkspaceDetail({
  workspace,
  timeFormatter,
  commands,
  tab,
  disabled,
  currentSessionId,
  canPreview,
  onTab,
  onCommand,
  onCopy,
  onSourceSession,
  onPreview,
  onSwitchActive
}: {
  workspace: WorkspaceSnapshotItem
  timeFormatter: Intl.DateTimeFormat
  commands: WorkspaceCommandSummary[]
  tab: WorkspaceDetailTab
  disabled: boolean
  currentSessionId: string
  canPreview: boolean
  onTab(tab: WorkspaceDetailTab): void
  onCommand(commandId: string): void
  onCopy(): void
  onSourceSession(): void
  onPreview(): void
  onSwitchActive(): void
}): React.JSX.Element {
  const id = useId()
  const [expandedActions, setExpandedActions] = useState<'reset' | 'more' | null>(null)
  const regular = commands.filter((command) => command.onSuccess === 'occupied')
  const resets = commands.filter((command) => command.onSuccess === 'available')
  const removals = commands.filter((command) => command.onSuccess === 'removed')
  const occupation = workspace.occupation
  const requirement = occupation?.requirement
  const blocked = disabled || Boolean(workspace.issue)
  const sourceLabel = !occupation?.sourceSessionId
    ? '未记录来源会话'
    : occupation.sourceSessionId === currentSessionId
      ? '来源为当前会话'
      : '打开来源会话'

  return (
    <div className="workspace-detail">
      <div className="workspace-quick-actions">
        <PluginButton size="sm" variant="primary" disabled={!canPreview} onClick={onPreview}>
          查看项目目录
        </PluginButton>
        {occupation ? (
          <PluginButton
            size="sm"
            variant="secondary"
            disabled={disabled || sourceLabel !== '打开来源会话'}
            onClick={onSourceSession}
          >
            {sourceLabel}
          </PluginButton>
        ) : null}
        {resets.length === 1 ? (
          <PluginButton
            size="sm"
            variant="ghost"
            className="workspace-danger"
            disabled={blocked}
            onClick={() => onCommand(resets[0]!.id)}
          >
            重置工作区
          </PluginButton>
        ) : resets.length > 1 ? (
          <PluginButton
            size="sm"
            variant="ghost"
            className="workspace-danger"
            disabled={blocked}
            aria-expanded={expandedActions === 'reset'}
            aria-controls={`${id}-management`}
            onClick={() => setExpandedActions((value) => (value === 'reset' ? null : 'reset'))}
          >
            重置工作区
          </PluginButton>
        ) : null}
        <PluginButton
          size="sm"
          variant="ghost"
          aria-label="更多工作区操作"
          aria-expanded={expandedActions === 'more'}
          aria-controls={`${id}-management`}
          onClick={() => setExpandedActions((value) => (value === 'more' ? null : 'more'))}
        >
          {expandedActions === 'more' ? '收起' : '更多'}
        </PluginButton>
      </div>
      <div
        id={`${id}-management`}
        className="workspace-management"
        hidden={expandedActions === null}
      >
        {expandedActions === 'reset' ? (
          <PluginSection title="选择重置方式" density="compact">
            <PluginList density="compact">
              {resets.map((command) => (
                <PluginListItem
                  key={command.id}
                  density="compact"
                  disabled={blocked}
                  onClick={() => onCommand(command.id)}
                >
                  <span className="workspace-command-copy">
                    <span className="workspace-command-name">{command.id}</span>
                    <span className="workspace-command-description">{command.description}</span>
                  </span>
                  <span aria-hidden="true">›</span>
                </PluginListItem>
              ))}
            </PluginList>
          </PluginSection>
        ) : (
          <PluginActionRow>
            {occupation ? (
              <PluginButton
                size="sm"
                variant="secondary"
                disabled={blocked}
                onClick={onSwitchActive}
              >
                {workspace.active ? '取消当前选择' : '在当前会话使用'}
              </PluginButton>
            ) : null}
            <PluginButton size="sm" variant="ghost" onClick={onCopy}>
              复制工作区信息
            </PluginButton>
            {removals.map((command) => (
              <PluginButton
                key={command.id}
                size="sm"
                variant="ghost"
                className="workspace-danger"
                disabled={blocked}
                onClick={() => onCommand(command.id)}
              >
                {removals.length === 1 ? '删除工作区…' : `删除工作区 · ${command.id}…`}
              </PluginButton>
            ))}
          </PluginActionRow>
        )}
      </div>
      <PluginTabList label="工作区详情" className="workspace-tabs">
        {TABS.map((item, index) => (
          <PluginTab
            key={item.value}
            id={`${id}-${item.value}`}
            aria-controls={`${id}-${item.value}-panel`}
            active={tab === item.value}
            tabIndex={tab === item.value ? 0 : -1}
            onClick={() => onTab(item.value)}
            onKeyDown={(event) => {
              let next: number
              if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
              else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length
              else if (event.key === 'Home') next = 0
              else if (event.key === 'End') next = TABS.length - 1
              else return
              event.preventDefault()
              onTab(TABS[next]!.value)
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [next]?.focus()
            }}
          >
            {item.label}
          </PluginTab>
        ))}
      </PluginTabList>
      <div
        id={`${id}-records-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-records`}
        hidden={tab !== 'records'}
      >
        <WorkspaceRecords
          occupation={occupation}
          timeFormatter={timeFormatter}
          active={tab === 'records'}
        />
      </div>
      <div
        id={`${id}-actions-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-actions`}
        hidden={tab !== 'actions'}
      >
        {!regular.length ? (
          <PluginEmptyState density="compact">当前没有可执行的项目命令</PluginEmptyState>
        ) : (
          <PluginList density="compact">
            {regular.map((command) => (
              <PluginListItem
                key={command.id}
                density="compact"
                data-workspace-command={command.id}
                aria-label={`运行 ${command.id}`}
                disabled={blocked}
                onClick={() => onCommand(command.id)}
              >
                <span className="workspace-command-copy">
                  <span className="workspace-command-name">{command.id}</span>
                  <span className="workspace-command-description">{command.description}</span>
                </span>
                <span className="workspace-list-arrow" aria-hidden="true">
                  ›
                </span>
              </PluginListItem>
            ))}
          </PluginList>
        )}
      </div>
      <div
        id={`${id}-info-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-info`}
        hidden={tab !== 'info'}
      >
        <div className="workspace-information">
          {requirement && requirement !== workspaceDisplayName(workspace) ? (
            <PluginSection title="需求原文" density="compact">
              <p className="workspace-description workspace-requirement">{requirement}</p>
            </PluginSection>
          ) : null}
          <PluginSection title="项目目录" density="compact">
            <code className="workspace-path">{workspace.root}</code>
          </PluginSection>
          <PluginSection title="工作区配置" density="compact">
            <p className="workspace-description">{workspace.definition}</p>
          </PluginSection>
          <PluginSection title="工作区标识" density="compact">
            <code className="workspace-path">{workspace.id}</code>
          </PluginSection>
          <PluginActionRow>
            <PluginButton size="sm" variant="secondary" onClick={onCopy}>
              复制工作区信息
            </PluginButton>
          </PluginActionRow>
        </div>
      </div>
    </div>
  )
}
