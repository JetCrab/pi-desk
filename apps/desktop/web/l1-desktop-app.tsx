import { useCallback, useEffect, useRef, useState } from 'react'
import { useControlState } from './l4-control-state'
import { ControlPage } from './l2-control-page'
import { SettingsPage } from './l2-settings-page'
import { AccessPage } from './l2-access-page'
import { useDesktopAction } from './hooks/l2-use-desktop-action'
import { runDesktopAction } from './l2-desktop-biz'
import { DesktopConfirmProvider, useDesktopConfirm } from './l4-desktop-confirm'

type Route =
  | { mode: 'control' }
  | { mode: 'target'; url: string | null; advanced: boolean }
  | { mode: 'settings'; url: string | null }
  | { mode: 'access'; port: number | null }

function routeFromHash(hash: string): Route {
  const [path, query] = hash.slice(1).split('?', 2)
  if (path === '/access') {
    const port = Number(new URLSearchParams(query).get('port'))
    return {
      mode: 'access',
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
    }
  }
  if (hash.startsWith('#/settings/target')) {
    const [path, query] = hash.slice(1).split('?', 2)
    if (path === '/settings/target') {
      const params = new URLSearchParams(query)
      return { mode: 'target', url: params.get('url'), advanced: params.get('advanced') === '1' }
    }
  }
  if (path === '/settings') {
    return { mode: 'settings', url: new URLSearchParams(query).get('url') }
  }
  return { mode: 'control' }
}

export function DesktopApp(): React.JSX.Element {
  return (
    <DesktopConfirmProvider>
      <DesktopRoutes />
    </DesktopConfirmProvider>
  )
}

function DesktopRoutes(): React.JSX.Element {
  const confirm = useDesktopConfirm()
  const [route, setRoute] = useState<Route>(() => routeFromHash(location.hash))
  const dirty = useRef(false)
  const acceptedHash = useRef(location.hash)
  const navigationPending = useRef(false)
  const { state, readError, refreshing, refresh } = useControlState()
  const launch = useDesktopAction(refresh)

  const navigate = useCallback(
    (hash: string): void => {
      if (hash === acceptedHash.current || navigationPending.current) return
      navigationPending.current = true
      void (async (): Promise<void> => {
        try {
          if (
            dirty.current &&
            !(await confirm({
              title: '离开当前页面？',
              description: '未保存的更改将丢失，确定离开吗？',
              confirmLabel: '放弃更改并离开',
              danger: true
            }))
          )
            return
          dirty.current = false
          acceptedHash.current = hash
          location.hash = hash
          setRoute(routeFromHash(hash))
        } finally {
          navigationPending.current = false
        }
      })()
    },
    [confirm]
  )

  useEffect(() => {
    const onHashChange = (): void => {
      const nextHash = location.hash
      if (nextHash === acceptedHash.current) return
      // 异步确认期间保持原页面和地址，取消不会丢弃表单草稿。
      history.replaceState(null, '', acceptedHash.current || '#/')
      navigate(nextHash)
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirty.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('hashchange', onHashChange)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('hashchange', onHashChange)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [navigate])

  const onSaved = (openUrl?: string): void => {
    dirty.current = false
    refresh()
    navigate('#/')
    if (openUrl) void launch.run(() => runDesktopAction('open', openUrl))
  }

  return route.mode === 'control' ? (
    <ControlPage
      state={state}
      readError={readError}
      openError={launch.error}
      dismissOpenError={launch.clearError}
      refreshing={refreshing}
      refresh={refresh}
      navigate={navigate}
      onDirty={(value) => {
        dirty.current = value
      }}
    />
  ) : route.mode === 'access' ? (
    <AccessPage
      key={route.port}
      port={route.port}
      localUrls={state?.targets.map((row) => row.url) ?? []}
      tunnel={state?.tunnel}
      readError={readError}
      refresh={refresh}
      onDirty={(value) => {
        dirty.current = value
      }}
      onBack={() => navigate('#/')}
    />
  ) : (
    <SettingsPage
      key={`${route.mode}:${route.url ?? ''}`}
      state={state}
      readError={readError}
      refresh={refresh}
      global={route.mode === 'settings'}
      onSelectTarget={(url) => navigate(`#/settings?url=${encodeURIComponent(url)}`)}
      originalUrl={route.url}
      localTarget={Boolean(state?.targets.find((target) => target.url === route.url)?.server)}
      initialAdvanced={route.mode === 'target' && route.advanced}
      onDirty={(value) => {
        dirty.current = value
      }}
      onSaved={onSaved}
      onBack={() => navigate('#/')}
    />
  )
}
