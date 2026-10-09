import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { selectCiChecks } from '../.github/scripts/select-ci-checks.mjs'

const workflow = await readFile(
  new URL('../.github/workflows/release-npm.yml', import.meta.url),
  'utf8'
)
const publish = workflow.match(/\n  publish:\n\s+if: >-\n([\s\S]*?)\n\s+needs:/)[1]

function canPublish({
  packages = ['pi-desk'],
  linux = 'success',
  phase = '',
  source = '',
  cancelled = false
} = {}) {
  const expression = publish.replace(
    /needs\.([a-z][\w-]*)/g,
    (_, name) => `needs[${JSON.stringify(name)}]`
  )
  return runInNewContext(expression, {
    needs: {
      plan: { result: 'success', outputs: { packages: JSON.stringify(packages) } },
      build: { result: 'success' },
      'installed-commands-linux': { result: linux }
    },
    inputs: { phase, source_sha: source, publish: false },
    github: { event_name: 'push' },
    always: () => true,
    cancelled: () => cancelled,
    fromJSON: JSON.parse,
    contains: (values, value) => values.includes(value)
  })
}

test('宿主发布等待 Linux 同批制品验收，失败、跳过和取消均阻断', () => {
  assert.equal(canPublish(), true)
  for (const linux of ['failure', 'cancelled', 'skipped'])
    assert.equal(canPublish({ linux }), false)
  assert.equal(canPublish({ cancelled: true }), false)
  assert.match(workflow, /installed-commands-linux:\n\s+needs: \[plan, build\]/)
  assert.match(workflow, /needs: \[plan, build, installed-commands-linux\]/)
})

test('纯插件批次可跳过宿主检查，正式构建与已验证制品复用保持原语义', () => {
  assert.equal(canPublish({ packages: ['pi-desk-usage'], linux: 'skipped' }), true)
  assert.equal(canPublish({ phase: 'build' }), false)
  assert.equal(canPublish({ phase: 'publish', source: 'fixed-source', linux: 'skipped' }), true)
  assert.equal(canPublish({ phase: 'publish', source: '', linux: 'skipped' }), false)
  assert.match(workflow, /path: \$\{\{ env.NPM_ARTIFACT_DIR \}\}\/\*\.tgz/)
  assert.match(workflow, /command-smoke\/sdk\.tgz.*command-smoke\/host\.tgz/)
})

test('宿主制品准备直接执行核心回归，不受 dev 的轻量模式跳过', async () => {
  const source = await readFile(
    new URL('../.github/scripts/release-npm.mjs', import.meta.url),
    'utf8'
  )
  const host = source.slice(
    source.indexOf('if (entry.directory === projectRoot) {'),
    source.indexOf('for (const entry of entries) await pack')
  )
  const core = host.indexOf("['test:pidesk']")
  assert.ok(core >= 0 && core < host.indexOf('if (full)'), '核心命令回归必须位于完整检查条件之外')
})

test('Source checks 在两个平台执行核心与真实命令验收', async () => {
  const source = await readFile(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8')
  const job = source.slice(source.indexOf('\n  pidesk:'), source.indexOf('\n  website:'))
  assert.match(job, /os: \[ubuntu-latest, windows-latest\]/)
  assert.match(job, /run: pnpm test:pidesk/)
  assert.match(job, /run: node --test tests\/l1-pidesk\.e2e\.mjs/)
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
