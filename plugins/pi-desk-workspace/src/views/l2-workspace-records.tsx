import { useState } from 'react'
import {
  PluginAlert,
  PluginBadge,
  PluginButton,
  PluginEmptyState,
  PluginLogViewer
} from '@jetcrab/pi-desk-sdk/react/base'
import type { WorkspaceOccupation } from '../contract.js'
import {
  operationLabel,
  operationName,
  workspaceDuration,
  workspaceOperations,
  workspaceTime
} from '../l2-workspace-browser-model.js'

export function WorkspaceRecords({
  occupation,
  timeFormatter,
  active
}: {
  occupation: WorkspaceOccupation | null
  timeFormatter: Intl.DateTimeFormat
  active: boolean
}): React.JSX.Element {
  const [showOlder, setShowOlder] = useState(false)
  const [expandedLog, setExpandedLog] = useState<string | null>(null)
  const operations = workspaceOperations(occupation?.operations ?? [])
  const latest = operations[0]
  return (
    <div className="workspace-records">
      {latest &&
      (latest.result === 'failed' || latest.result === 'unknown' || latest.result === null) ? (
        <PluginAlert tone={latest.result === 'failed' ? 'error' : 'warning'} density="compact">
          最近操作：{operationName(latest)} · {operationLabel(latest).label}
          {latest.result === 'unknown' ? '。请先查看日志并核对实际状态，不要直接重复执行。' : null}
        </PluginAlert>
      ) : null}
      {!operations.length ? (
        <PluginEmptyState density="compact">
          {occupation ? '本次占用暂无操作记录' : '工作区可供下次复用，当前没有占用记录'}
        </PluginEmptyState>
      ) : (
        <>
          <div className="workspace-records-heading">
            <span className="workspace-command-name">本次占用</span>
            <span className="workspace-caption">{operations.length} 条记录 · 最多保留 50 条</span>
          </div>
          <div className="workspace-operations">
            {operations.map((operation, index) => {
              const presentation = operationLabel(operation)
              return (
                <details
                  className="workspace-operation"
                  key={operation.logPath}
                  hidden={!showOlder && index >= 5}
                  data-workspace-operation={operation.command}
                  data-result={operation.result ?? 'running'}
                  onToggle={(event) => {
                    if (!event.currentTarget.open) {
                      setExpandedLog((current) => (current === operation.logPath ? null : current))
                    }
                  }}
                >
                  <summary className="workspace-operation-head">
                    <span className="workspace-command-name">{operationName(operation)}</span>
                    <span className="workspace-operation-state">
                      <PluginBadge
                        tone={operation.result === 'success' ? 'neutral' : presentation.tone}
                      >
                        {presentation.label}
                      </PluginBadge>
                      <time
                        className="workspace-caption"
                        dateTime={new Date(operation.startedAt).toISOString()}
                      >
                        {workspaceTime(operation.startedAt, timeFormatter)}
                      </time>
                    </span>
                    <span className="workspace-operation-arrow" aria-hidden="true">
                      ›
                    </span>
                  </summary>
                  <div className="workspace-operation-body">
                    <div className="workspace-operation-times workspace-caption">
                      <span>命令：{operation.command}</span>
                      <span>开始：{workspaceTime(operation.startedAt, timeFormatter)}</span>
                      <span>
                        {operation.result === 'unknown'
                          ? '结束时间无法确定'
                          : operation.endedAt === null
                            ? '正在执行'
                            : `结束：${workspaceTime(operation.endedAt, timeFormatter)} · 耗时 ${workspaceDuration(operation.endedAt - operation.startedAt)}`}
                      </span>
                    </div>
                    {operation.summary ? (
                      <div className="workspace-operation-summary">
                        <p className="workspace-description workspace-preserve-text">
                          {operation.summary}
                        </p>
                      </div>
                    ) : null}
                    <div>
                      <PluginButton
                        size="sm"
                        variant="ghost"
                        aria-expanded={expandedLog === operation.logPath}
                        onClick={() =>
                          setExpandedLog((current) =>
                            current === operation.logPath ? null : operation.logPath
                          )
                        }
                      >
                        {expandedLog === operation.logPath ? '收起日志' : '查看日志'}
                      </PluginButton>
                    </div>
                    {active && (showOlder || index < 5) && expandedLog === operation.logPath ? (
                      <div className="workspace-log">
                        <PluginLogViewer path={operation.logPath} />
                      </div>
                    ) : null}
                  </div>
                </details>
              )
            })}
          </div>
          {operations.length > 5 ? (
            <PluginButton
              size="sm"
              variant="ghost"
              aria-expanded={showOlder}
              onClick={() => setShowOlder((value) => !value)}
            >
              {showOlder ? '收起较早记录' : `展开较早的 ${operations.length - 5} 条记录`}
            </PluginButton>
          ) : null}
        </>
      )}
    </div>
  )
}
