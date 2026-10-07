import { z } from 'zod'

export const CapabilityKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

const CapabilityPatternSchema = z.string().trim().min(1).max(256)

export const CapabilityRuleSchema = z
  .object({
    allow: z.array(CapabilityPatternSchema).max(5000).optional(),
    deny: z.array(CapabilityPatternSchema).max(5000).optional()
  })
  .strict()

export const CapabilityOptionSchema = z
  .object({
    value: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).optional()
  })
  .strict()

export const CapabilityDeclarationSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    options: z.array(CapabilityOptionSchema).max(5000)
  })
  .strict()

export const CapabilityDeclarationsSchema = z.record(
  CapabilityKeySchema,
  CapabilityDeclarationSchema
)

export const CapabilityModeKeySchema = z.string().min(1).max(64)
export const CapabilityModeSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    tools: CapabilityRuleSchema.optional(),
    skills: CapabilityRuleSchema.optional(),
    plugins: z
      .record(CapabilityKeySchema, z.record(CapabilityKeySchema, CapabilityRuleSchema))
      .optional()
  })
  .strict()
export const CapabilityModesSchema = z
  .record(CapabilityModeKeySchema, CapabilityModeSchema)
  .refine((modes) => Object.keys(modes).length <= 100, '最多保存 100 个能力模式')
  .refine(
    (modes) =>
      new Set(Object.values(modes).map((mode) => mode.name)).size === Object.keys(modes).length,
    '模式名称不能重复'
  )
export const CapabilityModeNamesSchema = z.record(
  CapabilityModeKeySchema,
  CapabilityModeSchema.shape.name
)
export const CapabilityCatalogSchema = z
  .object({
    tools: z.array(CapabilityOptionSchema),
    skills: z.array(CapabilityOptionSchema),
    plugins: z.record(CapabilityKeySchema, CapabilityDeclarationsSchema)
  })
  .strict()

export const SessionCapabilityRulesSchema = z
  .object({
    tools: CapabilityRuleSchema,
    skills: CapabilityRuleSchema,
    capabilities: z.record(CapabilityKeySchema, CapabilityRuleSchema)
  })
  .strict()

export type CapabilityMode = z.infer<typeof CapabilityModeSchema>
export type CapabilityModes = z.infer<typeof CapabilityModesSchema>
export type CapabilityModeNames = z.infer<typeof CapabilityModeNamesSchema>
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>
export type CapabilityRule = z.infer<typeof CapabilityRuleSchema>
export type CapabilityOption = z.infer<typeof CapabilityOptionSchema>
export type CapabilityDeclaration = z.infer<typeof CapabilityDeclarationSchema>
export type CapabilityDeclarations = z.infer<typeof CapabilityDeclarationsSchema>
export type SessionCapabilityRules = z.infer<typeof SessionCapabilityRulesSchema>

function matchesCapability(pattern: string, value: string): boolean {
  let patternIndex = 0
  let valueIndex = 0
  let starIndex = -1
  let retryIndex = 0
  while (valueIndex < value.length) {
    if (pattern[patternIndex] === '*') {
      starIndex = patternIndex++
      retryIndex = valueIndex
    } else if (pattern[patternIndex] === value[valueIndex]) {
      patternIndex += 1
      valueIndex += 1
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1
      valueIndex = ++retryIndex
    } else {
      return false
    }
  }
  while (pattern[patternIndex] === '*') patternIndex += 1
  return patternIndex === pattern.length
}

/** Names are matched independently of discovery; a missing allowlist adds no restriction. */
export function isCapabilityAllowed(rule: CapabilityRule | undefined, value: string): boolean {
  return (
    (rule?.allow === undefined ||
      rule.allow.some((pattern) => matchesCapability(pattern, value))) &&
    !rule?.deny?.some((pattern) => matchesCapability(pattern, value))
  )
}
