import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition
} from '@earendil-works/pi-coding-agent'
import { composeSourceTool, type SourceToolDefinition } from './tool-composition.js'

const TOOL_FACTORIES: ReadonlyArray<(cwd: string) => unknown> = [
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition
]

function executionCwd(args: unknown[]): string {
  const context = args[4]
  if (!context || typeof context !== 'object') {
    throw new Error('tool-reasoning requires a Pi execution context')
  }

  const cwd = (context as { cwd?: unknown }).cwd
  if (typeof cwd !== 'string' || !cwd) {
    throw new Error('tool-reasoning requires a Pi execution cwd')
  }
  return cwd
}

// MyPi consumes extension tools without emitting session_start. Register now,
// then rebuild the original tool at execution time so every WorkSession uses ctx.cwd.
function createSourceTool(factory: (cwd: string) => unknown): SourceToolDefinition {
  const source = factory(process.cwd()) as SourceToolDefinition
  return {
    ...source,
    async execute(...args: unknown[]): Promise<unknown> {
      const runtimeSource = factory(executionCwd(args)) as SourceToolDefinition
      return runtimeSource.execute(...args)
    }
  }
}

export default function toolReasoning(pi: ExtensionAPI): void {
  for (const factory of TOOL_FACTORIES) {
    const source = createSourceTool(factory)
    pi.registerTool(composeSourceTool(source) as unknown as ToolDefinition)
  }
}
