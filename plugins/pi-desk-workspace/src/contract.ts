export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type ParameterType = 'string' | 'boolean' | 'integer' | 'number' | 'array'

export type ParameterItemSchema = {
  type: ParameterType
  description?: string
  enum?: JsonValue[]
  items?: ParameterItemSchema
}

export type ParameterProperty = ParameterItemSchema & {
  required: boolean
  default?: JsonValue
}

export type ParametersSchema = {
  properties: Record<string, ParameterProperty>
}

export type WorkspaceStatus = 'available' | 'occupied'
export type WorkspaceCommandTarget = WorkspaceStatus | 'removed'
export type WorkspaceOperationResult = 'success' | 'failed' | 'unknown' | null

export type WorkspaceOperation = {
  command: string
  startedAt: number
  endedAt: number | null
  result: WorkspaceOperationResult
  summary?: string
  logPath: string
}

export type WorkspaceOccupation = {
  id: string
  requirement: string
  occupiedAt: number
  sourceSessionId?: string
  operations: WorkspaceOperation[]
}

export type WorkspaceCommandSummary = {
  id: string
  description: string
  from: WorkspaceStatus[]
  onSuccess: WorkspaceCommandTarget
  parameters: ParametersSchema
}

export type WorkspaceDefinitionSummary = {
  id: string
  description: string
  provision: {
    description: string
    parameters: ParametersSchema
  }
  commands: WorkspaceCommandSummary[]
}

export type WorkspaceSnapshotItem = {
  id: string
  workspaceRef: string | null
  definition: string
  root: string
  status: WorkspaceStatus
  occupation: WorkspaceOccupation | null
  active: boolean
  issue: string | null
}

export type WorkspaceConfigSnapshot = {
  status: 'missing' | 'invalid' | 'ready'
  path: string
  error: string | null
}

export type WorkspaceSnapshot = {
  trusted: boolean
  config: WorkspaceConfigSnapshot
  definitions: WorkspaceDefinitionSummary[]
  workspaces: WorkspaceSnapshotItem[]
  active: string | null
}

export type WorkspaceChangedEvent = {
  workspaceId: string | null
  summary?: string
}
