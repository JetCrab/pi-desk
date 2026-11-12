import { handleL1EnvironmentRequest } from '@server/l1_entry/api/l1-environment-routes'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  return handleL1EnvironmentRequest('cancel', request)
}
