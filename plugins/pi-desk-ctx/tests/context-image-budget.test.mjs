import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createJiti } = require(require.resolve('jiti', { paths: [process.cwd()] }))
const jiti = createJiti(import.meta.url)
const { applyImageBudget } = await jiti.import(
  new URL('../src/context-image-budget.ts', import.meta.url).pathname
)

const settings = {
  enabled: true,
  triggerBytes: 24,
  targetBytes: 12,
  keepAssistantTurns: 12,
  keepTextTurns: 3
}

function image(bytes) {
  return { type: 'image', data: 'A'.repeat(bytes), mimeType: 'image/png' }
}

function user(content, timestamp = 1) {
  return { role: 'user', content, timestamp }
}

function assistant(timestamp, content = [{ type: 'text', text: '已检查' }], stopReason = 'stop') {
  return { role: 'assistant', timestamp, content, stopReason }
}

function tool(content, timestamp = 2) {
  return {
    role: 'toolResult',
    content,
    timestamp,
    toolCallId: `read-${timestamp}`,
    toolName: 'read',
    isError: false
  }
}

function pictures(messages) {
  return messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === 'image') : []
  )
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

test('默认关闭和未超过触发值不改变上下文，等于阈值也不触发', () => {
  const messages = [user([image(24)])]
  assert.equal(applyImageBudget(messages, { ...settings, enabled: false }).messages, messages)
  assert.equal(applyImageBudget(messages, settings).messages, messages)
  assert.equal(
    applyImageBudget([user([image(40)])], { ...settings, enabled: false }).blocked,
    false
  )
})

test('重复出现的图片计入每份发送字节，按旧轮次整组移除并保留正文和工具身份', () => {
  const repeated = image(8)
  const latest = image(12)
  const oldResult = tool([{ type: 'text', text: '旧图路径和结论' }, repeated, repeated])
  const messages = freeze([oldResult, assistant(3), user([latest], 4)])
  const before = JSON.stringify(messages)
  const result = applyImageBudget(messages, settings)
  assert.equal(result.beforeBytes, 28)
  assert.equal(result.afterBytes, 12)
  assert.equal(result.removedImages, 2)
  assert.equal(result.blocked, false)
  assert.deepEqual(pictures(result.messages), [latest])
  assert.equal(result.messages[0].toolCallId, oldResult.toolCallId)
  assert.equal(result.messages[0].content[0].text, '旧图路径和结论')
  assert.match(result.messages[0].content[1].text, /图片.*不可见|图片.*移除/)
  assert.equal(JSON.stringify(messages), before)
})

test('按所有有效助手回应计算距离，不能因为没有新图片而永久保留最后一张旧图', () => {
  const recent = image(4)
  const messages = [tool([image(24)]), assistant(3), assistant(4), assistant(5), user([recent], 6)]
  const result = applyImageBudget(messages, { ...settings, targetBytes: 24, keepAssistantTurns: 2 })
  assert.deepEqual(pictures(result.messages), [recent])
  assert.equal(result.afterBytes, 4)
})

test('正文轮窗口独立收紧，thinking和空白text不作为正文', () => {
  const earlier = image(8)
  const later = image(8)
  const fresh = image(8)
  const prefix = [
    tool([image(16)], 1),
    assistant(2),
    tool([earlier], 3),
    assistant(4),
    tool([later], 5)
  ]
  const budget = { ...settings, triggerBytes: 32, targetBytes: 32, keepTextTurns: 1 }
  const normal = applyImageBudget([...prefix, assistant(6), user([fresh], 7)], budget)
  assert.deepEqual(pictures(normal.messages), [later, fresh])
  const toolOnly = assistant(
    6,
    [
      { type: 'thinking', thinking: '内部思考' },
      { type: 'text', text: ' ' },
      { type: 'toolCall', id: 'call', name: 'read', arguments: {} }
    ],
    'toolUse'
  )
  const withoutText = applyImageBudget([...prefix, toolOnly, user([fresh], 7)], budget)
  assert.deepEqual(pictures(withoutText.messages), [earlier, later, fresh])
})

test('两个轮次窗口取交集，不把工具调用轮误认为无效回应', () => {
  const newest = image(8)
  const calls = [3, 4, 5].map((timestamp) =>
    assistant(
      timestamp,
      [{ type: 'toolCall', id: `call-${timestamp}`, name: 'read', arguments: {} }],
      'toolUse'
    )
  )
  const result = applyImageBudget([tool([image(20)]), ...calls, user([newest], 6)], {
    ...settings,
    targetBytes: 24,
    keepAssistantTurns: 2,
    keepTextTurns: 100
  })
  assert.deepEqual(pictures(result.messages), [newest])
})

test('超时、取消、pending与纯thinking不会令未处理新图变成可删除历史图', () => {
  for (const stopReason of ['error', 'aborted', 'pending', 'deferred']) {
    const messages = [
      user([image(28)]),
      assistant(2, [{ type: 'text', text: '失败残片' }], stopReason)
    ]
    const result = applyImageBudget(messages, settings)
    assert.equal(result.blocked, true, stopReason)
    assert.equal(result.unseenBytes, 28)
    assert.equal(result.messages, messages)
  }
  assert.equal(
    applyImageBudget(
      [user([image(28)]), assistant(2, [{ type: 'thinking', thinking: '思考' }])],
      settings
    ).blocked,
    true
  )
})

test('新图批次低于触发值但高于整理目标时保留整批，不拆比较图', () => {
  const fresh = [image(10), image(10)]
  const result = applyImageBudget([tool([image(16)]), assistant(3), tool(fresh, 4)], settings)
  assert.equal(result.blocked, false)
  assert.equal(result.afterBytes, 20)
  assert.deepEqual(pictures(result.messages), fresh)
})

test('新图组自身超限必须阻止发送，不静默删新图', () => {
  const messages = [tool([image(16)]), assistant(3), tool([image(16), image(16)], 4)]
  const result = applyImageBudget(messages, settings)
  assert.equal(result.blocked, true)
  assert.equal(result.unseenBytes, 32)
  assert.equal(result.messages, messages)
})

test('已处理的同一轮图片整组淘汰，窗口内仍超量时从旧到新收紧', () => {
  const newest = image(8)
  const messages = [
    tool([image(8), image(8)]),
    assistant(3),
    tool([newest], 4),
    assistant(5),
    user('继续', 6)
  ]
  const result = applyImageBudget(messages, { ...settings, triggerBytes: 20 })
  assert.deepEqual(pictures(result.messages), [newest])
  assert.equal(result.removedImages, 2)
  assert.equal(result.afterBytes, 8)
})

test('自定义消息图片同样计入预算；同一上下文重试结果确定且不依赖墙上时间', () => {
  const messages = [
    { role: 'custom', customType: 'fixture', timestamp: 1, content: [image(20)], display: true },
    assistant(2),
    user([image(8)], 3)
  ]
  const first = applyImageBudget(messages, settings)
  const second = applyImageBudget(messages, settings)
  assert.equal(first.removedImages, 1)
  assert.deepEqual(first, second)
  assert.equal(applyImageBudget(first.messages, settings).messages, first.messages)
})
