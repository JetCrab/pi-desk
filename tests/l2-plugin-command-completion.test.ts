import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
import type { L2PluginManagementOperation } from '../src/common/l2_biz/plugin/l2-plugin-management-contract'

const require = createRequire(import.meta.url)

test(
  '管理队列观察等待应用和收尾，失败、重启要求与关闭均释放等待',
  { timeout: 20_000 },
  async () => {
    const root = resolve('temp/pi/pidesk-completion', `queue-${randomUUID()}`)
    const agentDir = join(root, 'agent')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
    await mkdir(agentDir, { recursive: true })
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
    let management:
      | import('../src/server/l2_biz/plugin-management/l2-plugin-management').L2PluginManagement
      | undefined
    let succeeded = false
    try {
      const jiti = createJiti(import.meta.url, {
        tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
        alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
      })
      const { L2PluginManagement } = await jiti.import<
        typeof import('../src/server/l2_biz/plugin-management/l2-plugin-management')
      >('../src/server/l2_biz/plugin-management/l2-plugin-management.ts')
      management = new L2PluginManagement(
        {
          refreshPluginMessages: () => undefined,
          runPluginRestart: (operation) => operation()
        },
        root,
        agentDir
      )
      const operations = Reflect.get(management, 'operations') as Map<
        string,
        L2PluginManagementOperation
      >
      const publish = (): void => {
        Reflect.apply(Reflect.get(management!, 'publish'), management, [])
      }
      const source = 'npm:completion-fixture'
      const signal = new AbortController().signal
      operations.set(source, { action: 'apply', phase: 'applying', message: null })
      let completed = false
      const waiting = management.waitForOperations([source], signal).then(() => {
        completed = true
      })
      operations.delete(source)
      Reflect.set(management, 'activeSource', source)
      publish()
      await Promise.resolve()
      assert.equal(completed, false, '仍在收尾时不能报告完成')
      Reflect.set(management, 'activeSource', null)
      publish()
      await waiting
      assert.equal(completed, true)

      operations.set(source, { action: 'apply', phase: 'failed', message: '候选预检失败' })
      await assert.rejects(() => management!.waitForOperations([source], signal), /候选预检失败/)

      operations.set(source, { action: 'update', phase: 'waiting', message: '包文件被占用' })
      const deferred = Reflect.get(management, 'deferredMaintenance') as Map<string, unknown>
      deferred.set(source, { action: 'update', source })
      await assert.rejects(() => management!.waitForOperations([source], signal), /尚未生效.*重启/)
      deferred.clear()

      operations.set(source, { action: 'add', phase: 'queued', message: null })
      const controller = new AbortController()
      const aborted = management.waitForOperations([source], controller.signal)
      controller.abort()
      await assert.rejects(aborted, /会话已关闭/)

      const closing = management.waitForOperations([source], signal)
      management.dispose()
      await assert.rejects(closing, /插件管理已关闭/)
      const listeners = Reflect.get(management, 'listeners') as Set<() => void>
      assert.equal(listeners.size, 0)
      succeeded = true
    } finally {
      management?.dispose()
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir
      if (succeeded) await rm(root, { recursive: true, force: true })
    }
  }
)
