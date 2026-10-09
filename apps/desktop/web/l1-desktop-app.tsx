import { useCallback, useEffect, useRef, useState } from 'react'
import { useControlState } from './l4-control-state'
import { ControlPage } from './l2-control-page'
import { SettingsPage } from './l2-settings-page'
import { AccessPage } from './l2-access-page'
import { useDesktopAction } from './hooks/l2-use-desktop-action'
import { runDesktopAction } from './l2-desktop-biz'

type Route =
  | { mode: 'control' }
  | { mode: 'target'; url: string | null; advanced: boolean }
  | { mode: 'settings'; url: string | null }
  | { mode: 'access'; url: string }

function routeFromHash(hash: string): Route {
  if (hash.startsWith('#/access?')) {
    const url = new URLSearchParams(hash.slice(hash.indexOf('?') + 1)).get('url')
    if (url) return { mode: 'access', url }
  }
  if (hash.startsWith('#/settings/target')) {
    const [path, query] = hash.slice(1).split('?', 2)
    if (path === '/settings/target') {
      const params = new URLSearchParams(query)
      return { mode: 'target', url: params.get('url'), advanced: params.get('advanced') === '1' }
    }
  }
  const [path, query] = hash.slice(1).split('?', 2)
  if (path === '/settings') {
    return { mode: 'settings', url: new URLSearchParams(query).get('url') }
  }
  return { mode: 'control' }
}

export function DesktopApp(): React.JSX.Element {
  const [route, setRoute] = useState<Route>(() => routeFromHash(location.hash))
  const dirty = useRef(false)
  const acceptedHash = useRef(location.hash)
  const { state, readError, refreshing, refresh } = useControlState()
  const launch = useDesktopAction(refresh)

  useEffect(() => {
    const onHashChange = (): void => {
      if (location.hash === acceptedHash.current) return
      if (dirty.current && !window.confirm('未保存的更改将丢失，确定离开吗？')) {
        location.hash = acceptedHash.current || '#/'
        return
      }
      dirty.current = false
      acceptedHash.current = location.hash
      setRoute(routeFromHash(location.hash))
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
  }, [])

  const navigate = useCallback((hash: string): void => {
    if (hash === location.hash) return
    if (dirty.current && !window.confirm('未保存的更改将丢失，确定离开吗？')) return
    dirty.current = false
    acceptedHash.current = hash
    location.hash = hash
    setRoute(routeFromHash(hash))
  }, [])

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
      key={route.url}
      url={route.url}
      target={state?.targets.find((target) => target.url === route.url)}
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
