import { z } from 'zod'
import type { QuotaResource } from '../protocol.js'
import { QuotaHttpError, requestJson } from './http.js'
import { known, numberValue, objectValue, optionalObject, timestampMs } from './resources.js'
import type { QuotaAdapter } from './types.js'

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

const configSchema = z.object({ apiKey: z.string().trim().min(1, 'API Key 不能为空') }).strict()

const WINDOWS = [
  {
    key: 'rolling',
    resourceKey: 'five-hour-quota',
    label: '5 小时额度',
    kind: 'rolling' as const,
    durationSeconds: 5 * 60 * 60
  },
  {
    key: 'weekly',
    resourceKey: 'weekly-quota',
    label: '周额度',
    kind: 'rolling' as const,
    durationSeconds: 7 * 24 * 60 * 60
  },
  {
    key: 'monthly',
    resourceKey: 'monthly-quota',
    label: '月额度',
    kind: 'billing' as const,
    durationSeconds: null
  }
] as const

export const openCodeGoAdapter: QuotaAdapter = {
  descriptor: {
    adapter: 'opencode-go',
    label: 'OpenCode Go',
    description: '查询 OpenCode Go 的 5 小时、每周和每月额度百分比。',
    dataSource: 'official_product',
    resourceKinds: ['quota'],
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
    let payload: unknown
    try {
      payload = await requestJson({
        fetch,
        url: USAGE_URL,
        init: {
          headers: {
            Authorization: `Bearer ${parsed.apiKey}`,
            Accept: 'application/json'
          }
        },
        signal,
        label: 'OpenCode Go 额度查询'
      })
    } catch (error) {
      if (error instanceof QuotaHttpError && error.status === 401) {
        throw new Error('OpenCode Go API Key 无效')
      }
      if (error instanceof QuotaHttpError && error.status === 403) {
        throw new Error('当前 API Key 没有 OpenCode Go 套餐')
      }
      throw error
    }

    const root = objectValue(payload, 'OpenCode Go 响应')
    const usage = objectValue(root.usage, 'OpenCode Go usage')
    const limited: string[] = []
    const resources: QuotaResource[] = []

    for (const definition of WINDOWS) {
      const window = optionalObject(usage[definition.key])
      if (!window) continue
      const percent = numberValue(window.percent)
      if (percent === null) continue
      const usedPercent = Math.max(0, Math.min(100, percent))
      if (window.status === 'rate-limited') limited.push(definition.label)
      resources.push({
        key: definition.resourceKey,
        kind: 'quota',
        label: definition.label,
        scope: {},
        unit: { kind: 'percentage' },
        values: {
          limit: known(100),
          used: known(usedPercent),
          remaining: known(100 - usedPercent)
        },
        window: {
          kind: definition.kind,
          durationSeconds: definition.durationSeconds,
          resetAt: timestampMs(window.resetsAt)
        }
      })
    }

    if (resources.length === 0) throw new Error('OpenCode Go 响应中没有可识别额度')
    return {
      resources,
      warning: limited.length > 0 ? `${limited.join('、')}已达上限` : null
    }
  }
}
