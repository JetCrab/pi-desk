import { z } from 'zod'
import type { QuotaResource } from '../protocol.js'
import { requestJson } from './http.js'
import {
  known,
  numberValue,
  objectValue,
  resourceKey,
  stringValue,
  timestampMs
} from './resources.js'
import type { QuotaAdapter } from './types.js'

const configSchema = z
  .object({
    endpoint: z.enum(['bigmodel', 'zai']),
    apiKey: z.string().trim().min(1, 'API Key 不能为空')
  })
  .strict()

function windowPresentation(
  unit: number | null,
  amount: number | null,
  index: number
): {
  label: string
  durationSeconds: number | null
} {
  if (unit === 3 && amount !== null && amount > 0) {
    return { label: `${amount} 小时额度`, durationSeconds: amount * 60 * 60 }
  }
  if (unit === 6 && amount === 1) {
    return { label: '周额度', durationSeconds: 7 * 24 * 60 * 60 }
  }
  return { label: `Token 额度 ${index + 1}`, durationSeconds: null }
}

export const zhipuCodingPlanAdapter: QuotaAdapter = {
  descriptor: {
    adapter: 'zhipu-coding-plan',
    label: '智谱 Coding Plan',
    description: '查询 GLM Coding Plan 的周期额度。该能力属于官方产品接口。',
    dataSource: 'official_product',
    resourceKinds: ['quota'],
    fields: [
      {
        key: 'endpoint',
        kind: 'select',
        label: '服务区域',
        required: true,
        defaultValue: 'bigmodel',
        options: [
          { value: 'bigmodel', label: 'BigModel 中国站' },
          { value: 'zai', label: 'Z.AI 国际站' }
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
    const origin = parsed.endpoint === 'bigmodel' ? 'https://open.bigmodel.cn' : 'https://api.z.ai'
    const authorization = parsed.endpoint === 'bigmodel' ? parsed.apiKey : `Bearer ${parsed.apiKey}`
    const payload = await requestJson({
      fetch,
      url: `${origin}/api/monitor/usage/quota/limit`,
      init: {
        headers: {
          Authorization: authorization,
          'Accept-Encoding': 'identity',
          'Accept-Language': 'en-US,en'
        }
      },
      signal,
      label: '智谱 Coding Plan 额度查询'
    })
    const root = objectValue(payload, '智谱响应')
    if (root.success === false) {
      throw new Error(stringValue(root.msg) ?? '智谱额度查询失败')
    }
    const data = objectValue(root.data, '智谱 data')
    const limits = Array.isArray(data.limits) ? data.limits : []
    const resources: QuotaResource[] = []
    for (const [index, raw] of limits.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const limit = raw as Record<string, unknown>
      if (limit.type !== 'TOKENS_LIMIT') continue
      const usedPercent = numberValue(limit.percentage)
      if (usedPercent === null) continue
      const unit = numberValue(limit.unit)
      const amount = numberValue(limit.number)
      const presentation = windowPresentation(unit, amount, index)
      resources.push({
        key: resourceKey('tokens-limit', unit ?? 'unknown', amount ?? 'unknown', index),
        kind: 'quota',
        label: presentation.label,
        scope: {},
        unit: { kind: 'percentage' },
        values: {
          limit: known(100),
          used: known(usedPercent),
          remaining: known(Math.max(0, 100 - usedPercent))
        },
        window: {
          kind: presentation.durationSeconds === null ? 'unknown' : 'rolling',
          durationSeconds: presentation.durationSeconds,
          resetAt: timestampMs(limit.nextResetTime)
        }
      })
    }
    if (resources.length === 0) throw new Error('智谱响应中没有可识别的 Token 额度')
    return { resources, warning: null }
  }
}
