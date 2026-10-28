import { Type } from 'typebox'
import { MAX_TODO_BYTES, MAX_TODO_NODES } from './contract.js'

const id = Type.String({
  minLength: 1,
  maxLength: MAX_TODO_BYTES,
  pattern: '\\S',
  description: '任务 ID，列表内唯一'
})
const title = Type.String({
  minLength: 1,
  maxLength: MAX_TODO_BYTES,
  pattern: '\\S',
  description: '面向用户的实际工作进度标题'
})
const item = Type.Object(
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
export const TodoInputSchema = Type.Object(
  {
    title,
    items: Type.Array(item, {
      minItems: 1,
      maxItems: MAX_TODO_NODES,
      description: '完整替换的任务列表，最多 100 项'
    })
  },
  {
    additionalProperties: false,
    description: '当前实际工作进度的完整快照，序列化后最多 64 KiB；每次调用全量替换'
  }
)
