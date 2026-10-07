import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SubagentConfig } from '../src/agent-config'
import {
  createResearchCoordinatorExtension,
  createResearchWorkerConfig
} from '../src/research-runtime'

test('research_delegate 至少两个任务且不设置最大数量', async () => {
  let tool: ToolDefinition | undefined
  const extension = createResearchCoordinatorExtension(async (tasks, _signal, onProgress) => {
    assert.equal(tasks.length, 3)
    onProgress({ completed: 1, total: 3 })
    onProgress({ completed: 3, total: 3 })
    return tasks.map((task, index) => ({
      taskId: `worker-${index}`,
      title: task.title,
      status: 'completed' as const,
      result: `${task.title} 结果`,
      error: null,
      sessionFile: `C:/sessions/worker-${index}.jsonl`
    }))
  })
  extension({
    registerTool(value: ToolDefinition): void {
      tool = value
    }
  } as unknown as ExtensionAPI)

  assert.ok(tool)
  const schema = tool.parameters as {
    properties: { tasks: { minItems?: number; maxItems?: number } }
  }
  assert.equal(schema.properties.tasks.minItems, 2)
  assert.equal(schema.properties.tasks.maxItems, undefined)

  const updates: string[] = []
  const result = await tool.execute(
    'delegate-call',
    {
      tasks: [
        { title: '对象 A', prompt: '研究对象 A' },
        { title: '对象 B', prompt: '研究对象 B' },
        { title: '对象 C', prompt: '研究对象 C' }
      ]
    },
    undefined,
    (update) => {
      const content = update.content[0]
      if (content?.type === 'text') updates.push(content.text)
    },
    {} as never
  )
  assert.deepEqual(updates, ['Research Worker：1/3 已进入终态', 'Research Worker：3/3 已进入终态'])
  assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /3\/3 完成/)
})

test('Worker 数量不限时聚合 ToolResult 仍不超过 50KB', async () => {
  let tool: ToolDefinition | undefined
  const extension = createResearchCoordinatorExtension(async (tasks) =>
    tasks.map((task, index) => ({
      taskId: `worker-${index}`,
      title: task.title,
      status: 'completed' as const,
      result: '完整研究证据。'.repeat(10_000),
      error: null,
      sessionFile: `C:/sessions/worker-${index}.jsonl`
    }))
  )
  extension({
    registerTool(value: ToolDefinition): void {
      tool = value
    }
  } as unknown as ExtensionAPI)
  assert.ok(tool)
  const result = await tool.execute(
    'large-delegate-call',
    {
      tasks: Array.from({ length: 12 }, (_, index) => ({
        title: `对象 ${index}`,
        prompt: `研究对象 ${index}`
      }))
    },
    undefined,
    undefined,
    {} as never
  )
  const content = result.content[0]
  assert.ok(content?.type === 'text')
  assert.equal(Buffer.byteLength(content.text, 'utf8') <= 50 * 1024, true)
  assert.match(content.text, /完整 Conversation|聚合结果已截断/)
})

test('Research Worker 继承模型但移除委派工具', () => {
  const research: SubagentConfig = {
    name: 'research',
    description: '研究',
    tools: ['research_delegate', 'external_research', 'read', 'grep', 'find', 'ls'],
    model: 'my/gpt-5.6-luna',
    thinking: 'medium',
    systemPrompt: 'Root prompt'
  }
  const worker = createResearchWorkerConfig(research)
  assert.equal(worker.name, 'research-worker')
  assert.deepEqual(worker.tools, ['external_research', 'read', 'grep', 'find', 'ls'])
  assert.equal(worker.model, research.model)
  assert.equal(worker.thinking, research.thinking)
  assert.match(worker.systemPrompt, /不启动、建议或编排其他子代理/)
})
