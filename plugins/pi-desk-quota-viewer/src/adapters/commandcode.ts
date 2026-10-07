import { z } from 'zod'
import type { QuotaResource, QuotaScope } from '../protocol.js'
import { QuotaHttpError, requestJson } from './http.js'
import {
  errorMessage,
  known,
  numberValue,
  objectValue,
  optionalObject,
  stringValue,
  timestampMs,
  unknown
} from './resources.js'
import type { QuotaAdapter } from './types.js'

const API_ORIGIN = 'https://api.commandcode.ai'
const MIN_REFRESH_INTERVAL_MS = 10 * 1000

const configSchema = z.object({ apiKey: z.string().trim().min(1, 'API Key 不能为空') }).strict()

const PLAN_LABELS: Readonly<Record<string, string>> = {
  'individual-go': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-pro-v1': 'Pro',
  'individual-provider': 'Provider',
  'individual-max': 'Max 10X',
  'individual-ultra': 'Max 20X',
  'teams-pro': 'Teams Pro'
}

interface AccountContext {
  account: string | null
  organization: string | null
  organizationId: string | null
}

interface PlanContext {
  label: string | null
  expiresAt: number | null
}

function responseError(root: Record<string, unknown>, fallback: string): Error | null {
  if (root.success !== false) return null
  const error = optionalObject(root.error)
  return new Error(stringValue(error?.message) ?? fallback)
}

async function requestCommandCode(input: {
  fetch: typeof fetch
  apiKey: string
  path: string
  signal: AbortSignal
  label: string
}): Promise<unknown> {
  return requestJson({
    fetch: input.fetch,
    url: `${API_ORIGIN}${input.path}`,
    init: {
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: 'application/json',
        'x-command-code-version': '1.0.0',
        'x-cli-environment': 'production'
      }
    },
    signal: input.signal,
    label: input.label
  })
}

function parseAccount(payload: unknown): AccountContext {
  const root = objectValue(payload, 'CommandCode whoami 响应')
  const failure = responseError(root, 'CommandCode 账号查询失败')
  if (failure) throw failure
  const user = optionalObject(root.user)
  const organization = optionalObject(root.org)
  return {
    account: user
      ? (stringValue(user.userName) ?? stringValue(user.email) ?? stringValue(user.name))
      : null,
    organization: organization ? stringValue(organization.name) : null,
    organizationId: organization ? stringValue(organization.id) : null
  }
}

function parsePlan(payload: unknown): PlanContext {
  const root = objectValue(payload, 'CommandCode subscriptions 响应')
  const failure = responseError(root, 'CommandCode 套餐查询失败')
  if (failure) throw failure
  const data = optionalObject(root.data)
  const planId = data ? stringValue(data.planId)?.toLowerCase() : null
  return {
    label: planId ? (PLAN_LABELS[planId] ?? planId) : null,
    expiresAt: data ? timestampMs(data.currentPeriodEnd) : null
  }
}

function resourceScope(account: AccountContext, plan: PlanContext): QuotaScope {
  return {
    ...(account.account ? { account: account.account } : {}),
    ...(account.organization ? { organization: account.organization } : {}),
    ...(plan.label ? { plan: plan.label } : {})
  }
}

function balanceResources(
  credits: Record<string, unknown>,
  scope: QuotaScope,
  monthlyExpiresAt: number | null
): QuotaResource[] {
  const definitions = [
    ['monthly-credits', '月度 Credits 余额', 'monthlyCredits', monthlyExpiresAt],
    ['purchased-credits', '购买 Credits 余额', 'purchasedCredits', null],
    ['free-credits', '赠送 Credits 余额', 'freeCredits', null]
  ] as const
  return definitions.flatMap(([key, label, field, expiresAt]) => {
    const value = numberValue(credits[field])
    return value === null
      ? []
      : [
          {
            key,
            kind: 'balance' as const,
            label,
            scope,
            unit: { kind: 'currency' as const, code: 'USD' },
            available: known(value),
            expiresAt
          }
        ]
  })
}

function quotaResource(input: {
  key: string
  label: string
  durationSeconds: number
  value: unknown
  scope: QuotaScope
}): QuotaResource | null {
  const window = optionalObject(input.value)
  if (!window) return null
  const used = numberValue(window.used)
  const limit = numberValue(window.cap)
  const resetAt = timestampMs(window.resetAt)
  if (used === null && limit === null && resetAt === null) return null
  return {
    key: input.key,
    kind: 'quota',
    label: input.label,
    scope: input.scope,
    unit: { kind: 'currency', code: 'USD' },
    values: {
      limit: limit === null ? unknown() : known(limit),
      used: used === null ? unknown() : known(used),
      remaining:
        window.exceeded === true
          ? known(0)
          : limit === null || used === null
            ? unknown()
            : known(Math.max(0, limit - used))
    },
    window: {
      kind: 'rolling',
      durationSeconds: input.durationSeconds,
      resetAt
    }
  }
}

function parseCredits(
  payload: unknown,
  scope: QuotaScope,
  monthlyExpiresAt: number | null
): { resources: QuotaResource[]; exceeded: string[] } {
  const root = objectValue(payload, 'CommandCode credits 响应')
  const failure = responseError(root, 'CommandCode Credits 查询失败')
  if (failure) throw failure
  const credits = optionalObject(root.credits)
  const limits = optionalObject(root.windowLimits)
  const resources = credits ? balanceResources(credits, scope, monthlyExpiresAt) : []
  const exceeded: string[] = []
  const windows = [
    ['five-hour-quota', '5 小时额度', 5 * 60 * 60, limits?.fiveHour],
    ['weekly-quota', '周额度', 7 * 24 * 60 * 60, limits?.weekly]
  ] as const
  for (const [key, label, durationSeconds, value] of windows) {
    const raw = optionalObject(value)
    const resource = quotaResource({ key, label, durationSeconds, value, scope })
    if (!resource) continue
    resources.push(resource)
    if (raw?.exceeded === true) exceeded.push(label)
  }
  return { resources, exceeded }
}

function retryAt(error: unknown, now: number): number | null {
  if (!(error instanceof QuotaHttpError) || error.status !== 429) return null
  return error.retryAt ?? now + MIN_REFRESH_INTERVAL_MS
}

export const commandCodeAdapter: QuotaAdapter = {
  descriptor: {
    adapter: 'commandcode',
    label: 'CommandCode',
    description: '查询 CommandCode Credits 余额及 5 小时、每周金额额度。',
    dataSource: 'official_product',
    resourceKinds: ['balance', 'quota'],
    fields: [
      {
        key: 'apiKey',
        kind: 'secret',
        label: 'API Key',
        required: true
      }
    ]
  },
  cacheTtlMs: 5 * 60 * 1000,
  minRefreshIntervalMs: MIN_REFRESH_INTERVAL_MS,
  timeoutMs: 20 * 1000,
  validateConfig(input) {
    return configSchema.parse(input)
  },
  async load({ config, signal, fetch, now }) {
    const parsed = configSchema.parse(config)
    const errors: unknown[] = []
    let account: AccountContext = { account: null, organization: null, organizationId: null }

    try {
      account = parseAccount(
        await requestCommandCode({
          fetch,
          apiKey: parsed.apiKey,
          path: '/alpha/whoami',
          signal,
          label: 'CommandCode 账号查询'
        })
      )
    } catch (error) {
      errors.push(error)
    }

    const subscriptionPath = account.organizationId
      ? `/alpha/billing/subscriptions?orgId=${encodeURIComponent(account.organizationId)}`
      : '/alpha/billing/subscriptions'
    const [creditsResult, planResult] = await Promise.allSettled([
      requestCommandCode({
        fetch,
        apiKey: parsed.apiKey,
        path: '/alpha/billing/credits',
        signal,
        label: 'CommandCode Credits 查询'
      }),
      requestCommandCode({
        fetch,
        apiKey: parsed.apiKey,
        path: subscriptionPath,
        signal,
        label: 'CommandCode 套餐查询'
      })
    ])
    if (signal.aborted) throw signal.reason

    let plan: PlanContext = { label: null, expiresAt: null }
    if (planResult.status === 'fulfilled') {
      try {
        plan = parsePlan(planResult.value)
      } catch (error) {
        errors.push(error)
      }
    } else {
      errors.push(planResult.reason)
    }

    if (creditsResult.status === 'rejected') {
      errors.push(creditsResult.reason)
      const blockedUntil = errors
        .map((error) => retryAt(error, now))
        .filter((value): value is number => value !== null)
      const message = errors.map(errorMessage).join('；') || 'CommandCode 没有可用额度数据'
      if (blockedUntil.length > 0) {
        throw new QuotaHttpError(message, 429, Math.max(...blockedUntil))
      }
      throw new Error(message)
    }

    const parsedCredits = parseCredits(
      creditsResult.value,
      resourceScope(account, plan),
      plan.expiresAt
    )
    if (parsedCredits.resources.length === 0) {
      throw new Error('CommandCode 响应中没有可识别额度')
    }
    const messages = [
      ...errors.map(errorMessage),
      ...(parsedCredits.exceeded.length > 0 ? [`${parsedCredits.exceeded.join('、')}已达上限`] : [])
    ]
    const blockedUntil = errors
      .map((error) => retryAt(error, now))
      .filter((value): value is number => value !== null)
    return {
      resources: parsedCredits.resources,
      warning: messages.length > 0 ? messages.join('；') : null,
      retryAt: blockedUntil.length > 0 ? Math.max(...blockedUntil) : null
    }
  }
}
