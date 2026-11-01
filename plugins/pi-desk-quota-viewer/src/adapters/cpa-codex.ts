import type { QuotaResource } from '../protocol.js'
import type { CpaAccountLoadInput, CpaAccountQuota } from './cpa.js'
import {
  field,
  known,
  numberValue,
  objectValue,
  optionalObject,
  resourceKey,
  stringValue,
  timestampMs,
  unknown
} from './resources.js'

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const PLAN_LABELS: Readonly<Record<string, string>> = {
  free: 'Free',
  plus: 'Plus',
  prolite: 'Pro 5X',
  'pro-lite': 'Pro 5X',
  pro_lite: 'Pro 5X',
  pro: 'Pro 20X',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu'
}

function planType(record: Record<string, unknown>): string | null {
  return stringValue(
    field(
      record,
      'plan_type',
      'planType',
      'subscription_plan',
      'subscriptionPlan',
      'chatgpt_plan_type',
      'chatgptPlanType'
    )
  )
}

function planLabel(value: string | null): string | null {
  return value ? (PLAN_LABELS[value.toLowerCase()] ?? value) : null
}

export function codexAuthFilePlan(file: Record<string, unknown>): string | null {
  const records = [file, optionalObject(file.metadata), optionalObject(file.attributes)]
  for (const record of records) {
    if (!record) continue
    const direct = planLabel(planType(record))
    if (direct) return direct
    for (const key of ['id_token', 'idToken'] as const) {
      const token = optionalObject(record[key])
      const nested = token ? planLabel(planType(token)) : null
      if (nested) return nested
    }
  }
  return null
}

function windowPresentation(
  seconds: number | null,
  position: 'primary' | 'secondary'
): { label: string; durationSeconds: number | null } {
  if (seconds === 18_000) return { label: '5 小时额度', durationSeconds: seconds }
  if (seconds === 604_800) return { label: '周额度', durationSeconds: seconds }
  if (seconds !== null && seconds >= 28 * 86_400 && seconds <= 31 * 86_400) {
    return { label: '月额度', durationSeconds: seconds }
  }
  return { label: position === 'primary' ? '主额度' : '次额度', durationSeconds: seconds }
}

function resetAt(window: Record<string, unknown>, now: number): number | null {
  const absolute = timestampMs(field(window, 'reset_at', 'resetAt'))
  if (absolute !== null) return absolute
  const afterSeconds = numberValue(field(window, 'reset_after_seconds', 'resetAfterSeconds'))
  return afterSeconds !== null && afterSeconds >= 0 ? now + afterSeconds * 1000 : null
}

function rateGroupResources(input: {
  feature: string | null
  featureKey: string
  group: unknown
  now: number
}): QuotaResource[] {
  const group = optionalObject(input.group)
  if (!group) return []
  const limitReached = field(group, 'limit_reached', 'limitReached') === true
  const resources: QuotaResource[] = []
  for (const position of ['primary', 'secondary'] as const) {
    const window = optionalObject(field(group, `${position}_window`, `${position}Window`))
    if (!window) continue
    const seconds = numberValue(field(window, 'limit_window_seconds', 'limitWindowSeconds'))
    let usedPercent = numberValue(field(window, 'used_percent', 'usedPercent'))
    if (usedPercent === null && (limitReached || group.allowed === false)) usedPercent = 100
    const nextResetAt = resetAt(window, input.now)
    if (usedPercent === null && seconds === null && nextResetAt === null) continue
    const presentation = windowPresentation(seconds, position)
    resources.push({
      key: resourceKey(input.featureKey, position),
      kind: 'quota',
      label: presentation.label,
      scope: input.feature ? { feature: input.feature } : {},
      unit: { kind: 'percentage' },
      values: {
        limit: known(100),
        used: usedPercent === null ? unknown() : known(usedPercent),
        remaining: usedPercent === null ? unknown() : known(Math.max(0, 100 - usedPercent))
      },
      window: {
        kind: 'rolling',
        durationSeconds: presentation.durationSeconds,
        resetAt: nextResetAt
      }
    })
  }
  return resources
}

function parseUsage(payload: unknown, fallbackPlan: string | null, now: number): CpaAccountQuota {
  const root = objectValue(payload, 'Codex usage 响应')
  const plan = planLabel(planType(root)) ?? fallbackPlan
  const resources: QuotaResource[] = [
    ...rateGroupResources({
      feature: null,
      featureKey: 'codex',
      group: field(root, 'rate_limit', 'rateLimit'),
      now
    }),
    ...rateGroupResources({
      feature: 'Code Review',
      featureKey: 'code-review',
      group: field(
        root,
        'code_review_rate_limit',
        'codeReviewRateLimit',
        'code_review',
        'codeReview'
      ),
      now
    })
  ]
  const additional = field(root, 'additional_rate_limits', 'additionalRateLimits')
  if (Array.isArray(additional)) {
    for (const [index, raw] of additional.entries()) {
      const item = optionalObject(raw)
      if (!item) continue
      const label =
        stringValue(field(item, 'limit_name', 'limitName', 'metered_feature', 'meteredFeature')) ??
        `附加额度 ${index + 1}`
      resources.push(
        ...rateGroupResources({
          feature: label,
          featureKey: `additional-${index}-${label}`,
          group: field(item, 'rate_limit', 'rateLimit') ?? item,
          now
        })
      )
    }
  }
  const resetCredits = optionalObject(
    field(root, 'rate_limit_reset_credits', 'rateLimitResetCredits')
  )
  if (resetCredits) {
    const count = numberValue(field(resetCredits, 'available_count', 'availableCount'))
    resources.push({
      key: 'reset-credits',
      kind: 'balance',
      label: '剩余重置次数',
      scope: {},
      unit: { kind: 'custom', label: '次' },
      available: count === null ? unknown() : known(count),
      expiresAt: null
    })
  }
  return { plan, resources }
}

export async function loadCodexAccount(input: CpaAccountLoadInput): Promise<CpaAccountQuota> {
  const token = optionalObject(field(input.file, 'id_token', 'idToken'))
  const accountId =
    stringValue(field(input.file, 'chatgpt_account_id', 'chatgptAccountId')) ??
    (token ? stringValue(field(token, 'chatgpt_account_id', 'chatgptAccountId')) : null)
  const body = await input.request({
    authIndex: input.authIndex,
    method: 'GET',
    url: CODEX_USAGE_URL,
    header: {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'User-Agent': 'Codex CLI',
      ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {})
    }
  })
  const quota = parseUsage(body, codexAuthFilePlan(input.file), input.now)
  if (quota.resources.length === 0) throw new Error(`账号 ${input.account} 未返回可识别额度`)
  return quota
}
