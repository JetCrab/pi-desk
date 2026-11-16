'use client'

import { useEffect, useRef } from 'react'
import { useL4PluginHost } from '@client/l4_foundation/plugin-host/l4-plugin-host-context'

export function L2PluginFloatingLayer(): React.JSX.Element {
  const runtime = useL4PluginHost()
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    return runtime.bindFloatingContainer(layer)
  }, [runtime])

  return (
    <div
      ref={layerRef}
      data-testid="plugin-floating-layer"
      className="pointer-events-none fixed inset-0 z-40 isolate"
    />
  )
}
