import type { L3PiNativeCommandSource } from '@common/l3_modules/plugin-host/l3-plugin-native-pi-contract'

export const L2_WORKBENCH_SLASH_COMMAND_MENU_ID = 'l2-workbench-slash-command-menu'

export type L2WorkbenchSlashCommandSource = 'builtin' | L3PiNativeCommandSource

export interface L2WorkbenchSlashCommandCandidate {
  key: string
  name: string
  description: string | null
  source: L2WorkbenchSlashCommandSource
}

export interface L2WorkbenchSlashCommandGroup {
  source: L2WorkbenchSlashCommandSource
  label: string
  commands: readonly L2WorkbenchSlashCommandCandidate[]
}

export const L2_WORKBENCH_RELOAD_COMMAND = {
  key: 'builtin:reload',
  name: 'reload',
  description: '重新读取 Pi 最新配置与扩展资源',
  source: 'builtin'
} as const satisfies L2WorkbenchSlashCommandCandidate

const L2_WORKBENCH_SLASH_COMMAND_GROUPS: ReadonlyArray<{
  source: L2WorkbenchSlashCommandSource
  label: string
}> = [
  { source: 'builtin', label: 'Pi 内置命令' },
  { source: 'skill', label: 'Skills' },
  { source: 'prompt', label: '提示模板' },
  { source: 'extension', label: '扩展命令' }
]

export function readL2WorkbenchSlashCommandQuery(text: string): string | null {
  return /^\/[^\s/]*$/.test(text) ? text.slice(1) : null
}

function commandMatchScore(
  command: L2WorkbenchSlashCommandCandidate,
  normalizedQuery: string
): number {
  if (!normalizedQuery) return 3

  const name = command.name.toLocaleLowerCase()
  const description = command.description?.toLocaleLowerCase() ?? ''
  if (name === normalizedQuery) return 0
  if (name.startsWith(normalizedQuery)) return 1
  if (name.includes(normalizedQuery)) return 2
  if (description.includes(normalizedQuery)) return 4
  return Number.POSITIVE_INFINITY
}

export function buildL2WorkbenchSlashCommandGroups(
  commands: readonly L2WorkbenchSlashCommandCandidate[],
  query: string
): readonly L2WorkbenchSlashCommandGroup[] {
  const normalizedQuery = query.toLocaleLowerCase()

  return L2_WORKBENCH_SLASH_COMMAND_GROUPS.flatMap((group) => {
    const matches = commands
      .map((command, order) => ({
        command,
        order,
        score: commandMatchScore(command, normalizedQuery)
      }))
      .filter((item) => item.command.source === group.source && Number.isFinite(item.score))
      .sort((left, right) => {
        if (left.score !== right.score) return left.score - right.score
        if (normalizedQuery) return left.order - right.order
        return left.command.name.localeCompare(right.command.name)
      })
      .map((item) => item.command)

    return matches.length > 0 ? [{ ...group, commands: matches }] : []
  })
}

export function getL2WorkbenchSlashCommandOptionId(index: number): string {
  return `${L2_WORKBENCH_SLASH_COMMAND_MENU_ID}-option-${index}`
}
