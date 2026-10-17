import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORKSPACE_OPERATION_EVENT,
  parseWorkspaceExternalOperation
} from '../src/workspace-operation-event.js'

test('Workspace 外部操作事件只接受完成结果', () => {
  assert.equal(WORKSPACE_OPERATION_EVENT, 'pi-workspace:operation/v1')
  assert.deepEqual(
    parseWorkspaceExternalOperation({
      directory: 'C:/workspace/repo',
      command: 'external-check',
      startedAt: 100,
      endedAt: 200,
      result: 'success',
      summary: '检查完成',
      logPath: 'C:/project/temp/pi/external-check/command.log'
    }),
    {
      directory: 'C:/workspace/repo',
      command: 'external-check',
      startedAt: 100,
      endedAt: 200,
      result: 'success',
      summary: '检查完成',
      logPath: 'C:/project/temp/pi/external-check/command.log'
    }
  )
  assert.equal(
    parseWorkspaceExternalOperation({
      directory: 'C:/workspace/repo',
      command: 'external check',
      startedAt: 200,
      endedAt: 100,
      result: 'running',
      summary: '',
      logPath: ''
    }),
    null
  )
})
