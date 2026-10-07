import 'server-only'

import type { L2SystemStatus } from '@common/l2_biz/system/l2-system-contract'
import { getL2SystemStatus } from '@server/l2_biz/system/l2-system'

export function loadL1HomePageData(): L2SystemStatus {
  return getL2SystemStatus()
}
