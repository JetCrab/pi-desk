import type { QuotaAccount, QuotaResource, QuotaSourceSnapshot } from '../src/protocol.js'

export function account(
  resources: QuotaResource[] = [],
  overrides: Partial<QuotaAccount> = {}
): QuotaAccount {
  return {
    key: 'account',
    type: 'codex',
    name: 'sample@example.com',
    plan: 'Pro',
    status: 'active',
    error: null,
    observedAt: 1_800_000_000_000,
    resources,
    ...overrides
  }
}

export function balance(key: string, value = 0, label = '余额'): QuotaResource {
  return {
    key,
    kind: 'balance',
    label,
    scope: {},
    unit: { kind: 'currency', code: 'USD' },
    available: { state: 'known', value },
    expiresAt: null
  }
}

export function quota(key: string, label = '周额度', seconds = 604800): QuotaResource {
  return {
    key,
    kind: 'quota',
    label,
    scope: {},
    unit: { kind: 'percentage' },
    values: {
      limit: { state: 'known', value: 100 },
      used: { state: 'known', value: 25 },
      remaining: { state: 'known', value: 75 }
    },
    window: { kind: 'rolling', durationSeconds: seconds, resetAt: 1_800_005_000_000 }
  }
}

export function source(
  adapter: string,
  accounts: QuotaAccount[],
  overrides: Partial<QuotaSourceSnapshot> = {}
): QuotaSourceSnapshot {
  return {
    sourceId: '11111111-1111-4111-8111-111111111111',
    adapter,
    adapterLabel: adapter,
    name: adapter,
    dataSource: 'internal_api',
    refreshing: false,
    observedAt: 1_800_000_000_000,
    staleAt: 1_800_000_300_000,
    error: null,
    accounts,
    ...overrides
  }
}
