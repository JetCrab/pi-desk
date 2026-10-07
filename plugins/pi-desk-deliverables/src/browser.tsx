import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  copyBrowserText,
  type BrowserPluginHost,
  type BrowserSessionSidebarTabImplementation,
  type BrowserSessionSidebarTabTarget,
  type PluginJsonObject,
  type PluginSource
} from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginAlert,
  PluginButton,
  PluginContextMenu,
  PluginContextMenuContent,
  PluginContextMenuItem,
  PluginContextMenuTrigger,
  PluginEmptyState,
  PluginErrorBoundary,
  PluginScroll,
  PluginSurface
} from '@jetcrab/pi-desk-sdk/react/base'
import { parseDeliverableBatch, subscribeDeliverablePush } from './browser-runtime.js'
import type { DeliverableBatch, DeliverableListResult } from './contract.js'

const STYLES = `
.deliverables{display:flex;height:100%;min-height:0;flex-direction:column;background:var(--pi-desk-plugin-background,var(--background))}
.deliverables-head{display:grid;gap:.15rem;border-bottom:1px solid var(--pi-desk-plugin-border,var(--border));padding:.7rem .75rem}
.deliverables-title{font-size:.875rem;font-weight:600}.deliverables-muted,.deliverables-path{color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.75rem;line-height:1.5}
.deliverables-body{min-height:0;flex:1}.deliverables-body-viewport{display:grid;min-height:0;align-content:start;gap:.75rem;padding:.75rem}
.deliverables-batch{display:grid;gap:.25rem;border-bottom:1px solid var(--border);padding-bottom:.5rem}.deliverables-batch:last-child{border-bottom:0}.deliverables-item{display:grid;width:100%;min-height:3.5rem;grid-template-columns:1.5rem minmax(0,1fr);align-items:center;gap:.5rem;border:0;border-radius:.5rem;background:transparent;padding:.5rem;color:inherit;font:inherit;text-align:left;cursor:pointer}
.deliverables-item:hover{background:var(--pi-desk-plugin-muted,var(--muted))}.deliverables-item:focus-visible{outline:2px solid var(--pi-desk-plugin-ring,var(--ring));outline-offset:1px}.deliverables-icon{display:grid;width:1.5rem;height:1.5rem;place-items:center;border-radius:.42rem;background:var(--pi-desk-plugin-muted,var(--muted));color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.deliverables-icon svg{width:1rem;height:1rem}.deliverables-icon-image,.deliverables-icon-html{background:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 14%,transparent);color:var(--pi-desk-plugin-primary,var(--primary))}.deliverables-copy{display:grid;min-width:0;gap:.08rem}.deliverables-name,.deliverables-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.deliverables-name{font-size:.875rem;font-weight:500}
.deliverables-more{justify-self:center}

`

type DeliverableFileKind = 'image' | 'html' | 'text'

function absoluteFileAddress(cwd: string, path: string): string {
  const windowsPath = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')
  const separator = windowsPath ? '\\' : '/'
  const normalizedCwd = windowsPath ? cwd.replaceAll('/', '\\') : cwd
  const root = normalizedCwd.replace(/[\\/]+$/, '')
  return `${root}${separator}${path.replaceAll('/', separator)}`
}

function isTouchMenuEvent(event: Event): boolean {
  return (
    (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) ||
    (typeof PointerEvent !== 'undefined' &&
      event instanceof PointerEvent &&
      event.pointerType === 'touch')
  )
}

function deliverableFileKind(path: string): DeliverableFileKind {
  const extension = path.split('/').at(-1)?.split('.').at(-1)?.toLowerCase()
  if (
    extension === 'png' ||
    extension === 'jpg' ||
    extension === 'jpeg' ||
    extension === 'gif' ||
    extension === 'webp'
  ) {
    return 'image'
  }
  return extension === 'html' || extension === 'htm' ? 'html' : 'text'
}

function deliverableFileLabel(kind: DeliverableFileKind): string {
  if (kind === 'image') return '图片'
  if (kind === 'html') return 'HTML'
  return '文本'
}

function DeliverableFileIcon({ kind }: { kind: DeliverableFileKind }): React.JSX.Element {
  if (kind === 'image') {
    return (
      <svg
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        viewBox="0 0 24 24"
      >
        <rect height="16" rx="2" width="18" x="3" y="4" />
        <circle cx="8.5" cy="9" r="1.25" />
        <path d="m3 17 5-5 3.5 3.5 2.5-2.5L21 20" />
      </svg>
    )
  }
  if (kind === 'html') {
    return (
      <svg
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        viewBox="0 0 24 24"
      >
        <path d="m9 18-6-6 6-6M15 6l6 6-6 6M14 4l-4 16" />
      </svg>
    )
  }
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </svg>
  )
}

function sameSource(left: PluginSource, right: PluginSource): boolean {
  return (
    left.workId === right.workId &&
    left.sessionId === right.sessionId &&
    left.branchId === right.branchId
  )
}

function parseListResult(value: PluginJsonObject): DeliverableListResult {
  const deliveries = Array.isArray(value.deliveries)
    ? value.deliveries.flatMap((item) => {
        const delivery = parseDeliverableBatch(item)
        return delivery ? [delivery] : []
      })
    : []
  return {
    deliveries,
    hasMore: value.hasMore === true
  }
}

function prependDelivery(
  current: readonly DeliverableBatch[],
  delivery: DeliverableBatch
): DeliverableBatch[] {
  return current.some((item) => item.entryId === delivery.entryId)
    ? [...current]
    : [delivery, ...current]
}

function DeliverablesView({
  target,
  host,
  signal
}: {
  target: BrowserSessionSidebarTabTarget
  host: BrowserPluginHost
  signal: AbortSignal
}): React.JSX.Element {
  const [deliveries, setDeliveries] = useState<DeliverableBatch[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestEpoch = useRef(0)
  const pendingPushes = useRef<DeliverableBatch[]>([])
  const loadingSnapshot = useRef(true)
  const suppressTouchClickRef = useRef(false)

  const loadSnapshot = useCallback(async (): Promise<void> => {
    const epoch = ++requestEpoch.current
    loadingSnapshot.current = true
    pendingPushes.current = []
    setLoadingMore(false)
    setLoading(true)
    setError(null)
    try {
      const result = parseListResult(
        await host.piDesk.invokeSession(target.source, 'list', { limit: 20 })
      )
      if (signal.aborted || epoch !== requestEpoch.current) return
      let next = result.deliveries
      for (const delivery of pendingPushes.current) next = prependDelivery(next, delivery)
      setDeliveries(next)
      setHasMore(result.hasMore)
    } catch (cause) {
      if (!signal.aborted && epoch === requestEpoch.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (!signal.aborted && epoch === requestEpoch.current) {
        loadingSnapshot.current = false
        pendingPushes.current = []
        setLoading(false)
      }
    }
  }, [host, signal, target.source])

  useEffect(() => {
    let active = true
    const unsubscribePush = subscribeDeliverablePush((event) => {
      if (!active || !sameSource(event.source, target.source)) return
      if (loadingSnapshot.current) {
        if (!pendingPushes.current.some((item) => item.entryId === event.delivery.entryId)) {
          pendingPushes.current.push(event.delivery)
        }
        return
      }
      setDeliveries((current) => prependDelivery(current, event.delivery))
    })
    const unsubscribeConnection = host.connection.subscribe(() => {
      if (host.connection.getSnapshot().status === 'ready') void loadSnapshot()
    })
    queueMicrotask(() => {
      if (active) void loadSnapshot()
    })
    return () => {
      active = false
      requestEpoch.current += 1
      unsubscribeConnection()
      unsubscribePush()
    }
  }, [host, loadSnapshot, target.source])

  const consumeSuppressedTouchClick = (): boolean => {
    if (!suppressTouchClickRef.current) return false
    suppressTouchClickRef.current = false
    return true
  }

  const copyAddress = (path: string): void => {
    suppressTouchClickRef.current = false
    const address = absoluteFileAddress(target.cwd, path)
    void copyBrowserText(address).then((copied) => {
      host.notify(
        copied
          ? { level: 'success', title: '已复制文件地址', description: address }
          : { level: 'error', title: '复制文件地址失败' }
      )
    })
  }

  const revealFile = (path: string): void => {
    suppressTouchClickRef.current = false
    void target.files.reveal(path).catch((cause: unknown) => {
      host.notify({
        level: 'error',
        title: '打开所在文件夹失败',
        description: cause instanceof Error ? cause.message : String(cause)
      })
    })
  }

  const loadMore = (): void => {
    const cursor = deliveries.at(-1)?.entryId
    if (!cursor || loadingMore || loadingSnapshot.current || !hasMore) return
    const epoch = requestEpoch.current
    setLoadingMore(true)
    setError(null)
    void host.piDesk
      .invokeSession(target.source, 'list', {
        limit: 20,
        beforeEntryId: cursor
      })
      .then((value) => {
        if (signal.aborted || epoch !== requestEpoch.current) return
        const result = parseListResult(value)
        setDeliveries((current) => {
          const known = new Set(current.map((delivery) => delivery.entryId))
          return [
            ...current,
            ...result.deliveries.filter((delivery) => !known.has(delivery.entryId))
          ]
        })
        setHasMore(result.hasMore)
      })
      .catch((cause: unknown) => {
        if (!signal.aborted && epoch === requestEpoch.current)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!signal.aborted && epoch === requestEpoch.current) setLoadingMore(false)
      })
  }

  return (
    <PluginSurface className="deliverables">
      <style>{STYLES}</style>
      <header className="deliverables-head">
        <span className="deliverables-title">交付物</span>
        <span className="deliverables-muted">当前会话分支 · 最新交付排在最前</span>
      </header>
      <PluginScroll
        className="deliverables-body"
        viewportClassName="deliverables-body-viewport"
        aria-label="交付物列表"
      >
        {error ? <PluginAlert tone="error">{error}</PluginAlert> : null}
        {loading && deliveries.length === 0 ? (
          <PluginEmptyState>正在读取交付物…</PluginEmptyState>
        ) : deliveries.length === 0 ? (
          <PluginEmptyState>当前会话还没有交付物</PluginEmptyState>
        ) : (
          deliveries.map((delivery) => (
            <div className="deliverables-batch" key={delivery.entryId}>
              {delivery.items.map((item, index) => {
                const kind = deliverableFileKind(item.path)
                const label = deliverableFileLabel(kind)
                return (
                  <PluginContextMenu
                    key={`${delivery.entryId}:${index}`}
                    onOpenChange={(open, details) => {
                      if (open && isTouchMenuEvent(details.event)) {
                        suppressTouchClickRef.current = true
                      } else if (!open) suppressTouchClickRef.current = false
                    }}
                  >
                    <PluginContextMenuTrigger
                      render={
                        <button
                          type="button"
                          aria-label={`打开${label}：${item.title}`}
                          className="deliverables-item"
                          title={`${item.title} · ${item.path}`}
                          onClick={() => {
                            if (consumeSuppressedTouchClick()) return
                            target.files.preview(item.path, {
                              mode: 'standalone',
                              ...(kind === 'image'
                                ? {
                                    imagePaths: deliveries.flatMap((batch) =>
                                      batch.items
                                        .filter(
                                          (file) => deliverableFileKind(file.path) === 'image'
                                        )
                                        .map((file) => file.path)
                                    )
                                  }
                                : {})
                            })
                          }}
                        >
                          <span className={`deliverables-icon deliverables-icon-${kind}`}>
                            <DeliverableFileIcon kind={kind} />
                          </span>
                          <span className="deliverables-copy">
                            <span className="deliverables-name">{item.title}</span>
                            <span className="deliverables-path">{item.path}</span>
                          </span>
                        </button>
                      }
                    />
                    <PluginContextMenuContent>
                      <PluginContextMenuItem
                        data-testid={`deliverable-copy-address-${delivery.entryId}-${index}`}
                        onClick={() => copyAddress(item.path)}
                      >
                        复制地址
                      </PluginContextMenuItem>
                      <PluginContextMenuItem
                        data-testid={`deliverable-reveal-${delivery.entryId}-${index}`}
                        onClick={() => revealFile(item.path)}
                      >
                        打开所在文件夹
                      </PluginContextMenuItem>
                    </PluginContextMenuContent>
                  </PluginContextMenu>
                )
              })}
            </div>
          ))
        )}
        {hasMore ? (
          <PluginButton
            className="deliverables-more"
            variant="secondary"
            disabled={loadingMore}
            onClick={loadMore}
          >
            {loadingMore ? '加载中…' : '加载更早交付物'}
          </PluginButton>
        ) : null}
      </PluginScroll>
    </PluginSurface>
  )
}

const implementation: BrowserSessionSidebarTabImplementation = {
  mount({ container, target, host, signal }) {
    const root = createRoot(container)
    root.render(
      <PluginErrorBoundary>
        <DeliverablesView target={target} host={host} signal={signal} />
      </PluginErrorBoundary>
    )
    return (): void => root.unmount()
  }
}

export default implementation
