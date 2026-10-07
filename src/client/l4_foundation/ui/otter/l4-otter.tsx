'use client'

import { useEffect, useRef } from 'react'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { L4OtterArt } from './l4-otter-art'
import { createL4OtterRuntime } from './l4-otter-runtime'
import type { L4OtterState } from './l4-otter-motion'

export type { L4OtterState } from './l4-otter-motion'

export function L4Otter({
  state,
  active = true,
  size = 100,
  className
}: {
  state: L4OtterState
  active?: boolean
  size?: number
  className?: string
}): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const runtimeRef = useRef<ReturnType<typeof createL4OtterRuntime> | null>(null)

  useEffect(() => {
    const runtime = createL4OtterRuntime(svgRef.current!)
    runtimeRef.current = runtime
    return () => {
      runtime.dispose()
      runtimeRef.current = null
    }
  }, [])

  useEffect(() => {
    runtimeRef.current?.setState(state)
  }, [state])

  useEffect(() => {
    runtimeRef.current?.setActive(active)
  }, [active])

  return (
    <span
      aria-hidden="true"
      className={cn('relative block shrink-0 text-muted-foreground', className)}
      style={{ width: size, height: size * 0.75 }}
    >
      <L4OtterArt svgRef={svgRef} />
    </span>
  )
}
