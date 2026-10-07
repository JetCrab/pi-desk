import 'server-only'

import type {
  L2AuthLoginRequest,
  L2AuthSettings,
  L2AuthSettingsReplaceRequest
} from '@common/l2_biz/auth/l2-auth-contract'
import {
  createL4WebAuthSessionToken,
  isValidL4WebAuthSessionToken,
  readL4WebAuthCookie
} from '@server/l4_foundation/auth/l4-web-auth'
import {
  getL4AuthConfigPath,
  hashL4AuthPassword,
  readL4AuthCredentials,
  verifyL4AuthPassword,
  writeL4AuthConfig,
  type L4AuthCredentials
} from '@server/l4_foundation/auth/l4-auth-config'
import { appendL4LoginRecord } from '@server/l4_foundation/auth/l4-login-record-store'

export const L2_WEB_SESSION_COOKIE_NAME = 'pi-desk-session'
const WEB_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

declare global {
  var __piDeskAuthMutation: Promise<void> | undefined
}

export interface L2WebAuthLoginResult {
  cookieName: string
  token: string
  maxAgeSeconds: number
}

export class L2AuthRequiredError extends Error {
  constructor() {
    super('请先登录')
    this.name = 'L2AuthRequiredError'
  }
}

function isAuthenticated(
  credentials: L4AuthCredentials | null,
  cookieHeader: string | undefined
): boolean {
  return (
    credentials === null ||
    isValidL4WebAuthSessionToken(
      readL4WebAuthCookie(cookieHeader, L2_WEB_SESSION_COOKIE_NAME),
      credentials.sessionSecret
    )
  )
}

export async function authenticateL2WebLogin(
  input: L2AuthLoginRequest
): Promise<L2WebAuthLoginResult | null> {
  const credentials = readL4AuthCredentials()
  if (!credentials) {
    return { cookieName: L2_WEB_SESSION_COOKIE_NAME, token: '', maxAgeSeconds: 0 }
  }
  const passwordMatches = await verifyL4AuthPassword(input.password, credentials.passwordHash)
  if (!passwordMatches) return null
  // scrypt 计算期间凭据可能已被修改或删除，不为旧配置签发会话。
  if (readL4AuthCredentials()?.sessionSecret !== credentials.sessionSecret) return null

  const loggedInAt = Date.now()
  appendL4LoginRecord({ loggedInAt })
  return {
    cookieName: L2_WEB_SESSION_COOKIE_NAME,
    token: createL4WebAuthSessionToken(
      credentials.sessionSecret,
      WEB_SESSION_MAX_AGE_SECONDS,
      loggedInAt
    ),
    maxAgeSeconds: WEB_SESSION_MAX_AGE_SECONDS
  }
}

export function isL2WebSessionAuthenticated(cookieHeader: string | undefined): boolean {
  return isAuthenticated(readL4AuthCredentials(), cookieHeader)
}

export function getL2AuthSettings(cookieHeader: string | undefined): L2AuthSettings {
  const credentials = readL4AuthCredentials()
  if (!isAuthenticated(credentials, cookieHeader)) throw new L2AuthRequiredError()
  return { enabled: credentials !== null, configPath: getL4AuthConfigPath() }
}

export function replaceL2AuthSettings(
  input: L2AuthSettingsReplaceRequest,
  cookieHeader: string | undefined
): Promise<void> {
  const operation = (globalThis.__piDeskAuthMutation ?? Promise.resolve()).then(async () => {
    const credentials = readL4AuthCredentials()
    if (!isAuthenticated(credentials, cookieHeader)) throw new L2AuthRequiredError()
    const config =
      input.password === null ? null : { passwordHash: await hashL4AuthPassword(input.password) }
    if (readL4AuthCredentials()?.sessionSecret !== credentials?.sessionSecret) {
      throw new L2AuthRequiredError()
    }
    writeL4AuthConfig(config)
    console.info('[Pi Desk][Auth] 登录保护已更新', { enabled: config !== null })
  })
  globalThis.__piDeskAuthMutation = operation.catch(() => undefined)
  return operation
}
