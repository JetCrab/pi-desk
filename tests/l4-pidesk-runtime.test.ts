import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
import type { L4PiDeskCommandContext } from '../src/server/l4_foundation/pidesk/l4-pidesk-runtime'
import type {
  L4PiChatWorker,
  L4PiChatWorkerEvent
} from '../src/server/l4_foundation/pi/l4-pi-chat-worker'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  nativeModules: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai'
  ],
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})

function settled(worker: L4PiChatWorker): Promise<void> {
  return new Promise((resolveSettled, rejectSettled) => {
    const timer = setTimeout(() => {
      unsubscribe()
      rejectSettled(new Error('等待模型结束超时'))
    }, 15_000)
    const unsubscribe = worker.subscribe((event) => {
      if (event.type !== 'agent_settled') return
      clearTimeout(timer)
      unsubscribe()
      resolveSettled()
    })
  })
}

test(
  '普通与基础会话的系统导航不受 Skills 筛选影响，重载不重复且保留异步通知',
  { timeout: 70_000 },
  async () => {
    const root = resolve('temp/pi/l4-pidesk-runtime', `system-navigation-${randomUUID()}`)
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'project')
    const saved = {
      agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
      safe: process.env.PI_DESK_SAFE_MODE
    }
    const bodies: string[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        bodies.push(body)
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        const first = bodies.length === 1
        const base = {
          id: `pidesk-${bodies.length}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'fixture'
        }
        const delta = first
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'pidesk-call-fixture',
                  type: 'function',
                  function: {
                    name: 'pidesk',
                    arguments: JSON.stringify({
                      args: ['plugins', 'install', 'fixture', '--scope', 'global']
                    })
                  }
                }
              ]
            }
          : { content: bodies.length === 2 ? '安装请求已提交。' : '已收到安装结果。' }
        for (const chunk of [
          { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          }
        ])
          response.write(`data: ${JSON.stringify(chunk)}\n\n`)
        response.end('data: [DONE]\n\n')
      })
    })
    let worker: L4PiChatWorker | undefined
    let basic: L4PiChatWorker | undefined
    let disposeCommands: (() => void) | undefined
    let notify: L4PiDeskCommandContext['notify'] | undefined
    let succeeded = false
    await mkdir(agentDir, { recursive: true })
    await mkdir(cwd, { recursive: true })
    server.listen(0, '127.0.0.1')
    await new Promise<void>((resolveListen) => server.once('listening', resolveListen))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    try {
      process.env.PI_CODING_AGENT_DIR = agentDir
      process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
      delete process.env.PI_DESK_SAFE_MODE
      const settingsText = JSON.stringify({
        defaultProvider: 'pidesk-fixture',
        defaultModel: 'fixture',
        defaultThinkingLevel: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
        packages: []
      })
      await writeFile(join(agentDir, 'settings.json'), settingsText)
      await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), '用户原有追加提示')
      const devSkillPath = join(agentDir, 'pi-desk', 'dev-skills', 'pi-desk', 'SKILL.md')
      const prodSkillPath = join(agentDir, 'pi-desk', 'skills', 'pi-desk', 'SKILL.md')
      const userSkillPath = join(agentDir, 'skills', 'user-skill', 'SKILL.md')
      for (const path of [devSkillPath, prodSkillPath, userSkillPath]) {
        await mkdir(dirname(path), { recursive: true })
      }
      await writeFile(devSkillPath, '旧开发环境宿主指引')
      await writeFile(prodSkillPath, '旧正式环境宿主指引')
      const userSkill = '---\nname: user-skill\ndescription: 测试用户自己的 Skill\n---\n用户说明'
      await writeFile(userSkillPath, userSkill)
      await writeFile(
        join(agentDir, 'models.json'),
        JSON.stringify({
          providers: {
            'pidesk-fixture': {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: 'openai-completions',
              apiKey: 'fixture',
              models: [
                {
                  id: 'fixture',
                  reasoning: false,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 512
                }
              ]
            }
          }
        })
      )
      const commands = await jiti.import<
        typeof import('../src/server/l4_foundation/pidesk/l4-pidesk-runtime')
      >('../src/server/l4_foundation/pidesk/l4-pidesk-runtime.ts')
      disposeCommands = commands.disposeL4PiDeskCommands
      await commands.initializeL4PiDeskCommands(async (command, context) => {
        assert.equal(command.action, 'install')
        notify = context.notify
        return { mode: 'async', message: '本次安装已接纳，完成后通知。' }
      }, true)
      await assert.rejects(readFile(devSkillPath), { code: 'ENOENT' })
      assert.equal(await readFile(prodSkillPath, 'utf8'), '旧正式环境宿主指引')
      assert.equal(await readFile(userSkillPath, 'utf8'), userSkill)
      const navigation = commands.appendL4PiDeskSystemPrompt()[0]
      const docsDirectory = resolve('docs/pi-desk')
      assert.ok(navigation.includes(docsDirectory.replaceAll('\\', '/')))
      assert.equal(navigation.includes('/skills/'), false)
      assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), settingsText)
      const info = await commands.executeL4PiDeskCommand(['info'], {
        cwd,
        signal: new AbortController().signal,
        notify: async () => {},
        reload: () => ({ mode: 'async', message: 'fixture' })
      })
      assert.equal(info.message.includes('\n'), false)
      assert.equal(JSON.parse(info.message).cwd, cwd)
      assert.equal(JSON.parse(info.message).agentDir, agentDir)
      assert.equal(JSON.parse(info.message).docsDirectory, docsDirectory)
      assert.equal('skillDirectory' in JSON.parse(info.message), false)

      const [{ SessionManager }, { L4PiChatWorker: Worker }] = await Promise.all([
        jiti.import<typeof import('@earendil-works/pi-coding-agent')>(
          '@earendil-works/pi-coding-agent'
        ),
        jiti.import<typeof import('../src/server/l4_foundation/pi/l4-pi-chat-worker')>(
          '../src/server/l4_foundation/pi/l4-pi-chat-worker.ts'
        )
      ])
      const manager = SessionManager.create(cwd, join(agentDir, 'sessions'))
      worker = new Worker(cwd, manager, undefined, {
        mode: () => 'no-skills',
        rules: () => ({ name: '禁用 Skills', skills: { allow: [] } })
      })
      const events: L4PiChatWorkerEvent[] = []
      worker.subscribe((event) => events.push(event))
      await worker.getRuntime()
      const tools = await worker.listNativeTools()
      assert.equal(tools.find((tool) => tool.name === 'pidesk')?.description, 'Pi Desk 命令入口。')
      assert.equal(tools.find((tool) => tool.name === 'pidesk')?.exposure, 'model-only')
      const skillCommands = await worker.listNativeCommands()
      assert.equal(
        skillCommands.some((command) => command.name.startsWith('skill:')),
        false
      )
      const initialPrompt = (await worker.readModelContext()).systemPrompt
      assert.ok(initialPrompt.includes(navigation))
      assert.match(initialPrompt, /用户原有追加提示/)

      const firstSettled = settled(worker)
      await worker.send({ text: '安装 fixture 插件', images: [], mode: 'auto' })
      await firstSettled
      assert.ok(notify)
      assert.equal(bodies.length, 2)
      assert.match(bodies[0], /Pi Desk 资料/)
      assert.match(bodies[0], /用户原有追加提示/)
      const receipt = manager
        .getEntries()
        .find(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'toolResult' &&
            entry.message.toolName === 'pidesk'
        )
      assert.ok(receipt)
      assert.match(JSON.stringify(receipt), /async/)
      assert.equal(
        manager.getEntries().filter((entry) => entry.type === 'custom_message').length,
        0
      )

      const quietDeadline = Date.now() + 10_000
      while (worker.readPluginReloadBlockReason()) {
        if (Date.now() >= quietDeadline)
          throw new Error(worker.readPluginReloadBlockReason() ?? '等待空闲超时')
        await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
      }
      await worker.reload('normal')
      assert.equal(
        (await worker.listNativeCommands()).filter((command) => command.name === 'skill:pi-desk')
          .length,
        0
      )
      const reloadedPrompt = (await worker.readModelContext()).systemPrompt
      assert.equal(reloadedPrompt.split('Pi Desk 资料').length - 1, 1)
      const completed = settled(worker)
      await notify('fixture 已安装 1.2.3，并完成加载。')
      await completed
      assert.equal(bodies.length, 3)
      assert.match(bodies[2], /fixture 已安装 1.2.3/)
      const completion = manager
        .getEntries()
        .find(
          (entry) =>
            entry.type === 'custom_message' && entry.customType === 'pi-desk:command-result'
        )
      assert.ok(completion)
      assert.ok(
        events.some((event) => event.type === 'message_commit' && event.entryId === completion.id)
      )
      assert.deepEqual(completion.type === 'custom_message' ? completion.details : null, {
        toolCallId: 'pidesk-call-fixture'
      })
      const sessionFile = manager.getSessionFile()
      assert.ok(sessionFile)
      assert.match(await readFile(sessionFile, 'utf8'), /pi-desk:command-result/)

      await commands.initializeL4PiDeskCommands(
        async () => ({ mode: 'sync', message: 'fixture' }),
        false
      )
      await assert.rejects(readFile(prodSkillPath), { code: 'ENOENT' })
      await assert.rejects(readFile(devSkillPath), { code: 'ENOENT' })
      assert.equal(await readFile(userSkillPath, 'utf8'), userSkill)
      assert.equal(commands.appendL4PiDeskSystemPrompt()[0], navigation)
      basic = new Worker(cwd, SessionManager.create(cwd, join(agentDir, 'sessions')))
      await basic.reload('basic')
      assert.equal((await basic.getRuntime()).extensionMode, 'basic')
      assert.ok((await basic.listNativeTools()).some((tool) => tool.name === 'pidesk'))
      assert.equal(
        (await basic.listNativeCommands()).some((command) => command.name === 'skill:pi-desk'),
        false
      )
      const basicPrompt = (await basic.readModelContext()).systemPrompt
      assert.ok(basicPrompt.includes(navigation))
      assert.match(basicPrompt, /用户原有追加提示/)
      await basic.dispose()
      basic = undefined
      delete process.env.PI_DESK_SAFE_MODE
      await worker.dispose()
      worker = undefined
      await notify('失效会话不应收到此消息')
      assert.equal(bodies.length, 3)
      assert.doesNotMatch(await readFile(sessionFile, 'utf8'), /失效会话不应收到/)
      commands.disposeL4PiDeskCommands()
      assert.deepEqual(commands.appendL4PiDeskSystemPrompt(['保留原有提示']), ['保留原有提示'])
      assert.equal(
        commands.createL4PiDeskTool(async () => ({ mode: 'sync', message: '' })),
        null
      )
      succeeded = true
    } finally {
      await basic?.dispose()
      await worker?.dispose()
      disposeCommands?.()
      server.closeAllConnections()
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      )
      for (const [key, value] of Object.entries({
        PI_CODING_AGENT_DIR: saved.agentDir,
        PI_CODING_AGENT_SESSION_DIR: saved.sessionDir,
        PI_DESK_SAFE_MODE: saved.safe
      })) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (succeeded) await rm(root, { recursive: true, force: true })
    }
  }
)
