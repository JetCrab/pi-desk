export interface ContextIgnoreRule {
  currentTokensAtLeast?: number
  projectedTokensAtMost?: number
}

export interface ContextIgnoreProfile {
  /** Undefined is the lowest-priority fallback for any model context window. */
  maxContextTokens?: number
  checkpointTokens?: number
  keepRecentUserTurns: number
  processTokenBudget: number
  rules: ContextIgnoreRule[]
}

export interface ContextIgnoreSettings {
  enabled: boolean
  profiles: ContextIgnoreProfile[]
}

export const RECOMMENDED_CONTEXT_IGNORE_SETTINGS: ContextIgnoreSettings = {
  enabled: true,
  profiles: [
    {
      maxContextTokens: 400_000,
      checkpointTokens: 320_000,
      keepRecentUserTurns: 3,
      processTokenBudget: 30_000,
      rules: [{ currentTokensAtLeast: 280_000, projectedTokensAtMost: 50_000 }]
    },
    {
      maxContextTokens: 600_000,
      checkpointTokens: 480_000,
      keepRecentUserTurns: 3,
      processTokenBudget: 40_000,
      rules: [
        { currentTokensAtLeast: 400_000, projectedTokensAtMost: 50_000 },
        { currentTokensAtLeast: 500_000, projectedTokensAtMost: 100_000 }
      ]
    },
    {
      checkpointTokens: 800_000,
      keepRecentUserTurns: 3,
      processTokenBudget: 40_000,
      rules: [{ currentTokensAtLeast: 800_000, projectedTokensAtMost: 150_000 }]
    }
  ]
}

const MAX_PROFILES = 20
const MAX_RULES_PER_PROFILE = 50
const MAX_TOKEN_VALUE = 100_000_000
const MAX_KEEP_TURNS = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} 必须是 ${minimum} 到 ${maximum} 的整数`)
  }
  return value as number
}

function optionalToken(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  return requiredInteger(value, field, 0, MAX_TOKEN_VALUE)
}

function parseRule(value: unknown, path: string): ContextIgnoreRule {
  if (!isRecord(value)) throw new Error(`${path} 必须是对象`)
  const currentTokensAtLeast = optionalToken(
    value.currentTokensAtLeast,
    `${path}.currentTokensAtLeast`
  )
  const projectedTokensAtMost = optionalToken(
    value.projectedTokensAtMost,
    `${path}.projectedTokensAtMost`
  )
  if (currentTokensAtLeast === undefined && projectedTokensAtMost === undefined) {
    throw new Error(`${path} 至少需要一个判断条件`)
  }
  return {
    ...(currentTokensAtLeast === undefined ? {} : { currentTokensAtLeast }),
    ...(projectedTokensAtMost === undefined ? {} : { projectedTokensAtMost })
  }
}

function parseProfile(value: unknown, index: number): ContextIgnoreProfile {
  const path = `profiles.${index}`
  if (!isRecord(value)) throw new Error(`${path} 必须是对象`)
  const maxContextTokens = optionalToken(value.maxContextTokens, `${path}.maxContextTokens`)
  if (maxContextTokens !== undefined && maxContextTokens === 0) {
    throw new Error(`${path}.maxContextTokens 必须大于 0`)
  }
  const checkpointTokens = optionalToken(value.checkpointTokens, `${path}.checkpointTokens`)
  if (checkpointTokens !== undefined && checkpointTokens === 0) {
    throw new Error(`${path}.checkpointTokens 必须大于 0`)
  }
  const keepRecentUserTurns = requiredInteger(
    value.keepRecentUserTurns,
    `${path}.keepRecentUserTurns`,
    1,
    MAX_KEEP_TURNS
  )
  const processTokenBudget = requiredInteger(
    value.processTokenBudget,
    `${path}.processTokenBudget`,
    0,
    MAX_TOKEN_VALUE
  )
  if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES_PER_PROFILE) {
    throw new Error(`${path}.rules 必须是最多 ${MAX_RULES_PER_PROFILE} 条规则的数组`)
  }
  return {
    ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
    ...(checkpointTokens === undefined ? {} : { checkpointTokens }),
    keepRecentUserTurns,
    processTokenBudget,
    rules: value.rules.map((rule, ruleIndex) => parseRule(rule, `${path}.rules.${ruleIndex}`))
  }
}

export function normalizeContextIgnoreSettings(
  settings: ContextIgnoreSettings
): ContextIgnoreSettings {
  const profiles = settings.profiles
    .map((profile) => ({
      ...(profile.maxContextTokens === undefined
        ? {}
        : { maxContextTokens: profile.maxContextTokens }),
      ...(profile.checkpointTokens === undefined
        ? {}
        : { checkpointTokens: profile.checkpointTokens }),
      keepRecentUserTurns: profile.keepRecentUserTurns,
      processTokenBudget: profile.processTokenBudget,
      rules: profile.rules.map((rule) => ({ ...rule }))
    }))
    .sort((left, right) => {
      if (left.maxContextTokens === undefined) return 1
      if (right.maxContextTokens === undefined) return -1
      return left.maxContextTokens - right.maxContextTokens
    })
  return { enabled: settings.enabled, profiles }
}

export function parseContextIgnoreSettings(value: unknown): ContextIgnoreSettings {
  if (!isRecord(value)) throw new Error('上下文忽略配置必须是对象')
  if (typeof value.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
  if (
    !Array.isArray(value.profiles) ||
    value.profiles.length === 0 ||
    value.profiles.length > MAX_PROFILES
  ) {
    throw new Error(`profiles 必须包含 1 到 ${MAX_PROFILES} 个模型配置`)
  }

  const profiles = value.profiles.map(parseProfile)
  const fallbackCount = profiles.filter((profile) => profile.maxContextTokens === undefined).length
  if (fallbackCount !== 1) throw new Error('必须且只能有一个不限制模型窗口的通用配置')

  const boundedLimits = profiles
    .map((profile) => profile.maxContextTokens)
    .filter((limit): limit is number => limit !== undefined)
  if (new Set(boundedLimits).size !== boundedLimits.length) {
    throw new Error('模型窗口上限不能重复')
  }

  return normalizeContextIgnoreSettings({ enabled: value.enabled, profiles })
}

export function defaultContextIgnoreSettings(): ContextIgnoreSettings {
  return normalizeContextIgnoreSettings(RECOMMENDED_CONTEXT_IGNORE_SETTINGS)
}

export function selectContextIgnoreProfile(
  settings: ContextIgnoreSettings,
  contextWindow: number
): ContextIgnoreProfile {
  const normalized = normalizeContextIgnoreSettings(settings)
  const fallback = normalized.profiles.find((profile) => profile.maxContextTokens === undefined)!
  if (contextWindow <= 0) return fallback
  return (
    normalized.profiles.find(
      (profile) =>
        profile.maxContextTokens === undefined || contextWindow <= profile.maxContextTokens
    ) ?? fallback
  )
}

export function matchesContextIgnoreRule(
  rule: ContextIgnoreRule,
  currentTokens: number,
  projectedTokens: number
): boolean {
  return (
    (rule.currentTokensAtLeast === undefined || currentTokens >= rule.currentTokensAtLeast) &&
    (rule.projectedTokensAtMost === undefined || projectedTokens <= rule.projectedTokensAtMost)
  )
}

export function findMatchingContextIgnoreRule(
  rules: readonly ContextIgnoreRule[],
  currentTokens: number,
  projectedTokens: number
): number | undefined {
  const index = rules.findIndex((rule) =>
    matchesContextIgnoreRule(rule, currentTokens, projectedTokens)
  )
  return index < 0 ? undefined : index
}
