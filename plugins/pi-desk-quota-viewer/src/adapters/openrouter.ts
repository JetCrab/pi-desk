import { z } from 'zod'
import type { QuotaResource, QuotaValue } from '../protocol.js'
import { requestJson, QuotaHttpError } from './http.js'
import {
  errorMessage,
  known,
  numberValue,
  objectValue,
  stringValue,
  timestampMs,
  unknown,
  unlimited
} from './resources.js'
import type { QuotaAdapter } from './types.js'

const MIN_REFRESH_INTERVAL_MS = 10 * 1000

const configSchema = z
  .object({
    managementKey: z.string().trim(),
    apiKey: z.string().trim()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.managementKey && !value.apiKey) {
      context.addIssue({
        code: 'custom',
        path: ['managementKey'],
        message: 'Management Key 和 API Key 至少填写一个'
      })
    }
  })

function quotaValue(record: Record<string, unknown>, key: string): QuotaValue {
  if (!Object.hasOwn(record, key)) return unknown()
  if (record[key] === null && key === 'limit') return unlimited()
  const value = numberValue(record[key])
  return value === null ? unknown() : known(value)
}

async function loadCredits(
  fetchImpl: typeof fetch,
  managementKey: string,
  signal: AbortSignal
): Promise<QuotaResource> {
  const payload = await requestJson({
    fetch: fetchImpl,
    url: 'https://openrouter.ai/api/v1/credits',
    init: { headers: { Authorization: `Bearer ${managementKey}` } },
    signal,
    label: 'OpenRouter 账户余额查询'
  })
  const root = objectValue(payload, 'OpenRouter Credits 响应')
  const data = objectValue(root.data, 'OpenRouter Credits data')
  const totalCredits = numberValue(data.total_credits)
  const totalUsage = numberValue(data.total_usage)
  if (totalCredits === null && totalUsage === null) {
    throw new Error('OpenRouter Credits 响应缺少额度字段')
  }
  return {
    key: 'account-credits',
    kind: 'balance',
    label: '可用 Credits',
    scope: {},
    unit: { kind: 'currency', code: 'USD' },
    available:
      totalCredits !== null && totalUsage !== null ? known(totalCredits - totalUsage) : unknown(),
    expiresAt: null
  }
}

async function requestKeyPayload(
  fetchImpl: typeof fetch,
  apiKey: string,
  signal: AbortSignal
): Promise<unknown> {
  const request = (url: string) =>
    requestJson({
      fetch: fetchImpl,
      url,
      init: { headers: { Authorization: `Bearer ${apiKey}` } },
      signal,
      label: 'OpenRouter API Key 额度查询'
    })
  try {
    return await request('https://openrouter.ai/api/v1/key')
  } catch (error) {
    if (!(error instanceof QuotaHttpError) || error.status !== 404) throw error
    return request('https://openrouter.ai/api/v1/auth/key')
  }
}

async function loadKeyQuota(
  fetchImpl: typeof fetch,
  apiKey: string,
  signal: AbortSignal
): Promise<QuotaResource> {
  const payload = await requestKeyPayload(fetchImpl, apiKey, signal)
  const root = objectValue(payload, 'OpenRouter Key 响应')
  const data = objectValue(root.data, 'OpenRouter Key data')
  if (
    !Object.hasOwn(data, 'limit') &&
    !Object.hasOwn(data, 'usage') &&
    !Object.hasOwn(data, 'limit_remaining')
  ) {
    throw new Error('OpenRouter Key 响应缺少额度字段')
  }
  const resetAt = timestampMs(data.limit_reset)
  const keyLabel = stringValue(data.label)
  return {
    key: 'api-key-quota',
    kind: 'quota',
    label: 'API Key 额度',
    scope: keyLabel ? { key: keyLabel } : {},
    unit: { kind: 'currency', code: 'USD' },
    values: {
      limit: quotaValue(data, 'limit'),
      used: quotaValue(data, 'usage'),
      remaining: quotaValue(data, 'limit_remaining')
    },
    window: {
      kind: resetAt === null ? 'unknown' : 'billing',
      durationSeconds: null,
      resetAt
    }
  }
}

export const openRouterAdapter: QuotaAdapter = {
  descriptor: {
    adapter: 'openrouter',
    label: 'OpenRouter',
    description: '查询账户 Credits 和 API Key 额度；至少配置一种 Key。',
    dataSource: 'official_api',
    resourceKinds: ['balance', 'quota'],
    fields: [
      {
        key: 'managementKey',
        kind: 'secret',
        label: 'Management Key',
        required: false,
        description: '用于读取账户 Credits。'
      },
      {
        key: 'apiKey',
        kind: 'secret',
        label: 'API Key',
        required: false,
        description: '用于读取当前 Key 的额度。'
      }
    ]
  },
  cacheTtlMs: 5 * 60 * 1000,
  minRefreshIntervalMs: MIN_REFRESH_INTERVAL_MS,
  timeoutMs: 15 * 1000,
  validateConfig(input) {
    return configSchema.parse(input)
  },
  async load({ config, signal, fetch }) {
    const parsed = configSchema.parse(config)
    const tasks: Array<Promise<QuotaResource>> = []
    if (parsed.managementKey) tasks.push(loadCredits(fetch, parsed.managementKey, signal))
    if (parsed.apiKey) tasks.push(loadKeyQuota(fetch, parsed.apiKey, signal))
    const settled = await Promise.allSettled(tasks)
    const resources = settled.flatMap((item) => (item.status === 'fulfilled' ? [item.value] : []))
    const errors = settled.flatMap((item) =>
      item.status === 'rejected' ? [errorMessage(item.reason)] : []
    )
    const rateLimited = settled.flatMap((item) =>
      item.status === 'rejected' &&
      item.reason instanceof QuotaHttpError &&
      item.reason.status === 429
        ? [item.reason.retryAt ?? Date.now() + MIN_REFRESH_INTERVAL_MS]
        : []
    )
    const retryAt = rateLimited.length > 0 ? Math.max(...rateLimited) : null
    if (resources.length === 0) {
      const message = errors.join('；') || 'OpenRouter 没有可用额度数据'
      if (retryAt !== null) throw new QuotaHttpError(message, 429, retryAt)
      throw new Error(message)
    }
    return {
      resources,
      warning: errors.length > 0 ? errors.join('；') : null,
      retryAt
    }
  }
}
