import assert from 'node:assert/strict'
import test from 'node:test'
import { selectCiChecks } from '../.github/scripts/select-ci-checks.mjs'
import { evaluateWorkflowCondition, readWorkflow } from './fixtures/l4-workflow-test-runtime.mjs'

const workflow = await readWorkflow('release-npm')

function canPublish({
  packages = ['pi-desk'],
  installed = 'success',
  phase = 'all',
  source = '',
  cancelled = false
} = {}) {
  return evaluateWorkflowCondition(workflow.jobs.publish.if, {
    needs: {
      plan: { result: 'success', outputs: { packages: JSON.stringify(packages) } },
      build: { result: 'success' },
      'installed-commands': { result: installed }
    },
    inputs: { phase, source_sha: source },
    cancelled: () => cancelled
  })
}

test('宿主发布等待双平台同批制品验收，失败、跳过和取消均阻断', () => {
  assert.equal(canPublish(), true)
  for (const installed of ['failure', 'cancelled', 'skipped'])
    assert.equal(canPublish({ installed }), false)
  assert.equal(canPublish({ cancelled: true }), false)
  const installed = workflow.jobs['installed-commands']
  for (const dependency of ['plan', 'build']) assert.ok(installed.needs.includes(dependency))
  for (const os of ['ubuntu-latest', 'windows-latest'])
    assert.ok(installed.strategy.matrix.os.includes(os))
  for (const dependency of ['plan', 'build', 'installed-commands'])
    assert.ok(workflow.jobs.publish.needs.includes(dependency))
})

test('纯插件批次可跳过宿主检查，正式构建与已验证制品复用保持原语义', () => {
  assert.equal(canPublish({ packages: ['pi-desk-usage'], installed: 'skipped' }), true)
  assert.equal(canPublish({ phase: 'build' }), false)
  assert.equal(canPublish({ phase: 'publish', source: 'fixed-source', installed: 'skipped' }), true)
  assert.equal(canPublish({ phase: 'publish', source: '', installed: 'skipped' }), false)
  const downloads = workflow.jobs.publish.steps.filter((step) =>
    step.uses?.startsWith('actions/download-artifact@')
  )
  assert.ok(downloads.some((step) => step.with.path === '${{ env.NPM_ARTIFACT_DIR }}'))
  const verification = workflow.jobs['installed-commands'].steps.find((step) =>
    step.run?.includes('verify-npm-install.mjs')
  )
  assert.ok(verification.run.includes('command-smoke/sdk.tgz'))
  assert.ok(verification.run.includes('command-smoke/host.tgz'))
})

test('Source checks 在两个平台执行核心与真实命令验收', async () => {
  const checks = await readWorkflow('check')
  const job = checks.jobs.pidesk
  for (const os of ['ubuntu-latest', 'windows-latest'])
    assert.ok(job.strategy.matrix.os.includes(os))
  assert.ok(job.steps.some((step) => /\bpnpm\s+test:pidesk\b/.test(step.run ?? '')))
  assert.ok(job.steps.some((step) => step.run?.includes('tests/l1-pidesk.e2e.mjs')))
})

test('源码公开边界只由独立检查负责且不因业务选择而跳过', async () => {
  const checks = await readWorkflow('check')
  const owners = Object.values(checks.jobs).filter((job) =>
    job.steps?.some((step) => step.run?.includes('l4-public-boundary.test.mjs'))
  )
  assert.equal(owners.length, 1)
  assert.equal(owners[0].if, undefined)
  const checkout = owners[0].steps.find((step) => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout.with.ref, '${{ inputs.source_sha || github.sha }}')
  const boundary = owners[0].steps.find((step) => step.run?.includes('l4-public-boundary.test.mjs'))
  assert.equal(boundary.if, undefined)
})

test('关键命令实现、回归及验收入口变化触发检查，无关文档和官网不触发', () => {
  for (const path of [
    'src/server/l4_foundation/pi/l4-pi-runtime-register.mjs',
    'plugins/pi-desk-sdk/src/browser.ts',
    'tests/l1-pidesk.e2e.mjs',
    'tests/l4-pidesk-command-smoke.mjs',
    'tests/l4-pidesk-installed-runners.test.mjs',
    'tests/l4-browser-cdp-runtime.mjs',
    '.github/scripts/verify-npm-install.mjs'
  ])
    assert.equal(selectCiChecks([path], false).pidesk, true, path)
  for (const path of [
    'README.md',
    'apps/website/src/app/page.tsx',
    'plugins/pi-desk-usage/README.md'
  ])
    assert.equal(selectCiChecks([path], false).pidesk, false, path)
})
