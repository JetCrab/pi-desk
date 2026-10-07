import 'server-only'

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const SESSION_TOKEN_PATTERN = /^(\d+)\.([a-f0-9]{64})$/
const SESSION_SIGNATURE_PREFIX = 'Pi Desk web session:'

function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function createSessionSignature(expiresAt: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${SESSION_SIGNATURE_PREFIX}${expiresAt}`, 'utf8')
    .digest('hex')
}

export function areL4WebAuthSecretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(hashSecret(actual), hashSecret(expected))
}

export function createL4WebAuthSessionToken(
  secret: string,
  maxAgeSeconds: number,
  now = Date.now()
): string {
  const expiresAt = now + maxAgeSeconds * 1_000
  if (!Number.isSafeInteger(expiresAt)) throw new Error('登录会话过期时间无效')
  return `${expiresAt}.${createSessionSignature(expiresAt, secret)}`
}

export function isValidL4WebAuthSessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now()
): boolean {
  if (!token || !secret) return false

  const match = SESSION_TOKEN_PATTERN.exec(token)
  if (!match) return false

  const expiresAt = Number(match[1])
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return false

  return areL4WebAuthSecretsEqual(match[2], createSessionSignature(expiresAt, secret))
}

export function readL4WebAuthCookie(
  cookieHeader: string | undefined,
  cookieName: string
): string | undefined {
  if (!cookieHeader) return undefined

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue

    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

export function shouldUseL4SecureWebCookie(
  requestUrl: string,
  forwardedProtocol: string | null
): boolean {
  if (new URL(requestUrl).protocol === 'https:') return true
  return forwardedProtocol?.split(',', 1)[0]?.trim().toLowerCase() === 'https'
}

export function createL4WebAuthCookieHeader(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Strict'
  ]
  if (secure) attributes.push('Secure')
  return attributes.join('; ')
}
