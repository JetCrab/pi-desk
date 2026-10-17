export const WORKSPACE_OPERATION_EVENT = 'pi-workspace:operation/v1'

export type WorkspaceExternalOperation = {
  directory: string
  command: string
  startedAt: number
  endedAt: number
  result: 'success' | 'failed'
  summary: string
  logPath: string
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseWorkspaceExternalOperation(value: unknown): WorkspaceExternalOperation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    !nonEmptyString(input.directory) ||
    !nonEmptyString(input.command) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.command) ||
    !Number.isSafeInteger(input.startedAt) ||
    !Number.isSafeInteger(input.endedAt) ||
    Number(input.startedAt) < 0 ||
    Number(input.endedAt) < Number(input.startedAt) ||
    (input.result !== 'success' && input.result !== 'failed') ||
    !nonEmptyString(input.summary) ||
    !nonEmptyString(input.logPath)
  ) {
    return null
  }

  return {
    directory: input.directory,
    command: input.command,
    startedAt: Number(input.startedAt),
    endedAt: Number(input.endedAt),
    result: input.result,
    summary: input.summary,
    logPath: input.logPath
  }
}
