import type { QuotaResource } from '../protocol.js'
import { accountDisplay, cpaConfigSchema, managementBaseUrl } from './cpa.js'
import { parseRetryAt, QuotaHttpError, requestJson } from './http.js'
import {
  errorMessage,
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
import type { QuotaAdapter } from './types.js'

const DEVIN_STATUS_URL =
  'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus'
const MIN_REFRESH_INTERVAL_MS = 10 * 1000

function remainingPercent(value: unknown): number | null {
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null
  const percent = numberValue(value)
  return percent !== null && percent >= 0 && percent <= 100 ? percent : null
}

function parseResources(payload: unknown, accountKey: string, account: string): QuotaResource[] {
  const root = objectValue(payload, 'Devin GetUserStatus 响应')
  const userStatus = optionalObject(root.userStatus)
  const planStatus = optionalObject(userStatus?.planStatus)
  if (!planStatus) return []
  const planInfo = optionalObject(planStatus.planInfo)
  const plan = stringValue(planInfo?.planName)
  const resources: QuotaResource[] = []
  for (const [period, position, label, durationSeconds] of [
    ['daily', 'primary', '日额度', 86400],
    ['weekly', 'secondary', '周额度', 604800]
  ] as const) {
    const remaining = remainingPercent(planStatus[`${period}QuotaRemainingPercent`])
    const resetAt = timestampMs(planStatus[`${period}QuotaResetAtUnix`])
    if (remaining === null && resetAt === null) continue
    resources.push({
      key: resourceKey(accountKey, 'devin', position),
      kind: 'quota',
      label,
      scope: { account, ...(plan ? { plan } : {}) },
      unit: { kind: 'percentage' },
      values: {
        limit: known(100),
        used: remaining === null ? unknown() : known(100 - remaining),
        remaining: remaining === null ? unknown() : known(remaining)
      },
      window: { kind: 'unknown', durationSeconds, resetAt }
    })
  }
  return resources
}

async function loadAccount(input: {
  fetch: typeof fetch
  baseUrl: string
  managementKey: string
  authIndex: string | number
  account: string
  signal: AbortSignal
}): Promise<QuotaResource[]> {
  const label = `CPA Devin 账号 ${input.account}（${input.authIndex}）额度查询`
  const envelope = objectValue(
    await requestJson({
      fetch: input.fetch,
      url: `${input.baseUrl}/api-call`,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.managementKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          auth_index: input.authIndex,
          method: 'POST',
          url: DEVIN_STATUS_URL,
          header: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1'
          },
          data: JSON.stringify({
            metadata: {
              ideName: 'chisel',
              ideVersion: '3000.10.21',
              apiKey: '$TOKEN$',
              locale: 'en',
              os: 'darwin',
              extensionVersion: '3000.10.21',
              clientName: 'chisel'
            }
          })
        })
      },
      signal: input.signal,
      label
    }),
    'CPA api-call 响应'
  )
  const status = numberValue(envelope.status_code)
  if (status === null) throw new Error(`${label}未返回上游状态码`)
  if (status < 200 || status >= 300) {
    const headers = optionalObject(envelope.header)
    const retryAfter = Object.entries(headers ?? {}).find(
      ([key]) => key.toLowerCase() === 'retry-after'
    )?.[1]
    throw new QuotaHttpError(
      `${label}失败（HTTP ${status}）`,
      status,
      status === 429
        ? parseRetryAt(
            stringValue(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter),
            Date.now()
          )
        : null
    )
  }
  let body: unknown = envelope.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      throw new Error(`${label}返回的 body 不是有效 JSON`)
    }
  }
  const resources = parseResources(body, String(input.authIndex), input.account)
  if (resources.length === 0) throw new Error(`账号 ${input.account} 未返回可识别额度`)
  return resources
}

export const cpaDevinAdapter: QuotaAdapter = {
  descriptor: {
    adapter: 'cpa-devin',
    label: 'Devin（通过 CPA）',
    description: '自动读取 CPA 中启用的 Devin 账号，查询每日、每周剩余百分比。',
    dataSource: 'internal_api',
    resourceKinds: ['quota'],
    fields: [
      {
        key: 'managementUrl',
        kind: 'url',
        label: 'Management URL',
        required: true,
        placeholder: 'https://example.com'
      },
      {
        key: 'managementKey',
        kind: 'secret',
        label: 'Management Key',
        required: true
      }
    ]
  },
  cacheTtlMs: 5 * 60 * 1000,
  minRefreshIntervalMs: MIN_REFRESH_INTERVAL_MS,
  timeoutMs: 20 * 1000,
  validateConfig(input) {
    return cpaConfigSchema.parse(input)
  },
  async load({ config, signal, fetch }) {
    const parsed = cpaConfigSchema.parse(config)
    const baseUrl = managementBaseUrl(parsed.managementUrl)
    const authRoot = objectValue(
      await requestJson({
        fetch,
        url: `${baseUrl}/auth-files`,
        init: { headers: { Authorization: `Bearer ${parsed.managementKey}` } },
        signal,
        label: 'CPA Devin 账号列表查询'
      }),
      'CPA auth-files 响应'
    )
    const files = Array.isArray(authRoot.files)
      ? authRoot.files.flatMap((value) => {
          const file = optionalObject(value)
          return file &&
            file.disabled !== true &&
            [file.provider, file.type].some(
              (value) => stringValue(value)?.toLowerCase() === 'devin'
            )
            ? [file]
            : []
        })
      : []
    if (files.length === 0) throw new Error('CPA 未发现启用的 Devin 账号')
    const settled = await Promise.allSettled(
      files.map(async (file, index) => {
        const account = accountDisplay(file, `Devin 账号 ${index + 1}`)
        const authIndex = field(file, 'authIndex', 'auth_index')
        if (
          (typeof authIndex !== 'string' && typeof authIndex !== 'number') ||
          String(authIndex).trim() === ''
        ) {
          throw new Error(`CPA 账号 ${account} 缺少 authIndex`)
        }
        return loadAccount({
          fetch,
          baseUrl,
          managementKey: parsed.managementKey,
          authIndex,
          account,
          signal
        })
      })
    )
    if (signal.aborted) throw signal.reason
    const resources = settled.flatMap((item) => (item.status === 'fulfilled' ? item.value : []))
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
      const message = errors.join('；') || 'CPA Devin 没有可用额度数据'
      if (retryAt !== null) throw new QuotaHttpError(message, 429, retryAt)
      throw new Error(message)
    }
    return { resources, warning: errors.length > 0 ? errors.join('；') : null, retryAt }
  }
}
