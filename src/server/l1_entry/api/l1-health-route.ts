import 'server-only'

import { getL2SystemStatus } from '@server/l2_biz/system/l2-system'
import { createL4ApiSuccessResponse } from '@server/l4_foundation/http/l4-api-response'

export function GET(): Response {
  const response = createL4ApiSuccessResponse(getL2SystemStatus())
  response.headers.set('Cache-Control', 'no-store')
  return response
}
