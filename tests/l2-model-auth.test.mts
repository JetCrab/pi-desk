import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setImmediate as immediate } from 'node:timers/promises'
import test, { after } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { createJiti } from 'jiti'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import {
  L2ModelAuthStateSchema,
  type L2ModelAuthState
} from '../src/common/l2_biz/model-auth/l2-model-auth-contract.ts'
import type { L4ModelAuth as Foundation } from '../src/server/l4_foundation/model-auth/l4-model-auth.ts'

const root = resolve('temp/pi/model-auth-tests', `login-lifecycle-${randomUUID()}`)
const environment = ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_OFFLINE'] as const
const savedEnvironment = new Map(environment.map((key) => [key, process.env[key]]))
process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'agent/sessions')
process.env.PI_OFFLINE = '1'
await mkdir(join(root, 'agent/sessions'), { recursive: true })
after(async () => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: resolve('tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})
const { L4ModelAuth } = await jiti.import<
  typeof import('../src/server/l4_foundation/model-auth/l4-model-auth.ts')
>('@server/l4_foundation/model-auth/l4-model-auth')
const { L2ModelAuth } = await jiti.import<
  typeof import('../src/server/l2_biz/model-auth/l2-model-auth.ts')
>('../src/server/l2_biz/model-auth/l2-model-auth.ts')

function stateLog(): {
  receive: (value: L2ModelAuthState) => void
  wait: (predicate: (value: L2ModelAuthState) => boolean) => Promise<L2ModelAuthState>
  states: L2ModelAuthState[]
} {
  const states: L2ModelAuthState[] = []
  const listeners = new Set<(value: L2ModelAuthState) => void>()
  return {
    states,
    receive(value): void {
      const state = L2ModelAuthStateSchema.parse(value)
      states.push(state)
      for (const listener of listeners) listener(state)
    },
    wait(predicate): Promise<L2ModelAuthState> {
      const previous = states.find(predicate)
      if (previous) return Promise.resolve(previous)
      return new Promise((resolveState, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener)
          reject(new Error('等待账号状态超时'))
        }, 2000)
        const listener = (state: L2ModelAuthState): void => {
          if (!predicate(state)) return
          clearTimeout(timer)
          listeners.delete(listener)
          resolveState(state)
        }
        listeners.add(listener)
      })
    }
  }
}

async function withFoundation(
  login: (interaction: AuthInteraction) => Promise<boolean>,
  run: () => Promise<void>,
  refreshCatalog: () => Promise<void> = async () => undefined,
  loggedIn = true
): Promise<void> {
  const original = L4ModelAuth.create
  const fake: Pick<Foundation, 'list' | 'login' | 'refreshCatalog' | 'logout'> = {
    async list() {
      return [{ provider: 'fixture', name: 'Fixture', loggedIn, conflict: null }]
    },
    login: async (_provider, interaction) => login(interaction),
    refreshCatalog,
    async logout(): Promise<void> {
      assert.equal(loggedIn, true, '不能删除 API Key 或不存在的账号凭据')
    }
  }
  L4ModelAuth.create = async (): Promise<Foundation> => fake as Foundation
  try {
    await run()
  } finally {
    L4ModelAuth.create = original
  }
}

test('账号登录：旧问题和其他连接不能回答，进度保留授权入口，目录失败不否定登录', async () => {
  const log = stateLog()
  const owner = new L2ModelAuth(log.receive)
  const other = new L2ModelAuth(() => assert.fail('登录状态不能发给其他连接'))
  await withFoundation(
    async (interaction) => {
      const choice = await interaction.prompt({
        type: 'select',
        message: '选择方式',
        options: [{ id: 'browser', label: '浏览器' }]
      })
      assert.equal(choice, 'browser')
      interaction.notify({ type: 'auth_url', url: 'https://example.test/authorize' })
      interaction.notify({ type: 'progress', message: '等待授权' })
      assert.equal(
        await interaction.prompt({ type: 'manual_code', message: '填写授权码' }),
        'fixture-code'
      )
      return true
    },
    async () => {
      try {
        const loginId = randomUUID()
        await owner.start('fixture', loginId)
        const selecting = await log.wait((state) => state.prompt?.type === 'select')
        assert.throws(
          () => other.respond(loginId, selecting.prompt!.id, 'browser'),
          /不属于当前连接/
        )
        assert.throws(() => owner.respond(loginId, selecting.prompt!.id, 'invalid'), /选项/)
        owner.respond(loginId, selecting.prompt!.id, 'browser')
        const manual = await log.wait((state) => state.prompt?.type === 'manual_code')
        assert.equal(manual.notice?.type, 'auth_url')
        assert.equal(manual.message, '等待授权')
        assert.throws(() => owner.respond(loginId, selecting.prompt!.id, 'browser'), /已结束/)
        owner.respond(loginId, manual.prompt!.id, 'fixture-code')
        const completed = await log.wait((state) => state.status === 'completed')
        assert.match(completed.message ?? '', /登录成功.*目录刷新失败/)
        assert.equal(completed.prompt, null)
      } finally {
        owner.dispose()
        other.dispose()
      }
    },
    async () => {
      throw new Error('fixture: catalog offline')
    }
  )
})

test('账号登录：单问题取消允许回调胜出，连接释放终止等待且释放供应商锁', async () => {
  const log = stateLog()
  const owner = new L2ModelAuth(log.receive)
  const otherLog = stateLog()
  const other = new L2ModelAuth(otherLog.receive)
  let currentInteraction: AuthInteraction | undefined
  const promptAbort = new AbortController()
  await withFoundation(
    async (interaction) => {
      currentInteraction = interaction
      if (!promptAbort.signal.aborted) {
        const manual = interaction.prompt({
          type: 'manual_code',
          message: '回填',
          signal: promptAbort.signal
        })
        promptAbort.abort()
        await assert.rejects(manual, /取消/)
        assert.equal(interaction.signal?.aborted, false)
      }
      await interaction.prompt({ type: 'secret', message: '等待用户' })
      return true
    },
    async () => {
      try {
        const id = randomUUID()
        await owner.start('fixture', id)
        await log.wait((state) => state.prompt?.type === 'secret')
        await assert.rejects(other.start('fixture', randomUUID()), /正在登录或退出/)
        const interaction = currentInteraction!
        const count = log.states.length
        owner.dispose()
        owner.dispose()
        assert.equal(interaction.signal?.aborted, true)
        await immediate()
        assert.equal(log.states.length, count, '释放后不再向旧连接推送')
        const otherId = randomUUID()
        await other.start('fixture', otherId)
        const prompt = await otherLog.wait((state) => state.prompt?.type === 'secret')
        other.cancel(otherId)
        assert.throws(() => other.respond(otherId, prompt.prompt!.id, 'late'), /已结束/)
        assert.equal(otherLog.states.at(-1)?.status, 'cancelled')
        await immediate()
      } finally {
        owner.dispose()
        other.dispose()
      }
    }
  )
})

test('账号退出：不能移除同供应商的 API Key 登录', async () => {
  const owner = new L2ModelAuth(() => undefined)
  await withFoundation(
    async () => true,
    async () => {
      try {
        await assert.rejects(owner.logout('fixture'), /没有已保存的账号登录/)
      } finally {
        owner.dispose()
      }
    },
    undefined,
    false
  )
})
