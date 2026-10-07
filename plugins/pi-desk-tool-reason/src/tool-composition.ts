export interface SourceToolDefinition {
  name: string
  parameters: Record<string, unknown>
  execute: (...args: unknown[]) => Promise<unknown>
  [key: string]: unknown
}

const REASONING_DESCRIPTION =
  'Short phrase (≤12 words) stating the GOAL behind this call — the why-in-context, not the what. Do NOT restate the file, path, or command; instead give the intent or what you expect to find/confirm.'

function withReasoning(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = parameters.properties
  const sourceProperties = properties && typeof properties === 'object' ? properties : {}

  return {
    ...parameters,
    properties: {
      reasoning: {
        type: 'string',
        description: REASONING_DESCRIPTION
      },
      ...sourceProperties
    }
  }
}

function withoutReasoning(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object') return {}
  const { reasoning: _reasoning, ...rest } = params as Record<string, unknown>
  return rest
}

export function composeSourceTool(source: SourceToolDefinition): SourceToolDefinition {
  const properties = source.parameters.properties
  if (properties && typeof properties === 'object' && Object.hasOwn(properties, 'reasoning')) {
    throw new Error(`${source.name} source schema already defines reasoning`)
  }

  const sourceExecute = source.execute
  const tool: SourceToolDefinition = {
    ...source,
    parameters: withReasoning(source.parameters),
    async execute(...args: unknown[]): Promise<unknown> {
      args[1] = withoutReasoning(args[1])
      return sourceExecute.call(source, ...args)
    }
  }

  delete tool.renderCall
  delete tool.renderResult
  delete tool.renderShell
  return tool
}
