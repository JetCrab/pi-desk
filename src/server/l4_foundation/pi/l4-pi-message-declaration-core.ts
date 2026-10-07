import type {
  PluginMessageDeclaration,
  PluginMessageDeclarationInput,
  PluginJsonObject,
  PluginJsonValue,
  PluginMessageProjectionResult,
  PluginNativePiMessage,
  PluginSource
} from '@jetcrab/pi-desk-sdk/entry'
import { z } from 'zod'
import { L4ProjectFilePreviewPathSchema } from '@common/l4_foundation/file/l4-project-file-contract'
import type { L4PiChatMessage } from './l4-pi-chat-projection'

const L4PiDeskToolResultSchema = z
  .object({ mode: z.enum(['sync', 'async']), message: z.string() })
  .strict()
const RESERVED_ERROR_VIEW_KEY = 'pi-desk/message-declaration-error'
const reportedDeclarationErrors = new WeakMap<PluginMessageDeclaration, Set<string>>()
const L4PiProjectionSchema = z
  .object({
    viewKey: z
      .string()
      .trim()
      .min(3)
      .max(129)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
    summary: z.record(z.string(), z.json()),
    detail: z.record(z.string(), z.json()).nullable()
  })
  .strict()

interface L4PiDeclarationCandidate {
  pluginName: string
  declarationName: string
  declaration: PluginMessageDeclaration
  builtin: boolean
}

type L4PiDeclarationErrorPhase = 'match' | 'conflict' | 'project' | 'validate'

function defaultViewKey(message: L4PiChatMessage): string {
  switch (message.type) {
    case 'user':
      return 'pi-desk/user'
    case 'assistant':
      return 'pi-desk/assistant'
    case 'tool': {
      const normalized = message.name.toLowerCase().split('.').at(-1)
      if (normalized === 'pidesk') return 'pi-desk/pidesk'
      if (normalized === 'bash') return 'pi-desk/bash-tool'
      if (normalized === 'codemode') return 'pi-desk/codemode'
      return normalized === 'read' || normalized === 'write' || normalized === 'edit'
        ? `pi-desk/${normalized}`
        : 'pi-desk/tool'
    }
    case 'bash':
      return 'pi-desk/bash'
    case 'custom':
      return 'pi-desk/custom'
    case 'compaction':
      return 'pi-desk/compaction'
  }
}

type NativeToolMessage = Extract<PluginNativePiMessage, { kind: 'tool' }>

type JsonRecord = Record<string, PluginJsonValue>

function jsonRecord(value: PluginJsonValue): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function filePreviewPath(message: NativeToolMessage): string | null {
  const value = message.arguments.path ?? message.arguments.file_path
  if (typeof value !== 'string') return null
  const parsed = L4ProjectFilePreviewPathSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function toolResultRecord(message: NativeToolMessage): JsonRecord | null {
  return jsonRecord(message.result)
}

function toolResultText(message: NativeToolMessage): string | null {
  const result = toolResultRecord(message)
  if (!result) return null
  const content = result.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    let found = false
    for (const part of content) {
      const record = jsonRecord(part)
      if (record?.type !== 'text' || typeof record.text !== 'string') continue
      found = true
      texts.push(record.text)
    }
    if (found) return texts.join('\n')
  }
  return typeof result.output === 'string' ? result.output : null
}

function toolResultHasImage(message: NativeToolMessage): boolean {
  const content = toolResultRecord(message)?.content
  return (
    Array.isArray(content) &&
    content.some((part) => {
      const record = jsonRecord(part)
      return record?.type === 'image'
    })
  )
}

function toolResultDetails(message: NativeToolMessage): JsonRecord | null {
  return jsonRecord(toolResultRecord(message)?.details ?? null)
}

function defaultToolOutput(projection: PluginMessageProjectionResult): string | null {
  return typeof projection.detail?.output === 'string' ? projection.detail.output : null
}

function fileToolSummary(
  projection: PluginMessageProjectionResult,
  message: NativeToolMessage
): PluginJsonObject {
  return {
    ...projection.summary,
    path: filePreviewPath(message)
  }
}

function builtinToolProjection(
  projection: PluginMessageProjectionResult,
  message: NativeToolMessage
): PluginMessageProjectionResult {
  const output = toolResultText(message) ?? defaultToolOutput(projection)
  switch (projection.viewKey) {
    case 'pi-desk/pidesk': {
      let content = output ?? ''
      try {
        const parsed = L4PiDeskToolResultSchema.safeParse(JSON.parse(content))
        if (parsed.success) content = parsed.data.message
      } catch {
        // 普通文本和截断结果必须保留原文，不能因为解析失败丢失输出。
      }
      return {
        viewKey: projection.viewKey,
        summary: { input: message.arguments },
        detail: { output: content }
      }
    }
    case 'pi-desk/read':
      return {
        viewKey: projection.viewKey,
        summary: fileToolSummary(projection, message),
        detail: toolResultHasImage(message) ? null : output === null ? null : { content: output }
      }
    case 'pi-desk/edit': {
      const diff = toolResultDetails(message)?.diff
      return {
        viewKey: projection.viewKey,
        summary: fileToolSummary(projection, message),
        detail:
          !message.isError && typeof diff === 'string'
            ? { kind: 'diff', content: diff }
            : output === null
              ? null
              : { kind: 'output', content: output }
      }
    }
    case 'pi-desk/write': {
      const content = message.arguments.content
      return {
        viewKey: projection.viewKey,
        summary: fileToolSummary(projection, message),
        detail:
          message.isError && output !== null
            ? { kind: 'output', content: output }
            : typeof content === 'string'
              ? { kind: 'content', content }
              : output === null
                ? null
                : { kind: 'output', content: output }
      }
    }
    default:
      return projection
  }
}

function userDisplayText(message: Extract<L4PiChatMessage, { type: 'user' }>): string {
  const hintStart = message.text.lastIndexOf('\n\n')
  if (message.images.length === 0 || hintStart < 0) return message.text

  // Pi 将尺寸说明拼在正文末尾；只调整默认展示，模型和插件仍使用完整原文。
  const hints = message.text.slice(hintStart + 2).split('\n')
  if (hints.length > message.images.length) return message.text
  const matchesImages = hints.every((hint) => {
    const dimensions =
      /^\[Image: original \d+x\d+, displayed at (\d+)x(\d+)\. Multiply coordinates by \d+\.\d{2} to map to original image\.\]$/.exec(
        hint
      )
    return (
      dimensions !== null &&
      message.images.some(
        (image) => image.width === Number(dimensions[1]) && image.height === Number(dimensions[2])
      )
    )
  })
  return matchesImages ? message.text.slice(0, hintStart) : message.text
}

function defaultProjection(message: L4PiChatMessage): PluginMessageProjectionResult {
  switch (message.type) {
    case 'user':
      return {
        viewKey: defaultViewKey(message),
        summary: {
          text: userDisplayText(message),
          images: message.images.map((image) => ({ ...image }))
        },
        detail: null
      }
    case 'assistant':
      return {
        viewKey: defaultViewKey(message),
        summary: {
          text: message.text,
          errorMessage: message.errorMessage,
          ...(message.model === undefined ? {} : { model: message.model })
        },
        detail: message.thinking.length > 0 ? { thinking: message.thinking } : null
      }
    case 'tool': {
      const viewKey = defaultViewKey(message)
      const summary = {
        ...(message.images?.length &&
        ['pi-desk/tool', 'pi-desk/read', 'pi-desk/codemode'].includes(viewKey)
          ? { images: message.images.map((image) => ({ ...image })) }
          : {}),
        name: message.name,
        reasoning: message.reasoning,
        inputPreview: message.inputPreview,
        activity: message.activity
      }
      const durationMs = message.durationMs ?? null
      const startedAtMs = message.startedAtMs ?? null
      const timing: PluginJsonObject | null =
        durationMs !== null ? { durationMs } : startedAtMs !== null ? { startedAtMs } : null
      const projection: PluginMessageProjectionResult = {
        viewKey,
        summary: viewKey === 'pi-desk/bash-tool' ? { ...summary, timing } : summary,
        detail:
          viewKey === 'pi-desk/codemode'
            ? {
                output: message.output,
                ...(message.nestedCalls ? { nestedCalls: message.nestedCalls } : {})
              }
            : message.output
              ? { output: message.output }
              : null
      }
      const nativeMessage = normalizedMessage(message)
      return nativeMessage.kind === 'tool'
        ? builtinToolProjection(projection, nativeMessage)
        : projection
    }
    case 'bash':
      return {
        viewKey: defaultViewKey(message),
        summary: { command: message.command },
        detail: message.output ? { output: message.output } : null
      }
    case 'custom':
      return {
        viewKey: defaultViewKey(message),
        summary: { text: message.text },
        detail: null
      }
    case 'compaction':
      return {
        viewKey: defaultViewKey(message),
        summary: {},
        detail: message.summary ? { text: message.summary } : null
      }
  }
}

function normalizedMessage(message: L4PiChatMessage): PluginNativePiMessage {
  if (message.declaration) return message.declaration.message
  switch (message.type) {
    case 'user':
      return { kind: 'user', text: message.text, images: message.images }
    case 'assistant':
      return {
        kind: 'assistant',
        text: message.text,
        thinking: message.thinking,
        stopReason: message.status
      }
    case 'tool':
      return {
        kind: 'tool',
        toolName: message.name,
        toolCallId: '',
        arguments: {},
        partialResult: null,
        result: message.output ? { output: message.output } : null,
        isError: message.status === 'error'
      }
    case 'bash':
      return {
        kind: 'bash',
        command: message.command,
        output: message.output,
        exitCode: message.status === 'completed' ? 0 : null,
        cancelled: message.status === 'aborted',
        truncated: false
      }
    case 'custom':
      return {
        kind: 'custom',
        customType: 'display-message',
        content: message.text,
        details: null
      }
    case 'compaction':
      return {
        kind: 'custom',
        customType: 'pi-desk/compaction',
        content: '',
        details: message.summary ? { text: message.summary } : null
      }
  }
}

function builtinDeclaration(
  declarationName: string,
  priority: number,
  match: PluginMessageDeclaration['match']
): L4PiDeclarationCandidate {
  return {
    pluginName: 'pi-desk',
    declarationName,
    builtin: true,
    declaration: {
      priority,
      match,
      project: (input) => input.defaultProjection
    }
  }
}

const BUILTIN_DECLARATIONS: readonly L4PiDeclarationCandidate[] = [
  builtinDeclaration(
    'pidesk',
    -900,
    (input) => input.message.kind === 'tool' && input.message.toolName === 'pidesk'
  ),
  builtinDeclaration(
    'read',
    -900,
    (input) => input.message.kind === 'tool' && input.message.toolName === 'read'
  ),
  builtinDeclaration(
    'write',
    -900,
    (input) => input.message.kind === 'tool' && input.message.toolName === 'write'
  ),
  builtinDeclaration(
    'edit',
    -900,
    (input) => input.message.kind === 'tool' && input.message.toolName === 'edit'
  ),
  builtinDeclaration(
    'bash-tool',
    -900,
    (input) => input.message.kind === 'tool' && input.message.toolName === 'bash'
  ),
  builtinDeclaration('user', -1000, (input) => input.message.kind === 'user'),
  builtinDeclaration('assistant', -1000, (input) => input.message.kind === 'assistant'),
  builtinDeclaration('tool', -1000, (input) => input.message.kind === 'tool'),
  builtinDeclaration('bash', -1000, (input) => input.message.kind === 'bash'),
  builtinDeclaration('custom', -1000, (input) => input.message.kind === 'custom')
]

function validateProjection(input: unknown, builtin: boolean): PluginMessageProjectionResult {
  const projection = L4PiProjectionSchema.parse(input) as PluginMessageProjectionResult
  if (!builtin && projection.viewKey === RESERVED_ERROR_VIEW_KEY) {
    throw new Error('Host reserved Message Declaration Error viewKey cannot be registered')
  }
  return projection
}

function projectionJson(projection: PluginMessageProjectionResult): PluginJsonObject {
  return {
    viewKey: projection.viewKey,
    summary: projection.summary,
    detail: projection.detail
  }
}

function errorProjection(input: {
  phase: L4PiDeclarationErrorPhase
  candidate?: L4PiDeclarationCandidate
  candidates?: readonly L4PiDeclarationCandidate[]
  error?: unknown
  defaultProjection: PluginMessageProjectionResult
}): PluginMessageProjectionResult {
  const error = input.error instanceof Error ? input.error : null
  const candidate = input.candidate
  for (const item of candidate ? [candidate] : (input.candidates ?? [])) {
    const phases = reportedDeclarationErrors.get(item.declaration) ?? new Set<string>()
    if (phases.has(input.phase)) continue
    phases.add(input.phase)
    reportedDeclarationErrors.set(item.declaration, phases)
    console.warn('[Pi Desk][MessageDeclaration] 插件投影失败，保留基础展示入口', {
      pluginName: item.pluginName,
      declarationName: item.declarationName,
      phase: input.phase,
      message: (error?.message ?? 'Message Declaration conflict').slice(0, 2000)
    })
  }
  return {
    viewKey: RESERVED_ERROR_VIEW_KEY,
    summary: {
      text:
        typeof input.defaultProjection.summary.text === 'string'
          ? input.defaultProjection.summary.text
          : '',
      phase: input.phase,
      pluginName: candidate?.pluginName ?? null,
      declarationName: candidate?.declarationName ?? null
    },
    detail: {
      phase: input.phase,
      pluginName: candidate?.pluginName ?? null,
      declarationName: candidate?.declarationName ?? null,
      priority: candidate?.declaration.priority ?? null,
      errorName: error?.name ?? null,
      errorMessage: error?.message ?? String(input.error ?? 'Message Declaration conflict'),
      errorStack: error?.stack ?? null,
      conflicts: (input.candidates ?? []).map((item) => ({
        pluginName: item.pluginName,
        declarationName: item.declarationName,
        priority: item.declaration.priority
      })),
      defaultProjection: projectionJson(input.defaultProjection)
    }
  }
}

export function projectL4PiMessageDeclarationCore(input: {
  source: PluginSource
  stage: PluginMessageDeclarationInput['stage']
  message: L4PiChatMessage
  declarations?: ReadonlyArray<{
    pluginName: string
    declarationName: string
    declaration: PluginMessageDeclaration
  }>
}): PluginMessageProjectionResult {
  const fallback = defaultProjection(input.message)
  if (input.message.type === 'compaction') return fallback

  const declarationInput: PluginMessageDeclarationInput = {
    source: input.source,
    stage: input.stage,
    message: normalizedMessage(input.message),
    raw: input.message.declaration?.raw ?? input.message,
    defaultProjection: fallback
  }
  const plugins = (input.declarations ?? []).map<L4PiDeclarationCandidate>((registration) => ({
    ...registration,
    builtin: false
  }))
  const candidates = [...plugins, ...BUILTIN_DECLARATIONS]
  const priorities = [...new Set(candidates.map((item) => item.declaration.priority))].sort(
    (left, right) => right - left
  )

  for (const priority of priorities) {
    const group = candidates.filter((item) => item.declaration.priority === priority)
    const matches: L4PiDeclarationCandidate[] = []
    for (const candidate of group) {
      try {
        if (candidate.declaration.match(declarationInput)) matches.push(candidate)
      } catch (error) {
        return errorProjection({
          phase: 'match',
          candidate,
          error,
          defaultProjection: fallback
        })
      }
    }
    if (matches.length === 0) continue
    if (matches.length > 1) {
      return errorProjection({
        phase: 'conflict',
        candidates: matches,
        defaultProjection: fallback
      })
    }

    const selected = matches[0]!
    let projection: PluginMessageProjectionResult
    try {
      projection = selected.declaration.project(declarationInput)
    } catch (error) {
      return errorProjection({
        phase: 'project',
        candidate: selected,
        error,
        defaultProjection: fallback
      })
    }
    try {
      return validateProjection(projection, selected.builtin)
    } catch (error) {
      return errorProjection({
        phase: 'validate',
        candidate: selected,
        error,
        defaultProjection: fallback
      })
    }
  }

  return fallback
}
