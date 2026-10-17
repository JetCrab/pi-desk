import { useState } from 'react'
import {
  PluginBadge,
  PluginButton,
  PluginEmptyState,
  PluginList,
  PluginListItem
} from '@jetcrab/pi-desk-sdk/react/base'
import type { WorkspaceSnapshotItem } from '../contract.js'
import {
  workspaceDisplayName,
  workspaceGroups,
  workspaceTime,
  workspaceUsage
} from '../l2-workspace-browser-model.js'

export function WorkspaceStatus({
  workspace
}: {
  workspace: WorkspaceSnapshotItem
}): React.JSX.Element {
  return (
    <span className="workspace-status">
      <PluginBadge tone="neutral">
        {workspace.status === 'available' ? '可用' : '占用中'}
      </PluginBadge>
      {workspace.active ? <PluginBadge tone="neutral">当前使用</PluginBadge> : null}
    </span>
  )
}

export function WorkspaceList({
  workspaces,
  timeFormatter,
  selectedId,
  disabled,
  onSelect
}: {
  workspaces: WorkspaceSnapshotItem[]
  timeFormatter: Intl.DateTimeFormat
  selectedId: string | null
  disabled: boolean
  onSelect(workspaceId: string): void
}): React.JSX.Element {
  const [showAvailable, setShowAvailable] = useState(false)
  const { occupied, available } = workspaceGroups(workspaces)
  if (workspaces.length === 0) {
    return <PluginEmptyState density="compact">暂无工作区</PluginEmptyState>
  }
  const nameCounts = new Map<string, number>()
  for (const workspace of workspaces) {
    const key = `${workspace.definition}:${workspaceDisplayName(workspace)}`
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }

  function items(entries: WorkspaceSnapshotItem[]): React.JSX.Element {
    return (
      <PluginList density="compact">
        {entries.map((workspace) => {
          const name = workspaceDisplayName(workspace)
          const usage = workspaceUsage(workspace)
          const duplicate = (nameCounts.get(`${workspace.definition}:${name}`) ?? 0) > 1
          return (
            <PluginListItem
              key={workspace.id}
              data-workspace-id={workspace.id}
              density="compact"
              selected={selectedId === workspace.id}
              disabled={disabled}
              aria-label={`${name}${duplicate ? `，${workspace.id}` : ''}，查看详情`}
              onClick={() => onSelect(workspace.id)}
            >
              <span className="workspace-list-copy">
                <span className="workspace-list-name">{name}</span>
                <span className="workspace-list-subtitle">
                  {workspace.occupation
                    ? `${workspaceTime(workspace.occupation.occupiedAt, timeFormatter)} 占用`
                    : workspace.id}
                </span>
                {duplicate && workspace.occupation ? (
                  <span className="workspace-list-subtitle">{workspace.id}</span>
                ) : null}
                {workspace.active || usage ? (
                  <span className="workspace-list-meta">
                    {workspace.active ? <PluginBadge tone="neutral">当前使用</PluginBadge> : null}
                    {usage ? (
                      <span
                        className="workspace-list-usage"
                        data-error={Boolean(workspace.issue) || usage === '最近操作失败'}
                      >
                        {usage}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </span>
              <span className="workspace-list-arrow" aria-hidden="true">
                ›
              </span>
            </PluginListItem>
          )
        })}
      </PluginList>
    )
  }

  return (
    <div className="workspace-list-groups">
      <div className="workspace-group-label">占用中 {occupied.length}</div>
      {occupied.length ? (
        items(occupied)
      ) : (
        <PluginEmptyState density="compact">当前没有占用的工作区</PluginEmptyState>
      )}
      {available.length ? (
        <>
          <PluginButton
            size="sm"
            variant="ghost"
            className="workspace-available-toggle"
            aria-expanded={showAvailable}
            onClick={() => setShowAvailable((value) => !value)}
          >
            <span>可用 {available.length} 个</span>
            <span aria-hidden="true">{showAvailable ? '⌄' : '›'}</span>
          </PluginButton>
          {showAvailable ? items(available) : null}
        </>
      ) : null}
    </div>
  )
}
