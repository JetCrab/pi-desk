import 'server-only'

import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

export function getL4PiDeskDataDir(): string {
  return join(getAgentDir(), 'pi-desk')
}
