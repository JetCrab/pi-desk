import { z } from 'zod'
import { L4LocalizedTextSchema } from '@common/l4_foundation/locale/l4-localized-text'

export const L3ConversationPiDeskSummarySchema = z
  .object({ input: z.record(z.string(), z.json()) })
  .strict()
export const L3ConversationPiDeskDetailSchema = z.object({ output: z.string() }).strict()

const labels = {
  help: 'pideskHelp',
  version: 'pideskVersion',
  info: 'pideskInfo',
  reload: 'pideskReload',
  list: 'pideskListPlugins',
  show: 'pideskShowPlugin',
  install: 'pideskInstallPlugin',
  remove: 'pideskRemovePlugin'
} as const

type PiDeskLabel = (typeof labels)[keyof typeof labels]
export interface L3ConversationPiDeskCommand {
  command: string
  label: PiDeskLabel | null
  name: string | null
  version: string | null
}

const pluginNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function quoteArgument(argument: string): string {
  return /^[a-zA-Z0-9_./:@=+-]+$/.test(argument) ? argument : JSON.stringify(argument)
}

export function readL3ConversationPiDeskCommand(
  input: z.infer<typeof L3ConversationPiDeskSummarySchema>['input']
): L3ConversationPiDeskCommand {
  const args = input.args
  const fallback: L3ConversationPiDeskCommand = {
    command: Object.keys(input).length === 0 ? 'pidesk' : `pidesk ${JSON.stringify(input)}`,
    label: null,
    name: null,
    version: null
  }
  if (
    Object.keys(input).length !== 1 ||
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === 'string')
  ) {
    return fallback
  }
  fallback.command = ['pidesk', ...args.map(quoteArgument)].join(' ')
  const path = args.some((arg) => /\s/.test(arg)) ? '' : args.join(' ')
  if (
    args.length === 0 ||
    [
      '--help',
      '-h',
      'plugins',
      'session',
      'plugins --help',
      'plugins -h',
      'session --help',
      'session -h'
    ].includes(path)
  ) {
    return { ...fallback, label: labels.help }
  }
  if (path === '--version') return { ...fallback, label: labels.version }
  if (path === 'info') return { ...fallback, label: labels.info }
  if (path === 'session reload') return { ...fallback, label: labels.reload }
  if (
    args.length === 3 &&
    ['--help', '-h'].includes(args[2]!) &&
    ((args[0] === 'plugins' && ['list', 'show', 'install', 'remove'].includes(args[1]!)) ||
      (args[0] === 'session' && args[1] === 'reload'))
  ) {
    return { ...fallback, label: labels.help }
  }
  const action = args[1]
  if (args[0] !== 'plugins' || !action || !['list', 'show', 'install', 'remove'].includes(action))
    return fallback
  let scope: string | null = null
  let name: string | null = null
  let version: string | null = null
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--scope' && scope === null && args[index + 1] === 'global') {
      scope = args[++index]!
    } else if (
      argument === '--version' &&
      action === 'install' &&
      version === null &&
      versionPattern.test(args[index + 1] ?? '')
    ) {
      version = args[++index]!
    } else if (
      action !== 'list' &&
      name === null &&
      argument !== 'node_modules' &&
      pluginNamePattern.test(argument)
    ) {
      name = argument
    } else {
      return fallback
    }
  }
  if (action !== 'list' && (name === null || scope === null)) return fallback
  switch (action) {
    case 'list':
      return { ...fallback, label: labels.list }
    case 'show':
      return { ...fallback, label: labels.show, name }
    case 'install':
      return { ...fallback, label: labels.install, name, version }
    case 'remove':
      return { ...fallback, label: labels.remove, name }
    default:
      return fallback
  }
}

const pluginSchema = z
  .object({
    name: z.string(),
    scope: z.literal('global').optional(),
    source: z.string(),
    kind: z.enum(['package', 'extension']),
    version: z.string().nullable(),
    status: z.enum(['ready', 'available', 'disabled', 'failed']),
    operation: z
      .object({
        action: z.enum(['add', 'update', 'del', 'apply']),
        phase: z.enum(['queued', 'checking', 'applying', 'waiting', 'failed']),
        message: z.string().nullable()
      })
      .strict()
      .nullish(),
    error: z
      .object({
        phase: z.enum(['package', 'entry', 'setup', 'resources', 'resolve', 'native']),
        message: L4LocalizedTextSchema
      })
      .strict()
      .nullish()
  })
  .strict()
const pluginsSchema = z
  .object({
    plugins: z.array(pluginSchema),
    restartRequired: z.boolean(),
    loadError: L4LocalizedTextSchema.nullish()
  })
  .strict()
const pluginDetailSchema = pluginSchema.extend({ detail: z.record(z.string(), z.json()) }).strict()
const infoSchema = z
  .object({
    version: z.string(),
    environment: z.enum(['development', 'production']),
    mode: z.enum(['basic', 'normal']),
    cwd: z.string(),
    agentDir: z.string(),
    skillDirectory: z.string()
  })
  .strict()

export type L3ConversationPiDeskPlugin = z.infer<typeof pluginSchema>
export type L3ConversationPiDeskOutput =
  | { kind: 'plugins'; data: z.infer<typeof pluginsSchema> }
  | { kind: 'plugin'; data: z.infer<typeof pluginDetailSchema> }
  | { kind: 'info'; data: z.infer<typeof infoSchema> }

export function readL3ConversationPiDeskOutput(
  label: PiDeskLabel | null,
  output: string
): L3ConversationPiDeskOutput | null {
  if (!['pideskListPlugins', 'pideskShowPlugin', 'pideskInfo'].includes(label ?? '')) return null
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return null
  }
  switch (label) {
    case 'pideskListPlugins': {
      const parsed = pluginsSchema.safeParse(value)
      return parsed.success ? { kind: 'plugins', data: parsed.data } : null
    }
    case 'pideskShowPlugin': {
      const parsed = pluginDetailSchema.safeParse(value)
      return parsed.success ? { kind: 'plugin', data: parsed.data } : null
    }
    case 'pideskInfo': {
      const parsed = infoSchema.safeParse(value)
      return parsed.success ? { kind: 'info', data: parsed.data } : null
    }
    default:
      return null
  }
}
