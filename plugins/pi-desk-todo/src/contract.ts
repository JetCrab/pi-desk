import type { Static } from 'typebox'
import type { TodoInputSchema } from './schema.js'

export const MAX_TODO_NODES = 100
export const MAX_TODO_BYTES = 64 * 1024

const MAX_NODES = MAX_TODO_NODES
const MAX_BYTES = MAX_TODO_BYTES

export type TodoInput = Static<typeof TodoInputSchema>
export type TodoItem = TodoInput['items'][number]
export type TodoSnapshot = { todo: TodoInput | null; hidden: boolean }

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Todo 输入与节点必须是对象')
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new Error(`Todo 存在未知字段：${key}`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_BYTES) {
    throw new Error(`Todo ${field} 必须是非空字符串，且不能超过 64 KiB`)
  }
  return value
}

export function parseTodoInput(input: unknown): TodoInput {
  const root = object(input, ['title', 'items'])
  const title = text(root.title, 'title')
  if (!Array.isArray(root.items) || root.items.length === 0 || root.items.length > MAX_NODES) {
    throw new Error('Todo items 必须是非空数组，最多 100 个任务')
  }
  const ids = new Set<string>()
  const items = root.items.map((value): TodoItem => {
    const node = object(value, ['id', 'title', 'status', 'note'])
    const id = text(node.id, 'id')
    if (ids.has(id)) throw new Error(`Todo 任务 ID 重复：${id}`)
    ids.add(id)
    const title = text(node.title, 'title')
    const status = node.status
    if (status !== 0 && status !== 1 && status !== 2 && status !== 3) {
      throw new Error('Todo status 必须是数字 0、1、2 或 3')
    }
    if (
      node.note !== undefined &&
      (typeof node.note !== 'string' || node.note.length > MAX_BYTES)
    ) {
      throw new Error('Todo note 必须是字符串，且不能超过 64 KiB')
    }
    if (status === 3 && (typeof node.note !== 'string' || !node.note.trim())) {
      throw new Error('Todo 受阻任务必须提供非空 note')
    }
    return { id, title, status, ...(node.note === undefined ? {} : { note: node.note }) }
  })
  const todo = { title, items }
  if (new TextEncoder().encode(JSON.stringify(todo)).byteLength > MAX_BYTES) {
    throw new Error('Todo 序列化大小不能超过 64 KiB')
  }
  return todo
}

export function countTodoItems(items: readonly TodoItem[]): { completed: number; total: number } {
  return {
    completed: items.filter((item) => item.status === 2).length,
    total: items.length
  }
}
