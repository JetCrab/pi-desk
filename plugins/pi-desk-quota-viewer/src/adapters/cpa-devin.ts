import type { QuotaResource } from '../protocol.js'
import type { CpaAccountLoadInput, CpaAccountQuota } from './cpa.js'
import {
  known,
  numberValue,
  objectValue,
  optionalObject,
  stringValue,
  timestampMs,
  unknown
} from './resources.js'

const DEVIN_STATUS_URL =
  'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus'

function remainingPercent(value: unknown): number | null {
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null
  const percent = numberValue(value)
  return percent !== null && percent >= 0 && percent <= 100 ? percent : null
}

function parseQuota(payload: unknown): CpaAccountQuota {
  const root = objectValue(payload, 'Devin GetUserStatus 响应')
  const userStatus = optionalObject(root.userStatus)
  const planStatus = optionalObject(userStatus?.planStatus)
  const planInfo = optionalObject(planStatus?.planInfo)
  const plan = stringValue(planInfo?.planName)
  const resources: QuotaResource[] = []
  if (planStatus) {
    for (const [period, label, durationSeconds] of [
      ['daily', '日额度', 86400],
      ['weekly', '周额度', 604800]
    ] as const) {
      const remaining = remainingPercent(planStatus[`${period}QuotaRemainingPercent`])
      const resetAt = timestampMs(planStatus[`${period}QuotaResetAtUnix`])
      if (remaining === null && resetAt === null) continue
      resources.push({
        key: period,
        kind: 'quota',
        label,
        scope: {},
        unit: { kind: 'percentage' },
        values: {
          limit: known(100),
          used: remaining === null ? unknown() : known(100 - remaining),
          remaining: remaining === null ? unknown() : known(remaining)
        },
        window: { kind: 'unknown', durationSeconds, resetAt }
      })
    }
  }
  return { plan, resources }
}

export async function loadDevinAccount(input: CpaAccountLoadInput): Promise<CpaAccountQuota> {
  const body = await input.request({
    auth_index: input.authIndex,
    method: 'POST',
    url: DEVIN_STATUS_URL,
    header: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
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
  const quota = parseQuota(body)
  if (quota.resources.length === 0) throw new Error(`账号 ${input.account} 未返回可识别额度`)
  return quota
}
