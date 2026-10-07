import 'server-only'

import { isL2WebSessionAuthenticated } from '@server/l2_biz/auth/l2-auth'

export interface L1WebAuthRuntime {
  isAuthenticated: (cookieHeader: string | undefined) => boolean
}

const runtime: L1WebAuthRuntime = {
  isAuthenticated: isL2WebSessionAuthenticated
}

export function getL1WebAuthRuntime(): L1WebAuthRuntime {
  return runtime
}
