import 'server-only'

import { L2SystemStatusSchema, type L2SystemStatus } from '@common/l2_biz/system/l2-system-contract'

const systemStatus = L2SystemStatusSchema.parse({
  application: 'Pi Desk',
  status: 'ready',
  version: process.env.PI_DESK_APP_VERSION?.trim() || null,
  boundaries: {
    client: 'isolated',
    server: 'isolated',
    common: 'shared'
  },
  layers: ['L1 Entry', 'L2 Biz', 'L3 Modules', 'L4 Foundation']
})

export function getL2SystemStatus(): L2SystemStatus {
  return systemStatus
}
