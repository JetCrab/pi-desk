import { z } from 'zod'
import type { QuotaResource } from '../protocol.js'
import { requestJson } from './http.js'
import { known, numberValue, objectValue } from './resources.js'
import type { QuotaAdapter } from './types.js'

const configSchema = z.object({ apiKey: z.string().trim().min(1, 'API Key 不能为空') }).strict()

export const moonshotAdapter: QuotaAdapter = {
  descriptor: {
    adapter: 'moonshot',
    label: 'Moonshot / Kimi API',
    description: '查询 Moonshot API 账户的可用、现金和代金券余额。',
    dataSource: 'official_api',
    resourceKinds: ['balance'],
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
  minRefreshIntervalMs: 10 * 1000,
  timeoutMs: 15 * 1000,
  validateConfig(input) {
    return configSchema.parse(input)
  },
  async load({ config, signal, fetch }) {
    const parsed = configSchema.parse(config)
    const payload = await requestJson({
      fetch,
      url: 'https://api.moonshot.cn/v1/users/me/balance',
      init: { headers: { Authorization: `Bearer ${parsed.apiKey}` } },
      signal,
      label: 'Moonshot 余额查询'
    })
    const root = objectValue(payload, 'Moonshot 响应')
    const data = objectValue(root.data, 'Moonshot data')
    const definitions = [
      ['available-balance', '可用余额', 'available_balance'],
      ['cash-balance', '现金余额', 'cash_balance'],
      ['voucher-balance', '代金券余额', 'voucher_balance']
    ] as const
    const resources: QuotaResource[] = definitions.flatMap(([key, label, field]) => {
      const value = numberValue(data[field])
      return value === null
        ? []
        : [
            {
              key,
              kind: 'balance' as const,
              label,
              scope: {},
              unit: { kind: 'currency' as const, code: 'CNY' },
              available: known(value),
              expiresAt: null
            }
          ]
    })
    if (resources.length === 0) throw new Error('Moonshot 响应缺少余额字段')
    return { resources, warning: null }
  }
}
