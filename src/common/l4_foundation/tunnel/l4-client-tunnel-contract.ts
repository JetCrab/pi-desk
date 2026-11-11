import { z } from 'zod'
import { defineL4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'

export const L4TunnelPortSchema = z.number().int().min(1).max(65535)

export const L4TunnelPublicationSchema = z
  .object({
    controlServerUrl: z.url({ protocol: /^http$/ }),
    providerId: z.string().regex(/^[0-9a-f]{64}$/i),
    remotePort: L4TunnelPortSchema
  })
  .strict()

export const L4ClientTunnelResolveContract = defineL4AppSocketRequest({
  path: 'client-tunnels/resolve',
  inputSchema: z.object({ remotePort: L4TunnelPortSchema }).strict(),
  outputSchema: L4TunnelPublicationSchema,
  timeoutMs: 10_000
})

export type L4TunnelPublication = z.infer<typeof L4TunnelPublicationSchema>
