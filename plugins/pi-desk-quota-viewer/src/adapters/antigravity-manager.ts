import { z } from 'zod'
import type { QuotaAccount, QuotaResource } from '../protocol.js'
import { requestJson } from './http.js'
import {
  known,
  numberValue,
  objectValue,
  optionalObject,
  stringValue,
  timestampMs,
  unknown
} from './resources.js'
import type { QuotaAdapter } from './types.js'

const configSchema = z
  .object({
    managementUrl: z.string().trim().url('Management URL 必须是有效 URL'),
    managementPassword: z.string().min(1, '管理密码不能为空')
  })
  .strict()

function accountsUrl(value: string): string {
  const url = new URL(value)
  url.search = ''
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/accounts`
  return url.toString()
}

function percentValue(value: unknown, fraction: boolean): number | null {
  const number = numberValue(value)
  if (number === null || number < 0 || number > (fraction ? 1 : 100)) return null
  return fraction ? number * 100 : number
}

function percentageResource(input: {
  key: string
  label: string
  scope: Record<string, string>
  remaining: number | null
  durationSeconds: number | null
  resetAt: number | null
}): QuotaResource {
  return {
    key: input.key,
    kind: 'quota',
    label: input.label,
    scope: input.scope,
    unit: { kind: 'percentage' },
    values: {
      limit: known(100),
      used: input.remaining === null ? unknown() : known(100 - input.remaining),
      remaining: input.remaining === null ? unknown() : known(input.remaining)
    },
    window: {
      kind: input.durationSeconds === null ? 'unknown' : 'rolling',
      durationSeconds: input.durationSeconds,
      resetAt: input.resetAt
    }
  }
}

function quotaResources(quota: Record<string, unknown>): QuotaResource[] {
  const resources: QuotaResource[] = []
  if (Array.isArray(quota.quota_groups)) {
    for (const raw of quota.quota_groups) {
      const group = optionalObject(raw)
      if (!group || !Array.isArray(group.buckets)) continue
      const feature = stringValue(group.display_name)
      const description = stringValue(group.description)
      for (const item of group.buckets) {
        const bucket = optionalObject(item)
        const id = stringValue(bucket?.bucket_id)
        if (!bucket || !id) continue
        const window = stringValue(bucket.window)
        const durationSeconds = window === '5h' ? 18_000 : window === 'weekly' ? 604_800 : null
        resources.push(
          percentageResource({
            key: `bucket/${id}`,
            label:
              window === '5h' ? '5 小时额度' : window === 'weekly' ? '周额度' : (window ?? '额度'),
            scope: {
              ...(feature ? { feature } : {}),
              ...(description ? { description } : {}),
              ...(window && durationSeconds === null ? { window } : {})
            },
            remaining: percentValue(bucket.remaining_fraction, true),
            durationSeconds,
            resetAt: timestampMs(bucket.reset_time)
          })
        )
      }
    }
  }
  if (resources.length > 0) return resources
  if (Array.isArray(quota.models)) {
    for (const raw of quota.models) {
      const model = optionalObject(raw)
      const name = stringValue(model?.name)
      if (!model || !name) continue
      resources.push(
        percentageResource({
          key: `model/${name}`,
          label: name,
          scope: { model: name },
          remaining: percentValue(model.percentage, false),
          durationSeconds: null,
          resetAt: timestampMs(model.reset_time)
        })
      )
    }
  }
  return resources
}

function parseAccount(value: unknown): QuotaAccount {
  const account = objectValue(value, 'Manager 账号')
  const id =
    typeof account.id === 'number' && Number.isFinite(account.id)
      ? String(account.id)
      : stringValue(account.id)
  if (!id) throw new Error('Manager 账号缺少 id')
  const quota = optionalObject(account.quota)
  const seconds = numberValue(quota?.last_updated)
  const observedAt =
    seconds !== null && seconds > 0 && Number.isFinite(seconds * 1000) ? seconds * 1000 : null
  const resources = quota ? quotaResources(quota) : []
  return {
    key: id,
    type: 'antigravity',
    name: stringValue(account.email) ?? stringValue(account.name),
    plan: stringValue(quota?.subscription_tier),
    status:
      account.disabled === true
        ? 'disabled'
        : account.validation_blocked === true || quota?.is_forbidden === true
          ? 'blocked'
          : account.proxy_disabled === true
            ? 'paused'
            : 'active',
    error: resources.length === 0 ? '暂无可用额度快照' : null,
    observedAt,
    resources
  }
}

export const antigravityManagerAdapter: QuotaAdapter = {
  descriptor: {
    adapter: 'antigravity-manager',
    label: 'Antigravity Manager',
    description: '读取管理器保存的账号额度快照，不触发刷新。',
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
      { key: 'managementPassword', kind: 'secret', label: '管理密码', required: true }
    ]
  },
  cacheTtlMs: 5 * 60 * 1000,
  minRefreshIntervalMs: 10 * 1000,
  timeoutMs: 15 * 1000,
  validateConfig(input) {
    const parsed = configSchema.parse(input)
    const url = new URL(parsed.managementUrl)
    url.search = ''
    url.hash = ''
    return {
      managementUrl: url.toString().replace(/\/+$/, ''),
      managementPassword: parsed.managementPassword
    }
  },
  async load({ config, signal, fetch }) {
    const parsed = configSchema.parse(config)
    const root = objectValue(
      await requestJson({
        fetch,
        url: accountsUrl(parsed.managementUrl),
        init: { method: 'GET', headers: { Authorization: `Bearer ${parsed.managementPassword}` } },
        signal,
        label: 'Antigravity Manager 账号快照查询'
      }),
      'Antigravity Manager 响应'
    )
    if (!Array.isArray(root.accounts)) throw new Error('Manager 响应缺少账号列表')
    return { accounts: root.accounts.map(parseAccount), warning: null }
  }
}
