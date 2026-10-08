export const usageRecords = [
  {
    model: 'Claude Sonnet 4.6',
    agent: '主代理自身',
    today: true,
    input: 120000,
    cached: 84000,
    output: 8000,
    cost: 0.48,
    calls: 10,
    slot: 2
  },
  {
    model: 'Claude Sonnet 4.6',
    agent: '导出逻辑调查',
    today: true,
    input: 60000,
    cached: 42000,
    output: 4000,
    cost: 0.24,
    calls: 4,
    slot: 3
  },
  {
    model: 'GPT-5.4',
    agent: '主代理自身',
    today: false,
    input: 40000,
    cached: 12000,
    output: 4000,
    cost: 0.16,
    calls: 4,
    slot: 0
  },
  {
    model: 'GPT-5.4',
    agent: '导出逻辑调查',
    today: false,
    input: 20000,
    cached: 6000,
    output: 2000,
    cost: 0.08,
    calls: 2,
    slot: 1
  }
] as const
export type UsageRecord = (typeof usageRecords)[number]
export type UsageTotal = {
  input: number
  cached: number
  output: number
  cost: number
  calls: number
}
export function sumUsage(records: readonly UsageRecord[]): UsageTotal {
  return records.reduce(
    (total, record) => ({
      input: total.input + record.input,
      cached: total.cached + record.cached,
      output: total.output + record.output,
      cost: total.cost + record.cost,
      calls: total.calls + record.calls
    }),
    { input: 0, cached: 0, output: 0, cost: 0, calls: 0 }
  )
}
export function usageMetrics(total: UsageTotal): [string, string][] {
  return [
    ['输入总量', `${total.input / 1000}k`],
    ['缓存命中率', `${(total.input ? (total.cached / total.input) * 100 : 0).toFixed(1)}%`],
    ['费用', `$${total.cost.toFixed(2)}`]
  ]
}
