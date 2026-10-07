import assert from 'node:assert/strict'
import test from 'node:test'
import { composeSourceTool } from '../src/tool-composition.ts'

function sourceTool(execute = async () => ({ content: [] })) {
  return {
    name: 'read',
    label: 'read',
    description: 'Read a file',
    promptSnippet: 'Read file contents',
    promptGuidelines: ['Use read to examine files.'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' }
      },
      required: ['path']
    },
    renderShell: 'self',
    renderCall() {},
    renderResult() {},
    execute
  }
}

test('增加可选 reasoning，保留原必填字段、元数据和展示行为且不修改源 schema', () => {
  const source = sourceTool()
  source.exposure = 'codemode'
  source.annotations = { readOnlyHint: true }
  source.namespace = { name: 'files', description: 'Files' }
  const sourceParameters = structuredClone(source.parameters)
  const tool = composeSourceTool(source)
  const properties = tool.parameters.properties

  assert.equal(typeof properties, 'object')
  assert.equal(properties.reasoning.type, 'string')
  assert.match(properties.reasoning.description, /GOAL behind this call/)
  assert.deepEqual(tool.parameters.required, ['path'])
  assert.deepEqual(source.parameters, sourceParameters)
  assert.notEqual(tool.parameters, source.parameters)
  assert.notEqual(properties, source.parameters.properties)
  assert.equal(tool.label, source.label)
  assert.equal(tool.description, source.description)
  assert.equal(tool.exposure, source.exposure)
  assert.equal(tool.annotations, source.annotations)
  assert.equal(tool.namespace, source.namespace)
  assert.equal(tool.promptSnippet, source.promptSnippet)
  assert.equal(tool.promptGuidelines, source.promptGuidelines)
  assert.equal('renderCall' in tool, false)
  assert.equal('renderResult' in tool, false)
  assert.equal('renderShell' in tool, false)
})

test('源 schema 没有必填字段时不新增 required', () => {
  const source = sourceTool()
  delete source.parameters.required

  const tool = composeSourceTool(source)

  assert.equal(Object.hasOwn(tool.parameters, 'required'), false)
})

test('不提供 reasoning 也执行原始工具', async () => {
  let received
  const tool = composeSourceTool(
    sourceTool(async (_toolCallId, params) => {
      received = params
      return { content: [] }
    })
  )

  await tool.execute('call-1', { path: 'settings.json' })

  assert.deepEqual(received, { path: 'settings.json' })
})

test('执行前只剥离 reasoning，保留 this、cwd、参数位置和结果', async () => {
  let received
  const result = { content: [], details: { path: 'settings.json' } }
  const source = sourceTool(async function (...args) {
    received = args
    assert.equal(this, source)
    return result
  })
  const tool = composeSourceTool(source)
  const params = {
    reasoning: '确认配置来源',
    path: 'settings.json',
    offset: 2
  }
  const signal = new AbortController().signal
  const onUpdate = () => {}
  const context = { cwd: '/workspace/current' }
  const extra = { marker: 'extra' }

  const actual = await tool.execute('call-1', params, signal, onUpdate, context, extra)

  assert.deepEqual(received[1], { path: 'settings.json', offset: 2 })
  assert.equal(received[0], 'call-1')
  assert.equal(received[2], signal)
  assert.equal(received[3], onUpdate)
  assert.equal(received[4], context)
  assert.equal(received[5], extra)
  assert.equal(received.length, 6)
  assert.equal(params.reasoning, '确认配置来源')
  assert.equal(actual, result)
})

test('拒绝覆盖原工具已有的 reasoning 参数', () => {
  const source = sourceTool()
  source.parameters.properties.reasoning = { type: 'string' }

  assert.throws(() => composeSourceTool(source), /already defines reasoning/)
})
