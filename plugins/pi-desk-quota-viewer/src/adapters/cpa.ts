import { z } from 'zod'
import type { QuotaAccount, QuotaResource } from '../protocol.js'
import { codexAuthFilePlan, loadCodexAccount } from './cpa-codex.js'
import { loadDevinAccount } from './cpa-devin.js'
import { parseRetryAt, QuotaHttpError, requestJson } from './http.js'
import {
  errorMessage,
  field,
  numberValue,
  objectValue,
  optionalObject,
  stringValue
} from './resources.js'
import type { QuotaAdapter, QuotaAdapterLoadContext } from './types.js'

export const cpaConfigSchema = z
  .object({
    managementUrl: z.string().trim().url('Management URL 必须是有效 URL'),
    managementKey: z.string().trim().min(1, 'Management Key 不能为空'),
    /** 兼容旧配置中的账号筛选字段；统一来源始终发现全部账号。 */
    accounts: z.string().max(10_000, '账号列表过长').optional()
  })
  .strict()

export function managementBaseUrl(value: string): string {
  const url = new URL(value)
  url.search = ''
  url.hash = ''
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v0/management') ? path : `${path}/v0/management`
  return url.toString().replace(/\/$/, '')
}

export function accountDisplay(file: Record<string, unknown>, fallback: string): string {
  return stringValue(file.email) ?? stringValue(file.account) ?? stringValue(file.name) ?? fallback
}

export interface CpaAccountLoadInput {
  authIndex: string | number
  account: string
  file: Record<string, unknown>
  now: number
  request(payload: Record<string, unknown>): Promise<unknown>
}

export interface CpaAccountQuota {
  plan: string | null
  resources: QuotaResource[]
}

async function requestCpaAccount(
  input: QuotaAdapterLoadContext & { baseUrl: string; managementKey: string; account: string },
  request: Record<string, unknown>
): Promise<unknown> {
  const label = `CPA 账号 ${input.account} 额度查询`
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
        body: JSON.stringify(request)
      },
      signal: input.signal,
      label
    }),
    'CPA api-call 响应'
  )
  const status = numberValue(field(envelope, 'status_code', 'status', 'statusCode'))
  if (status === null) throw new Error(`${label}未返回上游状态码`)
  if (status < 200 || status >= 300) {
    const headers = optionalObject(field(envelope, 'header', 'headers'))
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
  const body = envelope.body ?? envelope.bodyText
  if (typeof body !== 'string') return body
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`${label}返回的 body 不是有效 JSON`)
  }
}

const MIN_REFRESH_INTERVAL_MS = 10 * 1000

function accountType(file: Record<string, unknown>): string {
  const candidates = [file.provider, file.type].map((value) => stringValue(value)?.toLowerCase())
  return (
    candidates.find((value) => value === 'codex' || value === 'devin') ??
    candidates.find(Boolean) ??
    'unknown'
  )
}

export const cpaAdapter: QuotaAdapter = {
  descriptor: {
    adapter: 'cpa',
    label: 'CPA',
    description: '自动发现 CPA 账号，读取 Codex 和 Devin 额度，保留其他账号状态。',
    dataSource: 'internal_api',
    resourceKinds: ['quota', 'balance'],
    fields: [
      {
        key: 'managementUrl',
        kind: 'url',
        label: 'Management URL',
        required: true,
        placeholder: 'https://example.com'
      },
      { key: 'managementKey', kind: 'secret', label: 'Management Key', required: true }
    ]
  },
  cacheTtlMs: 5 * 60 * 1000,
  minRefreshIntervalMs: MIN_REFRESH_INTERVAL_MS,
  timeoutMs: 20 * 1000,
  validateConfig(input) {
    const parsed = cpaConfigSchema.parse(input)
    return {
      managementUrl: managementBaseUrl(parsed.managementUrl),
      managementKey: parsed.managementKey
    }
  },
  async load(context) {
    const parsed = cpaConfigSchema.parse(context.config)
    const baseUrl = managementBaseUrl(parsed.managementUrl)
    const root = objectValue(
      await requestJson({
        fetch: context.fetch,
        url: `${baseUrl}/auth-files`,
        init: { headers: { Authorization: `Bearer ${parsed.managementKey}` } },
        signal: context.signal,
        label: 'CPA 账号列表查询'
      }),
      'CPA auth-files 响应'
    )
    if (!Array.isArray(root.files)) throw new Error('CPA auth-files 响应缺少账号列表')
    const files = root.files.flatMap((raw) => {
      const file = optionalObject(raw)
      return file ? [file] : []
    })
    const failures: unknown[] = []
    const accounts = await Promise.all(
      files.map(async (file, index): Promise<QuotaAccount> => {
        const type = accountType(file)
        const name = accountDisplay(file, `${type} 账号 ${index + 1}`)
        const authIndex = field(file, 'authIndex', 'auth_index')
        const validIndex =
          (typeof authIndex === 'string' && authIndex.trim() !== '') ||
          (typeof authIndex === 'number' && Number.isFinite(authIndex))
        const account: QuotaAccount = {
          // 缺索引行仅用于诊断，不能代发额度请求，也不从邮箱推导身份。
          key: validIndex
            ? String(authIndex)
            : `missing-auth-index/${stringValue(file.id) ?? stringValue(file.name) ?? index}`,
          type,
          name,
          plan: type === 'codex' ? codexAuthFilePlan(file) : null,
          status: file.disabled === true ? 'disabled' : 'active',
          error: null,
          observedAt: null,
          resources: []
        }
        if (type !== 'codex' && type !== 'devin') {
          account.error = `暂不支持 ${type} 账号的额度查询`
          return account
        }
        if (account.status === 'disabled') return account
        if (!validIndex) {
          account.error = `CPA 账号 ${name} 缺少 authIndex`
          return account
        }
        try {
          const quota = await (type === 'codex' ? loadCodexAccount : loadDevinAccount)({
            authIndex: authIndex as string | number,
            account: name,
            file,
            now: context.now,
            request: (payload) =>
              requestCpaAccount(
                {
                  ...context,
                  baseUrl,
                  managementKey: parsed.managementKey,
                  account: name
                },
                payload
              )
          })
          account.resources = quota.resources
          account.plan = quota.plan
          account.observedAt = context.now
        } catch (error) {
          account.error = errorMessage(error)
          failures.push(error)
        }
        return account
      })
    )
    if (context.signal.aborted) throw context.signal.reason
    const errors = accounts.flatMap((account) => (account.error ? [account.error] : []))
    const cooldowns = failures.flatMap((error) =>
      error instanceof QuotaHttpError && error.status === 429
        ? [error.retryAt ?? Date.now() + MIN_REFRESH_INTERVAL_MS]
        : []
    )
    return {
      accounts,
      warning: errors.length > 0 ? errors.join('；') : null,
      retryAt: cooldowns.length > 0 ? Math.max(...cooldowns) : null
    }
  }
}
