'use client'

import { useMemo } from 'react'
import type { BrowserBeforeLeaveHandler } from '@jetcrab/pi-desk-sdk/browser'
import type { L3CapabilityModeNames } from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import { useL4AppSocket } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { createL2ModelSettingsBiz } from './l2-model-settings-biz'
import { L2ProjectModelDefaultSettings } from './views/l2-project-model-default-settings'
import { useL2ProjectModelDefaultSettings } from './hooks/l2-use-project-model-default-settings'

export function L2ProjectDefaultSettings({
  modeNames,
  onBeforeLeaveChange
}: {
  modeNames: L3CapabilityModeNames
  onBeforeLeaveChange: (handler: BrowserBeforeLeaveHandler | null) => void
}): React.JSX.Element {
  const { clientId } = useL4AppSocket()
  const biz = useMemo(() => createL2ModelSettingsBiz(clientId), [clientId])
  const state = useL2ProjectModelDefaultSettings(biz, onBeforeLeaveChange)
  return <L2ProjectModelDefaultSettings state={state} modeNames={modeNames} />
}
