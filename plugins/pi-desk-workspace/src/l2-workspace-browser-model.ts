import type {
  JsonValue,
  ParametersSchema,
  WorkspaceCommandSummary,
  WorkspaceOperation,
  WorkspaceSnapshotItem
} from './contract.js'
import { shortWorkspaceTitle } from './l4-workspace-title.js'

export type WorkspaceDetailTab = 'actions' | 'records' | 'info'
export type WorkspaceFormValue = string | boolean
export type WorkspaceForm = Record<string, WorkspaceFormValue>
export type WorkspaceCommandDraft = {
  commandId: string
  workspaceRef: string
  values: WorkspaceForm
  confirmation: Record<string, JsonValue> | null
}
export type WorkspaceDialogState = {
  workspaceId: string
  tab: WorkspaceDetailTab
  command: WorkspaceCommandDraft | null
}

export function initialWorkspaceForm(schema: ParametersSchema): WorkspaceForm {
  const values: WorkspaceForm = {}
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = property.default ?? property.enum?.[0]
    if (property.type === 'boolean') {
      values[name] = value === true
    } else {
      values[name] =
        value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
    }
  }
  return values
}

export function parseWorkspaceForm(
  schema: ParametersSchema,
  values: WorkspaceForm
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  for (const [name, property] of Object.entries(schema.properties)) {
    const raw = values[name]
    if (property.type === 'boolean') {
      result[name] = raw === true
      continue
    }
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) {
      if (property.required && property.default === undefined) throw new Error(`${name} 是必填参数`)
      if (property.default !== undefined) result[name] = property.default
      continue
    }
    if (property.enum) {
      const value = property.enum.find(
        (item) => (typeof item === 'string' ? item : JSON.stringify(item)) === text
      )
      if (value === undefined) throw new Error(`${name} 不是允许的值`)
      result[name] = value
    } else if (property.type === 'integer' || property.type === 'number') {
      const value = Number(text)
      if (!Number.isFinite(value) || (property.type === 'integer' && !Number.isInteger(value))) {
        throw new Error(`${name} 必须是${property.type === 'integer' ? '整数' : '数字'}`)
      }
      result[name] = value
    } else if (property.type === 'array') {
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new Error(`${name} 必须是 JSON 数组`)
      }
      if (!Array.isArray(value)) throw new Error(`${name} 必须是 JSON 数组`)
      result[name] = value as JsonValue[]
    } else {
      result[name] = text
    }
  }
  return result
}

export function workspaceDisplayName(workspace: WorkspaceSnapshotItem): string {
  return shortWorkspaceTitle(workspace.occupation?.requirement ?? workspace.definition)
}

export function workspaceProjectName(cwd: string): string {
  return (
    cwd
      .replace(/[\\/]+$/u, '')
      .split(/[\\/]/u)
      .at(-1) || cwd
  )
}

export function workspaceGroups(workspaces: WorkspaceSnapshotItem[]): {
  occupied: WorkspaceSnapshotItem[]
  available: WorkspaceSnapshotItem[]
} {
  return {
    occupied: workspaces
      .filter((workspace) => workspace.status === 'occupied')
      .sort((left, right) => right.occupation!.occupiedAt - left.occupation!.occupiedAt),
    available: workspaces.filter((workspace) => workspace.status === 'available')
  }
}

export function workspaceDuration(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000)
  if (minutes === 0) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

export function workspaceOperations(operations: WorkspaceOperation[]): WorkspaceOperation[] {
  return [...operations].reverse().sort((left, right) => right.startedAt - left.startedAt)
}

export function operationName(operation: WorkspaceOperation): string {
  if (operation.command === 'provision') return '初始化工作区'
  return operation.command
}

export function workspaceTimeFormatter(locale: 'zh-CN' | 'en'): Intl.DateTimeFormat {
  let timeZone = 'UTC'
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    // 浏览器无法识别时区时按 UTC 展示。
  }
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }
  try {
    return new Intl.DateTimeFormat(locale, options)
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' })
  }
}

export function workspaceTime(value: number | null, formatter: Intl.DateTimeFormat): string {
  if (value === null) return '运行中'
  return formatter.format(value)
}

export function workspaceUsage(workspace: WorkspaceSnapshotItem): string | null {
  if (workspace.issue) return '工作区异常'
  const latest = workspaceOperations(workspace.occupation?.operations ?? [])[0]
  if (!latest) return null
  if (latest.result === null) return `${shortWorkspaceTitle(latest.command)} 运行中`
  if (latest.result === 'failed') return '最近操作失败'
  if (latest.result === 'unknown') return '结果未知'
  return null
}

export function operationLabel(operation: WorkspaceOperation): {
  label: string
  tone: 'success' | 'error' | 'warning'
} {
  if (operation.result === 'success') return { label: '成功', tone: 'success' }
  if (operation.result === 'failed') return { label: '失败', tone: 'error' }
  if (operation.result === 'unknown') return { label: '结果未知', tone: 'warning' }
  return { label: '运行中', tone: 'warning' }
}

export function commandActionLabel(command: WorkspaceCommandSummary): string {
  if (command.onSuccess === 'available') return '重置工作区'
  if (command.onSuccess === 'removed') return '删除工作区'
  return '执行'
}

export function commandImpact(command: WorkspaceCommandSummary): string | null {
  if (command.onSuccess === 'removed')
    return '将删除工作区目录及其中的项目文件、依赖和插件元数据，删除后不可恢复。'
  if (command.onSuccess === 'available')
    return '将清除当前需求、来源会话关联和本次占用记录，并由项目脚本恢复为可复用状态。未提交文件可能被清理，请先保存或提交；来源聊天本身不会被删除。'
  return null
}
