import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createJiti } from 'jiti'
import type { L2PluginManagementOperation } from '../src/common/l2_biz/plugin/l2-plugin-management-contract'
import type { L4PiDeskPackageMaintenanceRequest } from '../src/server/l4_foundation/pi/l4-pi-desk-process-control'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  nativeModules: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai'
  ],
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})

type Management =
  import('../src/server/l2_biz/plugin-management/l2-plugin-management').L2PluginManagement
interface Mutation {
  source: string
  operationSource: string
}
interface Prepared {
  request: L4PiDeskPackageMaintenanceRequest | null
  updateTag: string | null
  pluginName: string | null
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((done) => {
    open = done
  })
  return { promise, open }
}

async function fixture(
  run: (management: Management, agentDir: string) => Promise<void>
): Promise<void> {
  const root = resolve('temp/pi/plugin-batch', `parallel-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), '{"packages":[]}')
  const saved = new Map(
    ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_DESK_SAFE_MODE'].map((key) => [
      key,
      process.env[key]
    ])
  )
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  delete process.env.PI_DESK_SAFE_MODE
  let management: Management | undefined
  let succeeded = false
  try {
    const { L2PluginManagement } = await jiti.import<
      typeof import('../src/server/l2_biz/plugin-management/l2-plugin-management')
    >('../src/server/l2_biz/plugin-management/l2-plugin-management.ts')
    management = new L2PluginManagement(
      { runPluginRestart: (operation) => operation() },
      root,
      agentDir
    )
    // 列表映射不是此测试目标；真实接纳、队列和操作状态仍由管理服务维护。
    Reflect.set(management, 'readSnapshot', async () => ({
      plugins: [],
      restartRequired: false,
      loadError: null
    }))
    await run(management, agentDir)
    succeeded = true
  } finally {
    management?.dispose()
    if (management) await Reflect.get(management, 'operationTail')
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (succeeded) await rm(root, { recursive: true, force: true })
  }
}

function operations(management: Management): Map<string, L2PluginManagementOperation> {
  return Reflect.get(management, 'operations') as Map<string, L2PluginManagementOperation>
}

const prepared: Prepared = { request: null, updateTag: null, pluginName: null }

test(
  '10项同时准备，准备全部收尾后串行应用；部分失败不阻断其余项',
  { timeout: 30_000 },
  async () => {
    await fixture(async (management) => {
      const allStarted = gate()
      const release = gate()
      const sources = Array.from({ length: 10 }, (_, i) => `npm:batch-fixture-${i}`)
      const started: string[] = []
      const applied: string[] = []
      let activeWrites = 0
      let maxWrites = 0
      Reflect.set(management, 'prepareMutation', async (input: Mutation): Promise<Prepared> => {
        started.push(input.source)
        if (started.length === 10) allStarted.open()
        await release.promise
        if (input.source === sources[2]) throw new Error('候选预检失败')
        return prepared
      })
      Reflect.set(management, 'executeMutation', async (input: Mutation): Promise<void> => {
        activeWrites += 1
        maxWrites = Math.max(maxWrites, activeWrites)
        try {
          assert.equal(started.length, 10)
          applied.push(input.source)
          await setImmediate()
          if (input.source === sources[5]) throw new Error('目标加载失败')
        } finally {
          activeWrites -= 1
        }
      })
      try {
        const accepted = await management.batch({
          action: 'add',
          items: sources.map((source) => ({ source }))
        })
        assert.ok(accepted.results.every((item) => item.error === null))
        await allStarted.promise
        assert.equal(started.length, 10, '不能等前一项准备结束才开始下一项')
        assert.deepEqual(applied, [], '准备未收尾不能触碰正式安装')
        await assert.rejects(management.reinstall(`${sources[0]}@2.0.0`), /未完成/)
        await assert.rejects(management.reload(), /维护仍在执行/)
        const duplicate = await management.batch({ action: 'add', items: [{ source: sources[0] }] })
        assert.match(duplicate.results[0].error!, /未完成/)
        release.open()
        await Reflect.get(management, 'operationTail')
        assert.equal(maxWrites, 1)
        assert.deepEqual(
          applied,
          sources.filter((source) => source !== sources[2])
        )
        assert.equal(operations(management).get(sources[2])?.message, '候选预检失败')
        assert.equal(operations(management).get(sources[5])?.message, '目标加载失败')
        assert.equal(operations(management).size, 2)
        await management.waitForOperations([sources[9]], new AbortController().signal)
        await assert.rejects(
          management.waitForOperations([sources[2]], new AbortController().signal),
          /候选预检失败/
        )
      } finally {
        release.open()
      }
    })
  }
)

test('不同入口共享32项容量，重复来源拒绝且失败项可显式重试', { timeout: 30_000 }, async () => {
  await fixture(async (management) => {
    const release = gate()
    Reflect.set(management, 'prepareMutation', async (): Promise<Prepared> => {
      await release.promise
      return prepared
    })
    Reflect.set(management, 'executeMutation', async (): Promise<void> => undefined)
    try {
      const first = await management.batch({
        action: 'add',
        items: [{ source: 'npm:same' }, { source: 'npm:same@2.0.0' }]
      })
      assert.equal(first.results[0].error, null)
      assert.match(first.results[1].error!, /重复来源/)
      const remaining = await management.batch({
        action: 'add',
        items: Array.from({ length: 31 }, (_, i) => ({ source: `npm:capacity-${i}` }))
      })
      assert.ok(remaining.results.every((item) => item.error === null))
      await assert.rejects(management.reinstall('npm:over-capacity'), /队列已满/)
      release.open()
      await Reflect.get(management, 'operationTail')
      assert.equal(operations(management).size, 0)
      Reflect.set(management, 'prepareMutation', async (): Promise<Prepared> => {
        throw new Error('下载失败')
      })
      await management.batch({ action: 'add', items: [{ source: 'npm:retry' }] })
      await Reflect.get(management, 'operationTail')
      assert.equal(operations(management).get('npm:retry')?.phase, 'failed')
      Reflect.set(management, 'prepareMutation', async (): Promise<Prepared> => prepared)
      await management.reinstall('npm:retry')
      await management.waitForOperations(['npm:retry'], new AbortController().signal)
      assert.equal(operations(management).size, 0)
    } finally {
      release.open()
    }
  })
})

test('关闭服务取消本批准备，已准备项和后续队列均不能再应用', { timeout: 30_000 }, async () => {
  await fixture(async (management) => {
    const started = gate()
    const signal = (Reflect.get(management, 'lifetime') as AbortController).signal
    let writes = 0
    let count = 0
    Reflect.set(management, 'prepareMutation', async (input: Mutation): Promise<Prepared> => {
      if (++count === 2) started.open()
      if (input.source === 'npm:ready') return prepared
      await new Promise<void>((_done, reject) =>
        signal.addEventListener('abort', () => reject(new Error('准备已取消')), { once: true })
      )
      return prepared
    })
    Reflect.set(management, 'executeMutation', async (): Promise<void> => {
      writes += 1
    })
    await management.batch({
      action: 'add',
      items: [{ source: 'npm:ready' }, { source: 'npm:waiting' }]
    })
    await started.promise
    await management.reinstall('npm:queued')
    management.dispose()
    await Reflect.get(management, 'operationTail')
    assert.equal(writes, 0)
    assert.equal(count, 2, '关闭后不能启动后续批次')
  })
})

test('批量更新跳过非更高版本，安装精确目标只解析一次', { timeout: 30_000 }, async () => {
  await fixture(async (management, agentDir) => {
    const names = ['newer', 'same', 'older']
    const sources = names.map((name) => `npm:${name}@1.0.0`)
    await mkdir(join(agentDir, 'npm'), { recursive: true })
    await writeFile(
      join(agentDir, 'npm/package.json'),
      JSON.stringify({ dependencies: Object.fromEntries(names.map((name) => [name, '1.0.0'])) })
    )
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: sources }))
    for (const name of names) {
      const path = join(agentDir, 'npm/node_modules', name)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    }
    const resolutions: string[] = []
    const probes: string[] = []
    const applied: string[] = []
    const updates = Reflect.get(management, 'updates') as object
    Reflect.set(updates, 'resolveInstall', async (source: string) => {
      resolutions.push(source)
      const name = source.slice(4, source.lastIndexOf('@'))
      return {
        source: `npm:${name}@${name === 'newer' ? '2.0.0' : name === 'same' ? '1.0.0' : '0.9.0'}`,
        updateTag: 'latest'
      }
    })
    Reflect.set(management, 'probeCandidate', async (source: string): Promise<null> => {
      probes.push(source)
      return null
    })
    Reflect.set(
      management,
      'executeMutation',
      async (_input: Mutation, result: Prepared): Promise<void> => {
        applied.push(result.request!.source)
      }
    )
    const result = await management.batch({ action: 'update', sources })
    assert.ok(result.results.every((item) => item.error === null))
    await Reflect.get(management, 'operationTail')
    assert.deepEqual(resolutions.sort(), [...sources].sort())
    assert.deepEqual(probes, ['npm:newer@2.0.0'])
    assert.deepEqual(applied, probes)
    assert.equal(operations(management).size, 0)
  })
})
