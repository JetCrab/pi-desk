import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigPath } from '@jetcrab/pi-desk-sdk/config'
import { z } from 'zod'

export const L4AuthConfigSchema = z
  .object({ passwordHash: z.string().regex(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/) })
  .strict()

export const L4ReadAuthConfigSchema = L4AuthConfigSchema

export class L4AuthConfigError extends Error {
  constructor() {
    super('登录保护配置无法读取，请修复配置或删除 pi-desk-auth.json 后重新设置')
    this.name = 'L4AuthConfigError'
  }
}

export function readL4AuthSessionKey(path: string): string {
  const key = readFileSync(path, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(key)) throw new L4AuthConfigError()
  return key
}

export function initializeL4AuthSessionKey(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, {
      mode: 0o600,
      flag: 'wx'
    })
  } catch (cause) {
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause
  }
  readL4AuthSessionKey(path)
  chmodSync(path, 0o600)
}

/** 只供首次配置或离线恢复；普通读取不能把丢失的签名材料视为新环境。 */
export function restoreL4AuthSessionKey(agentDir: string): void {
  const path = getConfigPath('pi-desk-auth.json', agentDir)
  L4AuthConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  initializeL4AuthSessionKey(join(agentDir, 'pi-desk', 'auth-session-key'))
}
