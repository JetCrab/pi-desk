import { Type } from 'typebox'
import { MAX_TODO_BYTES, MAX_TODO_NODES } from './contract.js'

const id = Type.String({
  minLength: 1,
  maxLength: MAX_TODO_BYTES,
  pattern: '\\S',
  description: '在本次完整任务树中唯一的节点 ID'
})
const title = Type.String({
  minLength: 1,
  maxLength: MAX_TODO_BYTES,
  pattern: '\\S',
  description: '面向用户的实际工作进度标题'
})
const leaf = Type.Object(
  {
    id,
    title,
    status: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)], {
      description: '数字状态：0 待开始、1 进行中、2 已完成、3 受阻；状态为 3 时必须提供非空 note'
    }),
    note: Type.Optional(
      Type.String({ maxLength: MAX_TODO_BYTES, description: '补充说明；受阻时必须说明阻塞原因' })
    )
  },
  { additionalProperties: false }
)
const stage = Type.Object(
  {
    id,
    title,
    children: Type.Array(leaf, {
      minItems: 1,
      maxItems: MAX_TODO_NODES - 1,
      description: '阶段内的二级叶子任务，不支持更深层级；父阶段不接受 status 或 note'
    })
  },
  { additionalProperties: false }
)

export const TodoInputSchema = Type.Object(
  {
    title,
    items: Type.Array(Type.Union([leaf, stage]), {
      minItems: 1,
      maxItems: MAX_TODO_NODES,
      description: '完整替换当前进度的顶层任务或父阶段；全树 ID 唯一，总节点最多 100 个'
    })
  },
  {
    additionalProperties: false,
    description: '当前实际工作进度的完整快照，序列化后最多 64 KiB；每次调用全量替换'
  }
)
