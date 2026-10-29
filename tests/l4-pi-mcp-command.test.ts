import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { createJiti } from 'jiti'

type Adapter = typeof import('../src/server/l4_foundation/pi/l4-pi-mcp-command')
type Command = Parameters<ExtensionAPI['registerCommand']>[1]
const root = resolve('temp/pi/l4-pi-mcp-command', `logout-confirmation-${process.pid}`)
const agentDir = join(root, 'agent')
const previousAgent = process.env.PI_CODING_AGENT_DIR
const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR
const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: resolve('tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})
let adapt: Adapter['withL4PiMcpLogoutConfirmation']

before(async () => {
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(agentDir, 'pi-desk-settings.json'),
    JSON.stringify({ region: { locale: 'zh-CN', timeZone: 'UTC' } })
  )
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  adapt = (await jiti.import<Adapter>('../src/server/l4_foundation/pi/l4-pi-mcp-command.ts'))
    .withL4PiMcpLogoutConfirmation
})

after(async () => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgent
  if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
  else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions
  await rm(root, { recursive: true, force: true })
})

function fixture(
  names: string[],
  selected: string | undefined,
  confirmed: boolean
): {
  command: Command
  context: ExtensionCommandContext
  calls: string[]
  confirmations: string[]
  notices: string[]
} {
  const calls: string[] = []
  const confirmations: string[] = []
  const notices: string[] = []
  const context = {
    ui: {
      async select(_title: string, options: string[]): Promise<string | undefined> {
        assert.deepEqual(options, names)
        return selected
      },
      async confirm(title: string, message: string): Promise<boolean> {
        confirmations.push(title)
        assert.match(message, /共享登录凭据/)
        return confirmed
      },
      notify(message: string): void {
        notices.push(message)
      }
    }
  } as ExtensionCommandContext
  const command = adapt({
    getArgumentCompletions: () => names.map((name) => ({ value: `logout ${name}`, label: name })),
    async handler(args): Promise<void> {
      calls.push(args)
    }
  })
  return { command, context, calls, confirmations, notices }
}

for (const confirmed of [false, true]) {
  test(`退出所选MCP服务：${confirmed ? '确认才执行' : '拒绝不执行'}`, async () => {
    const data = fixture(['alpha', 'beta'], 'beta', confirmed)
    await data.command.handler('logout', data.context)
    assert.deepEqual(data.confirmations, ['退出登录：beta'])
    assert.deepEqual(data.calls, confirmed ? ['logout beta'] : [])
  })
}

test('单候选与显式服务名也必须确认', async () => {
  for (const args of ['logout', 'logout alpha']) {
    const data = fixture(['alpha'], undefined, false)
    await data.command.handler(args, data.context)
    assert.deepEqual(data.confirmations, ['退出登录：alpha'])
    assert.deepEqual(data.calls, [])
  }
})

test('取消选择与无候选不执行退出登录', async () => {
  for (const names of [[], ['alpha', 'beta']]) {
    const data = fixture(names, undefined, true)
    await data.command.handler('logout', data.context)
    assert.deepEqual(data.confirmations, [])
    assert.deepEqual(data.calls, [])
    assert.equal(data.notices.length, names.length === 0 ? 1 : 0)
  }
})

test('状态、登录、重连与无效参数交回原生命令处理', async () => {
  const data = fixture([], undefined, false)
  for (const args of ['', 'login', 'reconnect', 'logout alpha extra']) {
    await data.command.handler(args, data.context)
  }
  assert.deepEqual(data.calls, ['', 'login', 'reconnect', 'logout alpha extra'])
  assert.deepEqual(data.confirmations, [])
})
