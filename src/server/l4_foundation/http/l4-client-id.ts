import 'server-only'

import {
  L4_CLIENT_ID_HEADER,
  L4ClientIdSchema
} from '@common/l4_foundation/http/l4-client-id-contract'

export function readL4ClientId(request: Request): string | null {
  const clientId = L4ClientIdSchema.safeParse(request.headers.get(L4_CLIENT_ID_HEADER))
  return clientId.success ? clientId.data : null
}
