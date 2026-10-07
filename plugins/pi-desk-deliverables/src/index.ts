import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent'
import { Type, type Static } from 'typebox'
import {
  bindSessionPlugin,
  PluginMethodError,
  type PluginJsonObject,
  type SessionPluginFacade
} from '@jetcrab/pi-desk-sdk/session'
import type { DeliverableBatch, DeliverableItem, DeliverableListResult } from './contract.js'

const TOOL_NAME = 'deliverable'
const DEFAULT_LIST_LIMIT = 20

const deliverableItemSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 4096,
      description: '当前项目 cwd 下已存在、可在 Pi Desk 中预览的完成文件相对路径，使用 / 分隔'
    }),
    title: Type.String({
      minLength: 1,
      maxLength: 40,
      description: '面向用户的简短标题，尽量在 20 字以内说明交付内容或原因'
    })
  },
  { additionalProperties: false }
)

const deliverableInputSchema = Type.Object(
  {
    items: Type.Array(deliverableItemSchema, {
      minItems: 1,
      maxItems: 20,
      description: '本次需要登记的交付物文件'
    })
  },
  { additionalProperties: false }
)

type DeliverableInput = Static<typeof deliverableInputSchema>

function jsonObject(value: unknown): PluginJsonObject {
  return JSON.parse(JSON.stringify(value)) as PluginJsonObject
}

function isInsideRoot(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function canonicalRelativePath(value: string): string {
  const path = value.trim().replace(/^@/, '')
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    /^[a-zA-Z]:/.test(path) ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`交付物路径必须是规范的项目相对路径：${value}`)
  }
  return path
}

async function validateItems(cwd: string, input: DeliverableInput): Promise<DeliverableItem[]> {
  const root = await realpath(cwd)
  return Promise.all(
    input.items.map(async (item) => {
      const path = canonicalRelativePath(item.path)
      const title = item.title.trim()
      if (!title || title.length > 40) throw new Error('交付物标题必须包含 1-40 个字符')

      let target: string
      try {
        target = await realpath(resolve(root, ...path.split('/')))
      } catch {
        throw new Error(`交付物文件不存在：${path}`)
      }
      if (!isInsideRoot(root, target)) throw new Error(`交付物文件超出当前项目：${path}`)
      if (!(await stat(target)).isFile()) throw new Error(`交付物路径不是文件：${path}`)
      return { path, title }
    })
  )
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseItems(value: unknown): DeliverableItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null
  const items: DeliverableItem[] = []
  for (const raw of value) {
    const item = record(raw)
    if (!item || typeof item.path !== 'string' || typeof item.title !== 'string') return null
    try {
      const path = canonicalRelativePath(item.path)
      const title = item.title.trim()
      if (!title || title.length > 40) return null
      items.push({ path, title })
    } catch {
      return null
    }
  }
  return items
}

function deliveryFromEntry(entry: SessionEntry): DeliverableBatch | null {
  if (entry.type !== 'message' || entry.message.role !== 'toolResult') return null
  if (entry.message.toolName !== TOOL_NAME || entry.message.isError) return null
  const details = record(entry.message.details)
  const items = parseItems(details?.items)
  return items ? { entryId: entry.id, items } : null
}

function listLimit(input: PluginJsonObject): number {
  for (const key of Object.keys(input)) {
    if (key !== 'limit' && key !== 'beforeEntryId') {
      throw new PluginMethodError(400, `未知输入字段：${key}`)
    }
  }
  if (input.limit === undefined) return DEFAULT_LIST_LIMIT
  if (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100) {
    throw new PluginMethodError(400, 'limit 必须是 1-100 的整数')
  }
  return Number(input.limit)
}

function beforeEntryId(input: PluginJsonObject): string | null {
  if (input.beforeEntryId === undefined) return null
  if (typeof input.beforeEntryId !== 'string' || !input.beforeEntryId.trim()) {
    throw new PluginMethodError(400, 'beforeEntryId 必须是非空字符串')
  }
  return input.beforeEntryId
}

class DeliverableRuntime {
  private branchEntryIds: string[] = []
  private deliveries: DeliverableBatch[] = []

  constructor(private readonly plugin: SessionPluginFacade) {}

  restore(context: ExtensionContext): void {
    const branch = context.sessionManager.getBranch()
    this.branchEntryIds = branch.map((entry) => entry.id)
    this.deliveries = branch.flatMap((entry) => {
      const delivery = deliveryFromEntry(entry)
      return delivery ? [delivery] : []
    })
  }

  sync(context: ExtensionContext): void {
    const branch = context.sessionManager.getBranch()
    const prefixValid =
      branch.length >= this.branchEntryIds.length &&
      this.branchEntryIds.every((entryId, index) => branch[index]?.id === entryId)
    if (!prefixValid) {
      this.restore(context)
      return
    }

    for (const entry of branch.slice(this.branchEntryIds.length)) {
      const delivery = deliveryFromEntry(entry)
      if (!delivery) continue
      this.deliveries.push(delivery)
      this.plugin.push('added', jsonObject(delivery))
    }
    this.branchEntryIds = branch.map((entry) => entry.id)
  }

  list(input: PluginJsonObject): DeliverableListResult {
    const limit = listLimit(input)
    const cursor = beforeEntryId(input)
    let end = this.deliveries.length
    if (cursor) {
      end = this.deliveries.findIndex((delivery) => delivery.entryId === cursor)
      if (end < 0) throw new PluginMethodError(400, 'beforeEntryId 不属于当前会话分支')
    }
    const start = Math.max(0, end - limit)
    const deliveries = this.deliveries
      .slice(start, end)
      .reverse()
      .map((delivery) => ({
        entryId: delivery.entryId,
        items: delivery.items.map((item) => ({ ...item }))
      }))
    return {
      deliveries,
      hasMore: start > 0
    }
  }

  clear(): void {
    this.branchEntryIds = []
    this.deliveries = []
  }
}

export default function extension(pi: ExtensionAPI): void {
  const plugin = bindSessionPlugin(pi, 'deliverables')
  const runtime = new DeliverableRuntime(plugin)

  plugin.registerMethod('list', async (input) => jsonObject(runtime.list(input)))

  pi.registerTool({
    name: TOOL_NAME,
    label: '交付物',
    description:
      '登记需要用户明确查看或验收的已完成文件。仅用于重要最终结果或验收证据，支持一次登记多个文件。',
    promptSnippet: 'Register completed files that the user should explicitly inspect or accept',
    promptGuidelines: [
      'Use deliverable only for important completed results or acceptance evidence that can be previewed in Pi Desk, such as images, code files that are themselves a requested deliverable, and HTML. Do not register ordinary source edits, intermediate files, or files that cannot be previewed.'
    ],
    parameters: deliverableInputSchema,
    async execute(_toolCallId, input, _signal, _onUpdate, context) {
      const items = await validateItems(context.cwd, input)
      return {
        content: [
          {
            type: 'text',
            text: `已登记 ${items.length} 个交付物：\n${items
              .map((item) => `- ${item.title}：${item.path}`)
              .join('\n')}`
          }
        ],
        details: { items }
      }
    }
  })

  pi.on('session_start', (_event, context) => runtime.restore(context))
  pi.on('session_tree', (_event, context) => runtime.restore(context))
  pi.on('turn_end', (_event, context) => runtime.sync(context))
  pi.on('session_shutdown', () => runtime.clear())
}
