'use client'

import { useEffect, useRef, useState, type PropsWithChildren } from 'react'
import { createL2PluginHostRuntime } from '@client/l2_biz/plugin-host/l2-plugin-host-runtime'
import { L2ProjectPreviewDialog } from '@client/l2_biz/project-preview/l2-project-preview-dialog'
import { createL4BrowserUuid } from '@client/l4_foundation/lib/l4-browser-uuid'
import { L4PluginHostContext } from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import type { L4PluginHostRuntime } from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import {
  createL4AppSocketClient,
  L4AppSocketContext,
  type L4AppSocketContextValue,
  type L4AppSocketOwner
} from '@client/l4_foundation/realtime/app-socket/l4-app-socket'

interface L1AppRuntimeOwner {
  clientId: string
  appSocket: L4AppSocketOwner
  pluginHost: L4PluginHostRuntime
}

export function L1AppRuntimeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const toast = useL4AppToast()
  const [runtime] = useState<L1AppRuntimeOwner>(() => {
    const clientId = createL4BrowserUuid()
    const owner = createL4AppSocketClient(clientId)
    return {
      clientId,
      ...createL2PluginHostRuntime(owner, (_pluginName, input) => {
        toast.show(input)
      })
    }
  })

  const [projectDirectory, setProjectDirectory] = useState<string | null>(null)
  useEffect(
    () =>
      runtime.pluginHost.bindProjectPreview((directory) => {
        setProjectDirectory(directory)
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>('[data-testid="project-preview-dialog"]')?.focus()
        )
      }),
    [runtime]
  )

  const lifecycleRef = useRef<{ token: object; runtime: L1AppRuntimeOwner } | null>(null)

  useEffect(() => {
    const token = {}
    lifecycleRef.current = { token, runtime }
    return () => {
      if (lifecycleRef.current?.token === token) lifecycleRef.current = null
      queueMicrotask(() => {
        if (lifecycleRef.current?.runtime === runtime) return
        runtime.appSocket.close()
        void runtime.pluginHost.dispose()
      })
    }
  }, [runtime])

  const contextValue: L4AppSocketContextValue = runtime
  return (
    <L4AppSocketContext.Provider value={contextValue}>
      <L4PluginHostContext.Provider value={runtime.pluginHost}>
        {children}
        {projectDirectory ? (
          <L2ProjectPreviewDialog
            key={projectDirectory}
            clientId={runtime.clientId}
            cwd={projectDirectory}
            onClose={() => setProjectDirectory(null)}
          />
        ) : null}
      </L4PluginHostContext.Provider>
    </L4AppSocketContext.Provider>
  )
}
