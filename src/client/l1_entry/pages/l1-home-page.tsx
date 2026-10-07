'use client'

import { useCallback, useEffect, useMemo, type ComponentProps } from 'react'
import { L2TerminalBiz } from '@client/l2_biz/terminal/l2-terminal-biz'
import { L2TerminalWorkspace } from '@client/l2_biz/terminal/l2-terminal-workspace'
import { useL4PluginHost } from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { L2CapabilityModesSettings } from '@client/l2_biz/capability-modes/l2-capability-modes-settings'
import { L2PluginApplication } from '@client/l2_biz/plugin-host/l2-plugin-application'
import { L2PluginComposerPanel } from '@client/l2_biz/plugin-host/l2-plugin-composer-panel'
import { L2PluginManagement } from '@client/l2_biz/plugin-host/l2-plugin-management'
import { createL2PluginManagementBiz } from '@client/l2_biz/plugin-host/l2-plugin-management-biz'
import { L2PluginSessionSidebarTab } from '@client/l2_biz/plugin-host/l2-plugin-session-sidebar-tab'
import { L2PluginSettingsPage } from '@client/l2_biz/plugin-host/l2-plugin-settings-page'
import { L2Settings } from '@client/l2_biz/settings/l2-settings'
import { L2PiSettings } from '@client/l2_biz/pi-settings/l2-pi-settings'
import { createL2TaskCenterBiz } from '@client/l2_biz/task-center/l2-task-center-biz'
import { L2TaskCenterPluginSlot } from '@client/l2_biz/task-center/l2-task-center-plugin-slot'
import { createL2TaskCenterRuntime } from '@client/l2_biz/task-center/l2-task-center-runtime'
import { L2Workbench } from '@client/l2_biz/workbench/l2-workbench'
import { useL4AppSocket } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'

type WorkbenchProps = ComponentProps<typeof L2Workbench>
type SettingsProps = ComponentProps<typeof L2Settings>

function renderPluginApplication(
  input: Parameters<WorkbenchProps['renderPluginApplication']>[0]
): React.JSX.Element {
  return (
    <L2PluginApplication
      key={`${input.pluginName}:${input.descriptor.contributionName}`}
      {...input}
    />
  )
}

function renderPluginSessionSidebarTab(
  input: Parameters<WorkbenchProps['renderPluginSessionSidebarTab']>[0]
): React.JSX.Element {
  return (
    <L2PluginSessionSidebarTab
      key={`${input.pluginName}:${input.descriptor.contributionName}:${input.source.workId}:${input.source.sessionId}:${input.source.branchId}`}
      {...input}
    />
  )
}

function renderPluginComposerPanel(
  input: Parameters<WorkbenchProps['renderPluginComposerPanel']>[0]
): React.JSX.Element {
  const sourceKey = JSON.stringify([
    input.source.workId,
    input.source.sessionId,
    input.source.branchId
  ])
  return (
    <L2PluginComposerPanel
      key={`${input.pluginName}:${input.descriptor.contributionName}:${sourceKey}`}
      {...input}
    />
  )
}

function renderPluginSettingsPage(
  input: Parameters<SettingsProps['renderPluginSettingsPage']>[0]
): React.JSX.Element {
  return (
    <L2PluginSettingsPage
      key={`${input.pluginName}:${input.descriptor.contributionName}`}
      {...input}
    />
  )
}

export function L1HomePage(): React.JSX.Element {
  const { clientId, appSocket } = useL4AppSocket()
  const pluginHost = useL4PluginHost()
  const toast = useL4AppToast()
  const terminalBiz = useMemo(
    () => new L2TerminalBiz(appSocket, toast.error),
    [appSocket, toast.error]
  )
  useEffect(() => {
    terminalBiz.start()
    const unbind = pluginHost.bindTerminalOpen((cwd, signal) => terminalBiz.open(cwd, signal))
    return () => {
      unbind()
      terminalBiz.dispose()
    }
  }, [pluginHost, terminalBiz])
  const renderTerminalWorkspace = useCallback<WorkbenchProps['renderTerminalWorkspace']>(
    (input) => <L2TerminalWorkspace {...input} biz={terminalBiz} />,
    [terminalBiz]
  )
  const pluginManagementBiz = useMemo(
    () => createL2PluginManagementBiz(clientId, appSocket),
    [clientId, appSocket]
  )
  const taskCenterBiz = useMemo(
    () => createL2TaskCenterBiz(clientId, appSocket),
    [appSocket, clientId]
  )
  const taskCenterRuntime = useMemo(() => createL2TaskCenterRuntime(taskCenterBiz), [taskCenterBiz])
  const renderTaskSummary = useCallback<WorkbenchProps['renderTaskSummary']>(
    (input): React.JSX.Element => (
      <L2TaskCenterPluginSlot {...input} runtime={taskCenterRuntime} variant="summary" />
    ),
    [taskCenterRuntime]
  )
  const renderTaskMenu = useCallback<WorkbenchProps['renderTaskMenu']>(
    (input): React.JSX.Element => (
      <L2TaskCenterPluginSlot {...input} runtime={taskCenterRuntime} variant="menu" />
    ),
    [taskCenterRuntime]
  )
  const renderSettings = useCallback<WorkbenchProps['renderSettings']>(
    (input): React.JSX.Element => (
      <L2Settings
        key={`${input.open}:${input.initialPage ?? 'default'}`}
        open={input.open}
        initialModelTab={input.initialPage === 'model-presets' ? 'presets' : undefined}
        workSessions={input.workSessions}
        focusedCwd={input.focusedCwd}
        pluginAttention={input.pluginAttention}
        onOpenChange={input.onOpenChange}
        onBeforeReload={input.onBeforeReload}
        renderPluginSettingsPage={renderPluginSettingsPage}
        renderMcpSettings={({ onBeforeLeaveChange }) => (
          <L2PiSettings
            projects={input.workSessions}
            focusedCwd={input.focusedCwd}
            onBeforeLeaveChange={onBeforeLeaveChange}
          />
        )}
        renderCapabilityModesSettings={({ onBeforeLeaveChange }) => (
          <L2CapabilityModesSettings
            modeNames={input.capabilityModes}
            onBeforeLeaveChange={onBeforeLeaveChange}
          />
        )}
        renderPluginManagement={() => (
          <L2PluginManagement
            basicMode={input.basicMode}
            snapshot={input.pluginManagementSnapshot}
            biz={pluginManagementBiz}
            onSnapshot={input.onPluginManagementSnapshot}
            onRestartScheduled={input.onPluginRestartScheduled}
          />
        )}
      />
    ),
    [pluginManagementBiz]
  )

  return (
    <L2Workbench
      onTerminalReady={terminalBiz.connected}
      onTerminalDisconnected={terminalBiz.disconnected}
      onOpenTerminal={terminalBiz.open}
      renderTerminalWorkspace={renderTerminalWorkspace}
      listPluginManagement={pluginManagementBiz.list}
      subscribePluginManagementChanges={pluginManagementBiz.subscribeChanges}
      onTaskCenterStart={taskCenterRuntime.start}
      onTaskCenterDispose={taskCenterRuntime.dispose}
      onTaskCenterReconcileWorkSessions={taskCenterRuntime.reconcileWorkSessions}
      onTaskCenterDisconnected={taskCenterRuntime.disconnected}
      onTaskCenterReconnected={taskCenterRuntime.reconnected}
      renderPluginApplication={renderPluginApplication}
      renderPluginSessionSidebarTab={renderPluginSessionSidebarTab}
      renderPluginComposerPanel={renderPluginComposerPanel}
      renderSettings={renderSettings}
      renderTaskSummary={renderTaskSummary}
      renderTaskMenu={renderTaskMenu}
    />
  )
}
