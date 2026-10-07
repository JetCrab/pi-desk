import 'server-only'

import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

export function getL4PiDeskDataDir(): string {
  const agentDir = getAgentDir()
  const target = join(agentDir, 'pi-desk')
  const previous = join(agentDir, 'pi-super')
  if (existsSync(target) || !existsSync(previous)) return target

  const temporary = join(agentDir, `.pi-desk-migration-${randomUUID()}`)
  try {
    cpSync(previous, temporary, { recursive: true, errorOnExist: true, force: false })
    renameSync(temporary, target)
    console.info('[Pi Desk] 已复制旧版应用数据到新目录')
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  return target
}
