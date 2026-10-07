import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode
} from 'react'
import type {
  BrowserPluginHost,
  BrowserPluginLogHandle,
  BrowserPluginLogSnapshot
} from './browser.js'
import { PluginButton, PluginScroll, PluginSurface } from './react-ui.tsx'

const PluginHostContext = createContext<BrowserPluginHost | null>(null)

const EMPTY_LOG_SNAPSHOT: BrowserPluginLogSnapshot = {
  text: '',
  truncated: false,
  loading: true,
  error: null
}

const PLUGIN_LOG_STYLES = `
.pi-desk-ui-log{position:relative;display:flex;min-width:0;height:18rem;max-height:min(18rem,50dvh);flex-direction:column;overflow:hidden;border:1px solid var(--pi-desk-plugin-border,var(--border));border-radius:.5rem;background:var(--pi-desk-plugin-background,var(--background));color:var(--pi-desk-plugin-foreground,var(--foreground))}
.pi-desk-ui-log-status{display:flex;min-height:2rem;flex-shrink:0;align-items:center;justify-content:space-between;gap:.75rem;border-bottom:1px solid var(--pi-desk-plugin-border,var(--border));padding:.35rem .65rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.75rem;line-height:1.5}
.pi-desk-ui-log-scroll{min-height:0;flex:1}
.pi-desk-ui-log-scroll-viewport{padding:.75rem;overscroll-behavior:contain}
.pi-desk-ui-log-content{margin:0;min-width:100%;font:.875rem/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.pi-desk-ui-log-empty{display:grid;min-height:100%;place-items:center;padding:1rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.875rem;text-align:center}
.pi-desk-ui-log-error{display:flex;flex-shrink:0;align-items:center;justify-content:space-between;gap:.75rem;border-top:1px solid color-mix(in srgb,var(--pi-desk-plugin-destructive,var(--destructive)) 35%,var(--pi-desk-plugin-border,var(--border)));padding:.45rem .65rem;background:color-mix(in srgb,var(--pi-desk-plugin-destructive,var(--destructive)) 8%,transparent);color:var(--pi-desk-plugin-destructive,var(--destructive));font-size:.75rem}
.pi-desk-ui-log-bottom{position:absolute;right:.65rem;bottom:.65rem;box-shadow:0 4px 16px color-mix(in srgb,var(--pi-desk-plugin-foreground,var(--foreground)) 16%,transparent)}
@media(max-width:640px){.pi-desk-ui-log{height:14rem;max-height:45dvh}.pi-desk-ui-log-scroll-viewport{padding:.65rem}}
`

function classNames(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(' ')
}

export interface PluginHostProviderProps {
  host: BrowserPluginHost
  children: ReactNode
}

export function PluginHostProvider({ host, children }: PluginHostProviderProps): React.JSX.Element {
  return <PluginHostContext.Provider value={host}>{children}</PluginHostContext.Provider>
}

export function usePluginHost(): BrowserPluginHost {
  const host = useContext(PluginHostContext)
  if (!host) throw new Error('PluginLogViewer 必须位于 PluginHostProvider 内')
  return host
}

interface PluginLogState {
  path: string
  snapshot: BrowserPluginLogSnapshot
}

function usePluginLog(path: string): {
  snapshot: BrowserPluginLogSnapshot
  retry(): void
} {
  const host = usePluginHost()
  const handleRef = useRef<{ path: string; handle: BrowserPluginLogHandle } | null>(null)
  const [state, setState] = useState<PluginLogState>({
    path,
    snapshot: EMPTY_LOG_SNAPSHOT
  })

  useEffect(() => {
    const handle = host.logs.open(path)
    handleRef.current = { path, handle }
    const update = (): void => {
      setState({ path, snapshot: handle.getSnapshot() })
    }
    update()
    const unsubscribe = handle.subscribe(update)
    return (): void => {
      unsubscribe()
      handle.dispose()
      if (handleRef.current?.handle === handle) handleRef.current = null
    }
  }, [host.logs, path])

  return {
    snapshot: state.path === path ? state.snapshot : EMPTY_LOG_SNAPSHOT,
    retry: () => {
      const current = handleRef.current
      if (current?.path === path) current.handle.retry()
    }
  }
}

export interface PluginLogViewerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  path: string
}

function PluginLogViewerContent({
  path,
  className,
  ...props
}: PluginLogViewerProps): React.JSX.Element {
  const { snapshot, retry } = usePluginLog(path)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(true)
  const [following, setFollowing] = useState(true)

  const scrollToBottom = useCallback((): void => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    followRef.current = true
    setFollowing(true)
  }, [])

  useEffect(() => {
    if (followRef.current) scrollToBottom()
  }, [scrollToBottom, snapshot.text])

  const handleScroll = (): void => {
    const element = scrollRef.current
    if (!element) return
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
    followRef.current = atBottom
    setFollowing(atBottom)
  }

  const status = snapshot.truncated
    ? '日志较长，当前仅显示末尾内容'
    : snapshot.loading && snapshot.text
      ? '正在同步日志…'
      : null

  return (
    <PluginSurface
      {...props}
      data-pi-desk-plugin-log-viewer=""
      className={classNames('pi-desk-ui-log', className)}
    >
      <style>{PLUGIN_LOG_STYLES}</style>
      {status ? (
        <div className="pi-desk-ui-log-status" role="status">
          <span>{status}</span>
        </div>
      ) : null}
      <PluginScroll
        viewportRef={scrollRef}
        className="pi-desk-ui-log-scroll"
        viewportClassName="pi-desk-ui-log-scroll-viewport"
        onScroll={handleScroll}
      >
        {snapshot.text ? (
          <pre className="pi-desk-ui-log-content">{snapshot.text}</pre>
        ) : (
          <div className="pi-desk-ui-log-empty" role="status">
            {snapshot.loading ? '正在加载日志…' : '等待日志输出…'}
          </div>
        )}
      </PluginScroll>
      {snapshot.error ? (
        <div className="pi-desk-ui-log-error" role="alert">
          <span>{snapshot.error}</span>
          <PluginButton size="sm" onClick={retry}>
            重试
          </PluginButton>
        </div>
      ) : null}
      {!following && snapshot.text ? (
        <PluginButton size="sm" className="pi-desk-ui-log-bottom" onClick={scrollToBottom}>
          回到底部
        </PluginButton>
      ) : null}
    </PluginSurface>
  )
}

export function PluginLogViewer(props: PluginLogViewerProps): React.JSX.Element {
  return <PluginLogViewerContent key={props.path} {...props} />
}
