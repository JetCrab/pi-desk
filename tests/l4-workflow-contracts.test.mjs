import assert from 'node:assert/strict'
import test from 'node:test'
import { checkWorkflowContracts } from '../.github/scripts/check-workflows.mjs'

function workflows(permissions) {
  return {
    'release-main.yml': {
      permissions: { contents: 'read' },
      jobs: {
        docker: {
          uses: './.github/workflows/release-docker.yml',
          permissions,
          with: { source_sha: 'fixed', phase: 'build' }
        }
      }
    },
    'release-docker.yml': {
      on: {
        workflow_call: {
          inputs: { source_sha: { type: 'string', required: true }, phase: { type: 'string' } }
        }
      },
      permissions: { contents: 'read' },
      jobs: {
        build: { permissions: { contents: 'write' } },
        publish: { permissions: { packages: 'write' } }
      }
    }
  }
}

test('按整个复用工作流检查权限，不因phase跳过另一任务', () => {
  assert.throws(() => checkWorkflowContracts(workflows({ contents: 'write' })), /packages/)
  assert.throws(
    () => checkWorkflowContracts(workflows({ packages: 'write', contents: 'read' })),
    /contents/
  )
  assert.doesNotThrow(() =>
    checkWorkflowContracts(workflows({ packages: 'write', contents: 'write' }))
  )
})

test('缺少必需参数或调用不存在的入口必须在构建前失败', () => {
  const files = workflows({ packages: 'write', contents: 'write' })
  delete files['release-main.yml'].jobs.docker.with.source_sha
  assert.throws(() => checkWorkflowContracts(files), /source_sha/)
  files['release-main.yml'].jobs.docker.uses = './.github/workflows/missing.yml'
  assert.throws(() => checkWorkflowContracts(files), /missing/)
})
