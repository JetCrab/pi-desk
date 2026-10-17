import { useEffect, useMemo, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  BrowserPluginHost,
  BrowserSessionSidebarTabImplementation,
  BrowserSessionSidebarTabTarget
} from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginActionRow,
  PluginAlert,
  PluginButton,
  PluginConfirmDialog,
  PluginDialog,
  PluginEmptyState,
  PluginErrorBoundary,
  PluginHostProvider,
  PluginLoadingState,
  PluginPanelHeader,
  PluginScroll,
  PluginSurface
} from '@jetcrab/pi-desk-sdk/react/base'
import { useWorkspaceBrowserBiz } from './l2-workspace-browser-biz.js'
import {
  commandActionLabel,
  commandImpact,
  workspaceDisplayName,
  workspaceProjectName,
  workspaceTimeFormatter
} from './l2-workspace-browser-model.js'
import { WORKSPACE_STYLES } from './l2-workspace-styles.js'
import { shortWorkspaceTitle } from './l4-workspace-title.js'
import { WorkspaceCommand } from './views/l2-workspace-command.js'
import { WorkspaceDetail, WorkspaceOccupationTime } from './views/l2-workspace-detail.js'
import { WorkspaceList, WorkspaceStatus } from './views/l2-workspace-list.js'

function WorkspaceView({
  target,
  host,
  signal
}: {
  target: BrowserSessionSidebarTabTarget
  host: BrowserPluginHost
  signal: AbortSignal
}): React.JSX.Element {
  const biz = useWorkspaceBrowserBiz(target, host, signal)
  const { snapshot, workspace, command, dialog } = biz
  const timeFormatter = useMemo(
    () => workspaceTimeFormatter(host.locale?.getSnapshot().locale ?? 'zh-CN'),
    [host]
  )
  const busy = Boolean(biz.pending)
  const commandMode = Boolean(dialog?.command)
  const confirmation =
    dialog?.command?.confirmation !== null && dialog?.command?.confirmation !== undefined
  const commands =
    snapshot?.definitions
      .find((item) => item.id === workspace?.definition)
      ?.commands.filter((item) => workspace && item.from.includes(workspace.status)) ?? []
  const error = biz.error ?? (!biz.connectionReady ? '连接已断开，正在等待重新连接。' : null)
  const errorRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLSpanElement | null>(null)
  const previousCommandMode = useRef(false)
  useEffect(() => {
    if (biz.error) errorRef.current?.focus()
  }, [biz.error])
  useEffect(() => {
    // 初次打开由宿主管理焦点；只处理同一弹窗内部替换步骤后的定位。
    if (workspace && previousCommandMode.current !== commandMode) titleRef.current?.focus()
    previousCommandMode.current = commandMode
  }, [commandMode, workspace])

  return (
    <PluginHostProvider host={host}>
      <style>{WORKSPACE_STYLES}</style>
      <PluginSurface className="workspace-panel" data-workspace-panel="">
        <PluginPanelHeader
          title={
            <span
              className="workspace-project-title"
              title={`隔离工作区 · ${workspaceProjectName(target.cwd)}`}
            >
              隔离工作区 · {workspaceProjectName(target.cwd)}
            </span>
          }
          density="compact"
          actions={
            <PluginButton
              size="sm"
              variant="ghost"
              disabled={busy || biz.refreshing || !biz.connectionReady}
              onClick={() => void biz.refresh()}
            >
              {biz.refreshing ? '刷新中…' : '刷新'}
            </PluginButton>
          }
        />
        <PluginScroll
          className="workspace-body"
          viewportClassName="workspace-body-viewport"
          data-workspace-scroll=""
          aria-label="工作区列表"
        >
          {snapshot && error && !workspace ? (
            <PluginAlert tone="error" density="compact">
              {error}
            </PluginAlert>
          ) : null}
          <PluginLoadingState
            loading={!snapshot && !error}
            error={!snapshot ? error : null}
            loadingLabel="正在读取工作区…"
            retryLabel="重新读取"
            onRetry={biz.connectionReady ? () => void biz.refresh() : undefined}
          >
            {snapshot ? (
              !snapshot.trusted ? (
                <PluginAlert tone="warning" density="compact">
                  当前项目尚未信任，无法使用隔离工作区。
                </PluginAlert>
              ) : snapshot.config.status === 'missing' ? (
                <PluginEmptyState density="compact">
                  当前项目还没有 .pi/workspace.yml
                </PluginEmptyState>
              ) : snapshot.config.status === 'invalid' ? (
                <PluginAlert tone="error" density="compact">
                  {snapshot.config.error ?? '工作区配置无效'}
                  <PluginActionRow>
                    <PluginButton
                      size="sm"
                      variant="secondary"
                      onClick={() => target.files.preview('.pi/workspace.yml')}
                    >
                      查看配置
                    </PluginButton>
                  </PluginActionRow>
                </PluginAlert>
              ) : (
                <WorkspaceList
                  workspaces={snapshot.workspaces}
                  timeFormatter={timeFormatter}
                  selectedId={dialog?.workspaceId ?? null}
                  disabled={busy}
                  onSelect={biz.openDetail}
                />
              )
            ) : null}
          </PluginLoadingState>
        </PluginScroll>
      </PluginSurface>

      <PluginDialog
        open={workspace !== null && !confirmation}
        size="lg"
        title={
          <span
            ref={titleRef}
            tabIndex={-1}
            className="workspace-dialog-title"
            title={workspace?.occupation?.requirement}
          >
            {commandMode
              ? shortWorkspaceTitle(command ? `执行 ${command.id}` : '执行命令')
              : workspace
                ? workspaceDisplayName(workspace)
                : '工作区详情'}
          </span>
        }
        description={
          workspace ? (
            <span className="workspace-dialog-description">
              <span className="workspace-dialog-meta">
                <WorkspaceStatus workspace={workspace} />
                <span className="workspace-list-subtitle">{workspace.definition}</span>
              </span>
              {workspace.occupation ? (
                <WorkspaceOccupationTime
                  occupiedAt={workspace.occupation.occupiedAt}
                  timeFormatter={timeFormatter}
                />
              ) : null}
            </span>
          ) : undefined
        }
        onOpenChange={(open) => {
          if (!open) biz.closeDetail()
        }}
        footer={
          workspace ? (
            commandMode ? (
              <>
                <PluginButton
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={biz.backToDetail}
                >
                  返回工作区
                </PluginButton>
                <PluginButton
                  size="sm"
                  variant="primary"
                  disabled={
                    busy || !biz.connectionReady || Boolean(workspace.issue) || biz.commandInvalid
                  }
                  onClick={biz.executeCommand}
                >
                  {busy ? '执行中…' : command ? commandActionLabel(command) : '执行'}
                </PluginButton>
              </>
            ) : undefined
          ) : undefined
        }
      >
        {workspace && dialog ? (
          <>
            {error ? (
              <div ref={errorRef} tabIndex={-1} className="workspace-error">
                <PluginAlert tone="error" density="compact">
                  {error}
                </PluginAlert>
              </div>
            ) : null}
            {workspace.issue ? (
              <div className="workspace-error">
                <PluginAlert tone="error" density="compact">
                  {workspace.issue}
                </PluginAlert>
              </div>
            ) : null}
            {biz.commandInvalid && !busy ? (
              <div className="workspace-error">
                <PluginAlert tone="warning" density="compact">
                  工作区或命令状态已变化，请返回重新选择命令。
                </PluginAlert>
              </div>
            ) : null}
            {dialog.command ? (
              command ? (
                <WorkspaceCommand
                  key={`${dialog.command.workspaceRef}:${command.id}`}
                  workspace={workspace}
                  command={command}
                  values={dialog.command.values}
                  disabled={busy || biz.commandInvalid}
                  hasError={Boolean(biz.error)}
                  onValue={biz.setValue}
                />
              ) : null
            ) : (
              <WorkspaceDetail
                key={workspace.workspaceRef ?? workspace.id}
                workspace={workspace}
                timeFormatter={timeFormatter}
                commands={commands}
                tab={dialog.tab}
                disabled={busy || !biz.connectionReady}
                currentSessionId={target.source.sessionId}
                canPreview={!busy && Boolean(host.projects?.preview)}
                onTab={biz.selectTab}
                onCommand={biz.openCommand}
                onCopy={() => void biz.copyWorkspace()}
                onSourceSession={() => void biz.goToSourceSession()}
                onPreview={biz.previewProject}
                onSwitchActive={() => void biz.switchActive()}
              />
            )}
          </>
        ) : null}
      </PluginDialog>

      <PluginConfirmDialog
        open={confirmation && workspace !== null && command !== null}
        title={command ? commandActionLabel(command) : '确认操作'}
        description={workspace ? workspaceDisplayName(workspace) : undefined}
        tone="danger"
        confirmLabel={command?.onSuccess === 'available' ? '确认重置' : '确认删除'}
        pending={busy}
        onOpenChange={(open) => {
          if (!open) biz.cancelConfirm()
        }}
        onConfirm={biz.confirmCommand}
      >
        {workspace && command ? (
          <div className="workspace-confirm">
            <p className="workspace-description">
              {command.id} · {command.description}
            </p>
            <code className="workspace-path">{workspace.root}</code>
            <PluginAlert tone="warning" density="compact">
              {commandImpact(command)}
            </PluginAlert>
          </div>
        ) : null}
      </PluginConfirmDialog>
    </PluginHostProvider>
  )
}

const implementation: BrowserSessionSidebarTabImplementation = {
  mount({ container, target, host, signal }) {
    const root = createRoot(container)
    root.render(
      <PluginErrorBoundary>
        <WorkspaceView target={target} host={host} signal={signal} />
      </PluginErrorBoundary>
    )
    return (): void => root.unmount()
  }
}

export default implementation
