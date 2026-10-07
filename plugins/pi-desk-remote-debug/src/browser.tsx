import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  BrowserApplicationImplementation,
  BrowserApplicationTarget,
  BrowserPluginHost
} from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginAlert,
  PluginBadge,
  PluginButton,
  PluginEmptyState,
  PluginErrorBoundary,
  PluginHostProvider,
  PluginList,
  PluginListItem,
  PluginScroll,
  PluginSelectField,
  PluginSplitView,
  PluginSurface
} from '@jetcrab/pi-desk-sdk/react/base'
import type { RemoteDebugBrowserEvents } from './l4-browser-events.js'
import {
  isActiveRun,
  readRuns,
  restartProfile,
  sendFailureToAi,
  startProfile,
  stopRun
} from './l2-browser-biz.js'
import { useCatalog } from './hooks/l2-use-catalog.js'
import { useProfileActions } from './hooks/l2-use-profile-actions.js'
import { getRemoteDebugRegion, subscribeRemoteDebugRegion } from './browser-time.js'
import { ProfileCard } from './views/l2-profile-card.js'
import { REMOTE_DEBUG_LAYOUT } from './views/l4-browser-ui.js'

function RemoteDebugApplication({
  target,
  host,
  signal,
  events
}: {
  target: BrowserApplicationTarget
  host: BrowserPluginHost
  signal: AbortSignal
  events: RemoteDebugBrowserEvents
}): React.JSX.Element {
  const catalog = useCatalog(host, signal, events)
  const rawState = useSyncExternalStore(
    (listener) => host.globalState.subscribe(listener),
    () => host.globalState.getSnapshot(),
    () => null
  )
  const runs = useMemo(() => readRuns(rawState), [rawState])
  const [selectedCwd, setSelectedCwd] = useState(target.initialContext?.cwd ?? '')
  const { pending, action } = useProfileActions(host, signal)
  const [region, setRegion] = useState(() => getRemoteDebugRegion(host))
  useEffect(
    () => subscribeRemoteDebugRegion(host, () => setRegion(getRemoteDebugRegion(host))),
    [host]
  )
  const selectedProject =
    catalog.projects.find((project) => project.cwd === selectedCwd) ??
    catalog.projects.find((project) => project.status === 'ready') ??
    catalog.projects[0] ??
    null
  const selectedRuns = runs
    .filter((run) => run.cwd === selectedProject?.cwd)
    .sort((left, right) => right.startedAt - left.startedAt)
  const navigation = (
    <div className="remote-debug-navigation">
      <PluginList>
        {catalog.projects.map((project) => {
          const activeCount = runs.filter(
            (run) => run.cwd === project.cwd && isActiveRun(run)
          ).length
          return (
            <PluginListItem
              key={project.cwd}
              selected={project.cwd === selectedProject?.cwd}
              onClick={() => setSelectedCwd(project.cwd)}
              data-remote-debug-project={project.cwd}
            >
              <div className="remote-debug-stack">
                <span className="remote-debug-name">{project.label}</span>
                {activeCount ? <PluginBadge tone="info">{activeCount} 运行中</PluginBadge> : null}
              </div>
            </PluginListItem>
          )
        })}
      </PluginList>
    </div>
  )
  return (
    <PluginSurface className="remote-debug-application" data-remote-debug-application="">
      <style>{REMOTE_DEBUG_LAYOUT}</style>
      <PluginSplitView
        className="remote-debug-split"
        navigation={navigation}
        navigationLabel="远程调试项目"
      >
        <div className="remote-debug-heading">
          <h2 className="remote-debug-project-title">{selectedProject?.label ?? '远程调试'}</h2>
          <PluginSelectField
            className="remote-debug-mobile-project"
            label="项目"
            size="sm"
            value={selectedProject?.cwd ?? null}
            options={catalog.projects.map((project) => ({
              value: project.cwd,
              label: project.label
            }))}
            onValueChange={(value) => {
              if (value) setSelectedCwd(value)
            }}
          />
          <PluginButton
            size="sm"
            variant="ghost"
            disabled={catalog.loading}
            onClick={() => {
              void catalog.refresh()
            }}
          >
            {catalog.loading ? '同步中…' : '刷新'}
          </PluginButton>
        </div>
        {catalog.error ? <PluginAlert tone="error">{catalog.error}</PluginAlert> : null}
        {!catalog.loading && (!selectedProject || selectedProject.status === 'unconfigured') ? (
          <PluginEmptyState>暂无启动项</PluginEmptyState>
        ) : null}
        {selectedProject?.status === 'invalid' ? (
          <PluginAlert tone="error">{selectedProject.error ?? '项目配置无效'}</PluginAlert>
        ) : null}
        {selectedProject?.status === 'ready' ? (
          <PluginScroll
            className="remote-debug-profile-list"
            viewportClassName="remote-debug-profile-viewport"
            aria-label="调试配置"
          >
            {selectedProject.profiles.map((profile) => {
              const profileRuns = selectedRuns.filter((run) => run.profile === profile.name)
              const profileKey = `${selectedProject.cwd}:${profile.name}`
              return (
                <ProfileCard
                  key={profileKey}
                  cwd={selectedProject.cwd}
                  profile={profile}
                  latest={profileRuns[0] ?? null}
                  active={profileRuns.find(isActiveRun) ?? null}
                  pending={pending.get(profileKey) ?? null}
                  host={host}
                  locale={region.locale}
                  timeZone={region.timeZone}
                  onStart={() => {
                    void action(profileKey, `start:${profileKey}`, () =>
                      startProfile(host, selectedProject.cwd, profile.name)
                    )
                  }}
                  onRestart={(run) => {
                    void action(profileKey, `restart:${profileKey}`, () =>
                      restartProfile(host, run)
                    )
                  }}
                  onStop={(run) => {
                    void action(profileKey, `stop:${run.runId}`, () => stopRun(host, run.runId))
                  }}
                  onSendFailure={(run) => {
                    void action(profileKey, `ai:${run.runId}`, () => sendFailureToAi(host, run))
                  }}
                />
              )
            })}
          </PluginScroll>
        ) : null}
      </PluginSplitView>
    </PluginSurface>
  )
}

export function createRemoteDebugApplication(
  events: RemoteDebugBrowserEvents
): BrowserApplicationImplementation {
  return {
    mount({ container, target, host, signal }): () => void {
      const root = createRoot(container)
      root.render(
        <PluginErrorBoundary>
          <PluginHostProvider host={host}>
            <RemoteDebugApplication target={target} host={host} signal={signal} events={events} />
          </PluginHostProvider>
        </PluginErrorBoundary>
      )
      return (): void => root.unmount()
    }
  }
}
