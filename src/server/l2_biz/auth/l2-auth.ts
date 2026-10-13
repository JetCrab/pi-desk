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
import {
  getL3AppNotificationRuntime,
  type L3AppNotificationPublisher,
  type L3AppNotificationRuntime
} from '@server/l3_modules/app-runtime/l3-app-notification-runtime'
import { getL4HostSettingsStore } from '@server/l4_foundation/l4-host-settings-store'
import { L2_AUTH_MESSAGES } from '@common/l2_biz/auth/l2-auth-messages'

export const L2_WEB_SESSION_COOKIE_NAME = 'pi-desk-session'
const WEB_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

function recordLoginResult(success: boolean): void {
  const runtime = getL3AppNotificationRuntime()
  const loginAttempts = (globalThis.__piDeskLoginAttempts ??= new WeakMap())
  let attempts = loginAttempts.get(runtime)
  if (!attempts) {
    attempts = { failures: 0, publisher: runtime.createPublisher() }
    loginAttempts.set(runtime, attempts)
  }
  if (success) {
    attempts.failures = 0
    return
  }
  attempts.failures += 1
  if (attempts.failures <= 5) return
  if (attempts.failures === 6) {
    console.warn('[Pi Desk][Auth] 连续登录失败超过阈值，发布登录异常提醒')
  }
  try {
    const locale = getL4HostSettingsStore().getSnapshot().region.locale
    const messages = L2_AUTH_MESSAGES[locale]
    attempts.publisher.publish({
      key: 'auth:login-failures',
      level: 'warning',
      title: messages.loginAlertTitle,
      description: messages.loginAlertDescription
    })
  } catch (error) {
    console.error('[Pi Desk][Auth] 登录异常提醒发布失败', {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
  }
}

declare global {
  var __piDeskAuthMutation: Promise<void> | undefined
  // 跨 HTTP 路由共享，计数和发布者跟随通知 Runtime 释放，不保存失败请求内容。
  var __piDeskLoginAttempts:
    | WeakMap<L3AppNotificationRuntime, { failures: number; publisher: L3AppNotificationPublisher }>
    | undefined
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
    recordLoginResult(true)
    return { cookieName: L2_WEB_SESSION_COOKIE_NAME, token: '', maxAgeSeconds: 0 }
  }
  const passwordMatches = await verifyL4AuthPassword(input.password, credentials.passwordHash)
  // scrypt 计算期间凭据可能已被修改或删除，不为旧配置签发会话或累计失败次数。
  if (readL4AuthCredentials()?.sessionSecret !== credentials.sessionSecret) return null
  if (!passwordMatches) {
    recordLoginResult(false)
    return null
  }

  const loggedInAt = Date.now()
  appendL4LoginRecord({ loggedInAt })
  recordLoginResult(true)
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
    recordLoginResult(true)
    console.info('[Pi Desk][Auth] 登录保护已更新', { enabled: config !== null })
  })
  globalThis.__piDeskAuthMutation = operation.catch(() => undefined)
  return operation
}
