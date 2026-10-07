import { useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  BrowserMessageHandle,
  BrowserMessageViewImplementation,
  BrowserPluginHost
} from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginAlert,
  PluginButton,
  PluginCard,
  PluginErrorBoundary,
  PluginScroll,
  PluginSurface,
  useMessageDetail,
  useMessageHandle
} from '@jetcrab/pi-desk-sdk/react/base'
import { PluginMarkdown } from '@jetcrab/pi-desk-sdk/react/markdown'

const SUBAGENT_MESSAGE_STYLES = `
.subagent-message{width:100%;min-width:0;container-type:inline-size}
.subagent-message .subagent-message-card{padding:0;overflow:hidden;border-radius:.5rem;font-size:.875rem;line-height:1.5}
.subagent-message .subagent-message-card-error{border-color:color-mix(in srgb,var(--destructive) 55%,var(--border))}
.subagent-message-header{display:grid;width:100%;grid-template-columns:1rem minmax(0,1fr) auto;align-items:start;gap:.5rem;border:0;padding:.625rem .75rem;background:transparent;color:inherit;text-align:left;font:inherit}
button.subagent-message-header{cursor:pointer}
button.subagent-message-header:hover{background:var(--pi-desk-plugin-muted,var(--muted))}
.subagent-message-header:focus-visible{outline:2px solid var(--pi-desk-plugin-ring,var(--ring));outline-offset:-2px}
.subagent-message-agent-icon{width:1rem;height:1rem;margin-top:.125rem;color:var(--foreground)}
.subagent-message-headline{display:flex;min-width:0;flex-wrap:wrap;align-items:center;gap:.25rem .5rem}
.subagent-message-name{font-weight:600}
.subagent-message-type{border-radius:.25rem;background:var(--pi-desk-plugin-muted,var(--muted));padding:0 .375rem;font-size:.75rem;font-weight:500}
.subagent-message-action{color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.75rem}
.subagent-message-status{display:flex;align-items:center;justify-content:flex-end;gap:.375rem;white-space:nowrap;font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.subagent-message-status-success{color:var(--status-success,var(--foreground))}
.subagent-message-status-warning{color:var(--status-warning,var(--foreground))}
.subagent-message-status-error{color:var(--pi-desk-plugin-destructive,var(--destructive))}
.subagent-message-status-running::before{content:"";width:.625rem;height:.625rem;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:subagent-message-spin .8s linear infinite}
.subagent-message-list .subagent-message-status-running::before{content:none;animation:none}
.subagent-message-chevron{width:.875rem;height:.875rem;transition:transform .15s}
.subagent-message-chevron[data-open="true"]{transform:rotate(180deg)}
.subagent-message-task{grid-column:2/-1;display:flex;min-width:0;align-items:baseline;gap:.5rem}
.subagent-message-title{min-width:0;flex:1;overflow-wrap:anywhere;font-weight:500}
.subagent-message-id{flex-shrink:0;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.75rem}
.subagent-message-preview{grid-column:2/-1;display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));overflow-wrap:anywhere}
.subagent-message-error{grid-column:2/-1;color:var(--pi-desk-plugin-destructive,var(--destructive));overflow-wrap:anywhere}
.subagent-message-detail{border-top:1px solid var(--pi-desk-plugin-border,var(--border));padding:.75rem}
.subagent-message-detail-label{margin:0 0 .5rem;font:inherit;font-weight:600}
.subagent-message-meta{display:flex;flex-wrap:wrap;gap:.25rem .5rem;margin:0;padding:.5rem .75rem;border-top:1px solid var(--pi-desk-plugin-border,var(--border));font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.subagent-message-meta code{overflow-wrap:anywhere}
.subagent-message-detail-scroll{max-height:min(20rem,45dvh)}
.subagent-message-detail-scroll-viewport{padding-right:.25rem;overscroll-behavior:contain}
.subagent-message-output{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
.subagent-records{list-style:none;margin:0;padding:0 .75rem;border-top:1px solid var(--pi-desk-plugin-border,var(--border))}
.subagent-record{padding:.625rem 0}.subagent-record+.subagent-record{border-top:1px solid var(--pi-desk-plugin-border,var(--border))}
.subagent-record-head{display:flex;align-items:baseline;gap:.75rem}
.subagent-record-title{min-width:0;flex:1;overflow-wrap:anywhere;font-weight:500}
.subagent-record-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem .5rem;margin-top:.25rem;font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.subagent-record-meta code{overflow-wrap:anywhere}
.subagent-record-meta time{margin-left:auto;font-variant-numeric:tabular-nums}
.subagent-records-scroll{max-height:min(24rem,55dvh)}
.subagent-records-more{border-top:1px solid var(--pi-desk-plugin-border,var(--border));padding:.25rem .75rem}
@keyframes subagent-message-spin{to{transform:rotate(360deg)}}
@container(max-width:22rem){.subagent-message-task{flex-wrap:wrap}.subagent-message-title{flex-basis:100%}.subagent-message-id{font-size:.75rem}.subagent-record-head{gap:.5rem}}
@media(prefers-reduced-motion:reduce){.subagent-message-status-running::before{animation:none;border-style:dotted}.subagent-message-chevron{transition:none}}
`

type ViewKind = 'start' | 'return' | 'list' | 'control'
type Presentation = {
  label: string
  tone: 'normal' | 'success' | 'warning' | 'error' | 'running'
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function terminalPresentation(status: unknown): Presentation {
  if (status === 'completed') return { label: '已完成', tone: 'success' }
  if (status === 'failed' || status === 'error') return { label: '执行失败', tone: 'error' }
  if (status === 'interrupted' || status === 'aborted') return { label: '已中断', tone: 'warning' }
  if (status === 'stopped') return { label: '已停止', tone: 'warning' }
  return { label: '运行中', tone: 'running' }
}

function operationPresentation(
  kind: ViewKind,
  action: string | null,
  status: string | undefined,
  delivery: unknown
): Presentation {
  if (kind === 'return') return terminalPresentation(status)
  if (status === 'error' || status === 'failed')
    return { label: kind === 'list' ? '查询失败' : '请求失败', tone: 'error' }
  const done = status === 'completed'
  const label =
    kind === 'list'
      ? done
        ? '已查询'
        : '查询中'
      : action === 'stop'
        ? done
          ? '已请求停止'
          : '请求中'
        : action === 'steer'
          ? done
            ? delivery === 'queued'
              ? '已排队'
              : '已发送'
            : '发送中'
          : action === 'resume'
            ? done
              ? '已恢复运行'
              : '恢复中'
            : done
              ? '已启动'
              : '启动中'
  return { label, tone: done ? 'normal' : 'running' }
}

function errorText(error: string | null, action: string | null): string | null {
  if (error && /^Agent \S+ 当前不是 running$/u.test(error)) {
    return action === 'steer'
      ? '子代理当前未运行，无法补充要求。'
      : '子代理当前未运行，无法请求停止。'
  }
  if (error && /^Agent \S+ 仍在运行$/u.test(error)) {
    return '子代理仍在运行，无法再次启动。'
  }
  return error
}

function AgentRecords({
  records,
  region
}: {
  records: Record<string, unknown>[]
  region: { locale: string; timeZone: string }
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  const formatter = new Intl.DateTimeFormat(region.locale, {
    timeZone: region.timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
  return (
    <>
      <PluginScroll className="subagent-records-scroll" aria-label="子代理记录" id={listId}>
        <ol className="subagent-records">
          {(showAll ? records : records.slice(0, 3)).map((record, index) => {
            const taskId = stringValue(record.taskId)
            const status = terminalPresentation(record.status)
            return (
              <li className="subagent-record" key={taskId ?? index}>
                <div className="subagent-record-head">
                  <span className="subagent-record-title">
                    {stringValue(record.title) ?? '子代理任务'}
                  </span>
                  <span
                    className={`subagent-message-status subagent-message-status-${status.tone}`}
                  >
                    {status.label}
                  </span>
                </div>
                <div className="subagent-record-meta">
                  <span>{stringValue(record.agentType)}</span>
                  {taskId ? <code>{taskId}</code> : null}
                  {typeof record.startedAt === 'number' ? (
                    <time dateTime={new Date(record.startedAt).toISOString()}>
                      {formatter.format(record.startedAt)}
                    </time>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      </PluginScroll>
      {records.length > 3 ? (
        <div className="subagent-records-more">
          <PluginButton
            size="sm"
            variant="ghost"
            aria-expanded={showAll}
            aria-controls={listId}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? '收起记录' : `查看全部 ${records.length} 条`}
          </PluginButton>
        </div>
      ) : null}
    </>
  )
}

function SubagentMessage({
  kind,
  handle,
  host
}: {
  kind: ViewKind
  handle: BrowserMessageHandle
  host: BrowserPluginHost
}): React.JSX.Element {
  const snapshot = useMessageHandle(handle)
  const detail = useMessageDetail(handle)
  const region = useSyncExternalStore(
    (listener) => host.settings.subscribe(listener),
    () => host.settings.getSnapshot()
  ).region
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const action = stringValue(snapshot.summary.action)
  const agentType = stringValue(snapshot.summary.agentType)
  const taskId = stringValue(snapshot.summary.taskId)
  const query = stringValue(snapshot.summary.query)
  const error = stringValue(snapshot.summary.error)
  const records = Array.isArray(snapshot.summary.agents)
    ? snapshot.summary.agents.flatMap((value) => {
        const record = objectValue(value)
        return record ? [record] : []
      })
    : null
  const status = operationPresentation(
    kind,
    action,
    error
      ? 'error'
      : kind === 'return'
        ? (stringValue(snapshot.summary.status) ?? snapshot.fixed.status)
        : snapshot.fixed.status,
    snapshot.summary.delivery
  )
  const operation =
    kind === 'return'
      ? '返回结果'
      : kind === 'list'
        ? query
          ? '查询记录'
          : '最近记录'
        : action === 'resume'
          ? '继续执行'
          : action === 'stop'
            ? '请求停止'
            : action === 'steer'
              ? '补充要求'
              : '启动任务'
  const title =
    kind === 'list'
      ? records
        ? records.length > 0
          ? `共 ${records.length} 条子代理记录`
          : '暂无子代理记录'
        : query
          ? `子代理 ${query}`
          : '当前会话的子代理记录'
      : (stringValue(snapshot.summary.title) ?? '子代理任务')
  const preview = action === 'steer' ? stringValue(snapshot.summary.preview) : null
  const expandable = 'entryId' in snapshot.location && snapshot.fixed.hasDetail
  const detailObject = objectValue(detail.detail)
  const markdown = stringValue(detailObject?.markdown)
  const output = stringValue(detailObject?.output)
  const detailLabel =
    kind === 'start'
      ? action === 'resume'
        ? '追加要求'
        : '任务要求'
      : action === 'steer'
        ? '补充要求'
        : kind === 'return'
          ? '执行结果'
          : '查询结果'

  const loadDetail = (): void => {
    // Hook 已保留可重试错误，事件入口仍需接住拒绝，避免未处理的 Promise。
    void detail.load().catch((cause: unknown) => {
      console.warn('[子代理] 消息详情加载失败', { taskId, operation, error: cause })
    })
  }
  const toggle = (): void => {
    setOpen(!open)
    if (!open && detail.detail === undefined && !detail.loading) loadDetail()
  }
  const header = (
    <>
      <svg
        className="subagent-message-agent-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 8V4H8M4 12H2m20 0h-2" />
        <rect x="4" y="8" width="16" height="12" rx="2" />
        <path d="M9 12v2m6-2v2m-6 3h6" />
      </svg>
      <span className="subagent-message-headline">
        <span className="subagent-message-name">子代理</span>
        {agentType ? <span className="subagent-message-type">{agentType}</span> : null}
        <span className="subagent-message-action">{operation}</span>
      </span>
      <span className={`subagent-message-status subagent-message-status-${status.tone}`}>
        <span>{status.label}</span>
        {expandable ? (
          <svg
            className="subagent-message-chevron"
            data-open={open ? 'true' : 'false'}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        ) : null}
      </span>
      <span className="subagent-message-task">
        <span className="subagent-message-title">{title}</span>
        {taskId ? (
          <code className="subagent-message-id" title={taskId}>
            #{taskId.slice(0, 8)}
          </code>
        ) : null}
      </span>
      {preview ? <span className="subagent-message-preview">{preview}</span> : null}
      {error ? <span className="subagent-message-error">{errorText(error, action)}</span> : null}
    </>
  )

  return (
    <PluginSurface
      className={`subagent-message${kind === 'list' ? ' subagent-message-list' : ''}`}
      role="group"
      aria-label={`子代理${operation}消息`}
    >
      <style>{SUBAGENT_MESSAGE_STYLES}</style>
      <PluginCard className={`subagent-message-card subagent-message-card-${status.tone}`}>
        {expandable ? (
          <button
            type="button"
            className="subagent-message-header"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={`子代理${operation}：${title}`}
            onClick={toggle}
          >
            {header}
          </button>
        ) : (
          <div className="subagent-message-header">{header}</div>
        )}
        {records?.length ? <AgentRecords records={records} region={region} /> : null}
        {open && expandable ? (
          <div id={detailId}>
            <div className="subagent-message-detail">
              <h3 className="subagent-message-detail-label">{detailLabel}</h3>
              {detail.loading ? (
                <span role="status">正在加载详情…</span>
              ) : detail.error ? (
                <PluginAlert tone="error">
                  {detail.error.message}
                  <PluginButton size="sm" onClick={loadDetail}>
                    重试
                  </PluginButton>
                </PluginAlert>
              ) : markdown || output ? (
                <PluginScroll
                  className="subagent-message-detail-scroll"
                  viewportClassName="subagent-message-detail-scroll-viewport"
                  aria-label={detailLabel}
                >
                  {markdown ? (
                    <PluginMarkdown content={markdown} />
                  ) : (
                    <pre className="subagent-message-output">{output}</pre>
                  )}
                </PluginScroll>
              ) : (
                <span>暂无详情</span>
              )}
            </div>
            {taskId ? (
              <p className="subagent-message-meta">
                <span>子代理 ID</span>
                <code>{taskId}</code>
              </p>
            ) : null}
          </div>
        ) : null}
        {!snapshot.fixed.hasDetail && taskId ? (
          <p className="subagent-message-meta">
            <span>子代理 ID</span>
            <code>{taskId}</code>
          </p>
        ) : null}
      </PluginCard>
    </PluginSurface>
  )
}

function renderReact(
  container: HTMLElement,
  children: ReactNode,
  onError: (error: Error) => void
): () => void {
  const root = createRoot(container)
  root.render(<PluginErrorBoundary onError={onError}>{children}</PluginErrorBoundary>)
  return (): void => root.unmount()
}

function implementation(kind: ViewKind): BrowserMessageViewImplementation {
  return {
    mount({ container, target, host }) {
      return renderReact(
        container,
        <SubagentMessage kind={kind} handle={target.message} host={host} />,
        (error) => target.reportError(error)
      )
    }
  }
}

export const startMessageView = implementation('start')
export const returnMessageView = implementation('return')
export const listMessageView = implementation('list')
export const controlMessageView = implementation('control')
