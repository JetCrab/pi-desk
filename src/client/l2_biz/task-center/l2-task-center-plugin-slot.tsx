'use client'

import { useMemo } from 'react'
import { L2TaskCenterPluginStateSchema } from '@common/l2_biz/task-center/l2-task-center-contract'
import type { L3WorkSessionSource } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import { L2TaskCenter } from './l2-task-center'
import type { L2TaskCenterRuntime } from './l2-task-center-runtime'

interface L2TaskCenterPluginSlotProps {
  source: L3WorkSessionSource
  cwd: string
  pluginState: unknown
  runtime: L2TaskCenterRuntime
  variant: 'summary' | 'menu'
}

export function L2TaskCenterPluginSlot({
  source,
  cwd,
  pluginState,
  runtime,
  variant
}: L2TaskCenterPluginSlotProps): React.JSX.Element {
  const tasks = useMemo(() => {
    const parsed = L2TaskCenterPluginStateSchema.safeParse(pluginState)
    return parsed.success ? parsed.data.tasks : []
  }, [pluginState])

  return (
    <L2TaskCenter source={source} cwd={cwd} tasks={tasks} runtime={runtime} variant={variant} />
  )
}
