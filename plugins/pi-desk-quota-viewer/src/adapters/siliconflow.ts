import { z } from 'zod'
import type { QuotaResource } from '../protocol.js'
import { requestJson } from './http.js'
import { known, numberValue, objectValue } from './resources.js'
import type { QuotaAdapter } from './types.js'

const configSchema = z
  .object({
    region: z.enum(['cn', 'global']),
    apiKey: z.string().trim().min(1, 'API Key 不能为空')
  })
  .strict()

export const siliconFlowAdapter: QuotaAdapter = {
  descriptor: {
    adapter: 'siliconflow',
    label: 'SiliconFlow',
    description: '查询 SiliconFlow 用户余额，不推断接口未声明的币种。',
    dataSource: 'official_api',
    resourceKinds: ['balance'],
    fields: [
      {
        key: 'region',
        kind: 'select',
        label: '区域',
        required: true,
        defaultValue: 'cn',
        options: [
          { value: 'cn', label: '中国站（siliconflow.cn）' },
          { value: 'global', label: '国际站（siliconflow.com）' }
        ]
      },
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
    const origin =
      parsed.region === 'cn' ? 'https://api.siliconflow.cn' : 'https://api.siliconflow.com'
    const payload = await requestJson({
      fetch,
      url: `${origin}/v1/user/info`,
      init: { headers: { Authorization: `Bearer ${parsed.apiKey}` } },
      signal,
      label: 'SiliconFlow 余额查询'
    })
    const root = objectValue(payload, 'SiliconFlow 响应')
    const data = objectValue(root.data, 'SiliconFlow data')
    const definitions = [
      ['balance', '余额', 'balance'],
      ['charge-balance', '充值余额', 'chargeBalance'],
      ['total-balance', '总余额', 'totalBalance']
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
              unit: { kind: 'custom' as const, label: '余额' },
              available: known(value),
              expiresAt: null
            }
          ]
    })
    if (resources.length === 0) throw new Error('SiliconFlow 响应缺少余额字段')
    return { resources, warning: null }
  }
}
