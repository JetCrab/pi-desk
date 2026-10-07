import { useState } from 'react'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginActionRow,
  PluginBadge,
  PluginButton,
  PluginCard,
  PluginKeyValueItem,
  PluginKeyValueList,
  PluginLogViewer
} from '@jetcrab/pi-desk-sdk/react/base'
import type { RemoteDebugProjectProfile, RemoteDebugRun } from '../runtime.js'
import { formatRemoteDebugTime } from '../browser-time.js'
import { CopyButton } from './l4-browser-ui.js'

function statusPresentation(status: RemoteDebugRun['status'] | undefined): {
  label: string
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'error'
} {
  if (status === 'starting') return { label: '启动中', tone: 'info' }
  if (status === 'running') return { label: '运行中', tone: 'success' }
  if (status === 'stopping') return { label: '停止中', tone: 'warning' }
  if (status === 'completed') return { label: '已完成', tone: 'neutral' }
  if (status === 'failed') return { label: '失败', tone: 'error' }
  return { label: status ? '已停止' : '未启动', tone: 'neutral' }
}

function Address({
  host,
  title,
  url
}: {
  host: BrowserPluginHost
  title: string
  url: string
}): React.JSX.Element {
  const address = new URL(url)
  return (
    <div className="remote-debug-access-row" role="group" aria-label={`${title}地址`}>
      <span className="remote-debug-caption">{title}</span>
      <a
        className="remote-debug-access-link"
        href={url}
        title={url}
        aria-label={url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="remote-debug-access-host">{address.hostname}</span>
        {address.port ? <span>:{address.port}</span> : null}
      </a>
      <div className="remote-debug-address-actions">
        <CopyButton host={host} value={url} />
        <PluginButton
          size="sm"
          variant="secondary"
          onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
        >
          打开
        </PluginButton>
      </div>
    </div>
  )
}

export function ProfileCard({
  profile,
  cwd,
  latest,
  active,
  pending,
  host,
  locale,
  timeZone,
  onStart,
  onRestart,
  onStop,
  onSendFailure
}: {
  profile: RemoteDebugProjectProfile
  cwd: string
  latest: RemoteDebugRun | null
  active: RemoteDebugRun | null
  pending: string | null
  host: BrowserPluginHost
  locale: string
  timeZone: string
  onStart(): void
  onRestart(run: RemoteDebugRun): void
  onStop(run: RemoteDebugRun): void
  onSendFailure(run: RemoteDebugRun): void
}): React.JSX.Element {
  const [details, setDetails] = useState(false)
  const [logs, setLogs] = useState(false)
  const run = active ?? latest
  const status = statusPresentation(run?.status)
  const restarting = pending === `restart:${cwd}:${profile.name}`
  const localUrl = active?.status !== 'stopping' ? active?.localUrl : null
  const publicUrl = active?.status === 'running' ? active.publicUrl : null
  return (
    <PluginCard
      density="compact"
      className="remote-debug-profile-card"
      data-remote-debug-profile={profile.name}
      data-remote-debug-run-id={run?.runId}
    >
      <div className="remote-debug-profile-head">
        <div className="remote-debug-profile-summary">
          <span className="remote-debug-profile-name">{profile.name}</span>
          {profile.description ? (
            <span className="remote-debug-profile-description">{profile.description}</span>
          ) : null}
        </div>
        <PluginBadge tone={status.tone} role="status">
          {status.label}
        </PluginBadge>
        <PluginButton
          size="sm"
          variant="ghost"
          aria-label={details ? '收起详情' : '查看详情'}
          aria-expanded={details}
          onClick={() => setDetails((value) => !value)}
        >
          {details ? '收起' : '详情'}
        </PluginButton>
        {active ? (
          <>
            <PluginButton
              variant="secondary"
              disabled={pending !== null || active.status === 'stopping'}
              onClick={() => onRestart(active)}
            >
              {restarting ? '重启中…' : '重启'}
            </PluginButton>
            <PluginButton
              variant="danger"
              disabled={pending !== null || active.status === 'stopping'}
              onClick={() => onStop(active)}
            >
              {active.status === 'stopping' || pending === `stop:${active.runId}`
                ? '停止中…'
                : '停止'}
            </PluginButton>
          </>
        ) : (
          <PluginButton variant="primary" disabled={pending !== null} onClick={onStart}>
            {restarting
              ? '重启中…'
              : pending === `start:${cwd}:${profile.name}`
                ? '启动中…'
                : latest
                  ? '重新启动'
                  : '启动'}
          </PluginButton>
        )}
      </div>
      {localUrl ? <Address host={host} title="本地" url={localUrl} /> : null}
      {publicUrl ? <Address host={host} title="远程" url={publicUrl} /> : null}
      {details ? (
        <div className="remote-debug-details">
          <PluginKeyValueList density="compact" layout="stacked">
            <PluginKeyValueItem label="名称" value={profile.name} />
            {profile.description ? (
              <PluginKeyValueItem label="简述" value={profile.description} />
            ) : null}
            {localUrl ? (
              <PluginKeyValueItem
                label="本地地址"
                value={<span className="remote-debug-code">{localUrl}</span>}
              />
            ) : null}
            {publicUrl ? (
              <PluginKeyValueItem
                label="远程地址"
                value={<span className="remote-debug-code">{publicUrl}</span>}
              />
            ) : null}
            <PluginKeyValueItem
              label="配置命令"
              value={<span className="remote-debug-code">{profile.command}</span>}
            />
            <PluginKeyValueItem
              label="项目目录"
              value={
                <div className="remote-debug-path">
                  {cwd} <CopyButton host={host} value={cwd} />
                </div>
              }
            />
            <PluginKeyValueItem
              label="配置路由"
              value={
                <div className="remote-debug-code">
                  {[{ path: '/', targetPort: profile.entryPort }, ...profile.routes]
                    .map((route) => `${route.path} → 127.0.0.1:${route.targetPort}`)
                    .join('\n')}
                </div>
              }
            />
            {run ? (
              <PluginKeyValueItem
                label="时间"
                value={`开始 ${formatRemoteDebugTime(run.startedAt, locale, timeZone)} · 结束 ${formatRemoteDebugTime(run.endedAt, locale, timeZone)}`}
              />
            ) : null}
          </PluginKeyValueList>
          {run?.failure ? (
            <>
              <div className="remote-debug-code" style={{ color: 'var(--destructive)' }}>
                {run.failure.message}
              </div>
              <PluginActionRow>
                <CopyButton host={host} value={run.failure.message} label="复制错误" />
                <PluginButton
                  size="sm"
                  variant="secondary"
                  disabled={pending !== null}
                  onClick={() => onSendFailure(run)}
                >
                  {pending === `ai:${run.runId}` ? '发送中…' : '发送给 AI'}
                </PluginButton>
              </PluginActionRow>
            </>
          ) : null}
          {run ? (
            <>
              <PluginActionRow>
                <PluginButton
                  size="sm"
                  variant="secondary"
                  aria-expanded={logs}
                  onClick={() => setLogs((value) => !value)}
                >
                  {logs ? '收起日志' : '查看日志'}
                </PluginButton>
              </PluginActionRow>
              {logs ? (
                <PluginLogViewer key={run.runId} className="remote-debug-log" path={run.logPath} />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </PluginCard>
  )
}
