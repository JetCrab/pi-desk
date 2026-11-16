import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import { SESSION_PLUGIN_CAPABILITIES_EVENT } from '@jetcrab/pi-desk-sdk/session'
import { SubagentRuntime } from '../src/subagent-runtime.ts'
import { createResearchWorkerConfig } from '../src/research-runtime.ts'

async function closeSession(session) {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
  session.dispose()
}

for (const append of ['PARENT_RESOLVED_CUSTOM', '', undefined]) {
  test(
    `真实 Child 创建、恢复与 Research Worker 继承父追加 ${JSON.stringify(append)}`,
    { timeout: 30_000 },
    async (context) => {
      const root = resolve(
        import.meta.dirname,
        '../../../temp/pi/subagent-system-prompt',
        `inherit-${randomUUID()}`
      )
      const agentDir = join(root, 'agent')
      const cwd = join(root, 'project')
      const saved = {
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR
      }
      process.env.PI_CODING_AGENT_DIR = agentDir
      process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
      const requests = []
      const provider = createServer(async (request, response) => {
        let body = ''
        for await (const chunk of request) body += chunk
        requests.push(JSON.parse(body))
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
        for (const [delta, reason] of [
          [{ role: 'assistant', content: '子会话本地回答' }, null],
          [{}, 'stop']
        ]) {
          response.write(
            `data: ${JSON.stringify({ id: `child-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`
          )
        }
        response.end('data: [DONE]\n\n')
      })
      const sessions = new Set()
      let runtime
      let passed = false
      let port
      context.after(async () => {
        for (const session of sessions) await closeSession(session)
        await runtime?.shutdown()
        provider.closeAllConnections()
        await new Promise((resolveClose) => provider.close(resolveClose))
        const probe = createServer()
        await new Promise((resolveListen, rejectListen) => {
          probe.once('error', rejectListen)
          probe.listen(port, '127.0.0.1', () => probe.close(resolveListen))
        })
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        if (passed) await rm(root, { recursive: true, force: true })
        else console.error('子代理提示词测试现场：', root)
      })
      await new Promise((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen))
      port = provider.address().port
      await mkdir(join(agentDir, 'config', 'system-prompts'), { recursive: true })
      await mkdir(cwd, { recursive: true })
      // Child 只能消费父通知，不能自行读取宿主的全局追加资源。
      await writeFile(
        join(agentDir, 'config', 'system-prompts', 'global-append.md'),
        'MUST_NOT_READ_HOST_GLOBAL'
      )
      await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), 'NATIVE_CHILD_APPEND')
      await writeFile(join(cwd, 'AGENTS.md'), 'CHILD_PROJECT_RULE')
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } })
      )
      await writeFile(
        join(agentDir, 'models.json'),
        JSON.stringify({
          providers: {
            fixture: {
              api: 'openai-completions',
              baseUrl: `http://127.0.0.1:${port}/v1`,
              apiKey: 'fixture-only',
              models: [
                {
                  id: 'fixture',
                  reasoning: false,
                  input: ['text'],
                  contextWindow: 32768,
                  maxTokens: 256,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
                }
              ]
            }
          }
        })
      )
      const models = await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: join(agentDir, 'models.json')
      })
      let registration
      const pi = {
        events: {
          emit(channel, event) {
            if (channel === SESSION_PLUGIN_CAPABILITIES_EVENT) registration = event.registration
          }
        },
        on() {},
        registerTool() {},
        getActiveTools: () => [],
        setActiveTools() {},
        appendEntry() {}
      }
      runtime = new (class extends SubagentRuntime {
        open(config, parent, manager) {
          return super.createChildSession(config, parent, manager)
        }
      })(pi, models, agentDir)
      await registration.execute(
        {
          tools: {},
          skills: {},
          capabilities: {},
          ...(append === undefined ? {} : { appendSystemPrompt: append })
        },
        {}
      )
      const parentManager = SessionManager.create(cwd, join(agentDir, 'sessions'))
      const parent = {
        cwd,
        sessionId: parentManager.getSessionId(),
        sessionDir: parentManager.getSessionDir(),
        sessionFile: parentManager.getSessionFile(),
        model: models.getModel('fixture', 'fixture'),
        thinkingLevel: 'off',
        projectTrusted: true
      }
      const role = {
        name: 'explore',
        description: 'Fixture role',
        systemPrompt: 'CHILD_ROLE_INSTRUCTION',
        tools: ['read']
      }
      const manager = SessionManager.create(cwd, join(agentDir, 'sessions', 'children'))
      const first = await runtime.open(role, parent, manager)
      sessions.add(first)
      await first.prompt('创建请求')
      await first.prompt('连续第二请求')
      const file = first.sessionFile
      await closeSession(first)
      sessions.delete(first)
      const restored = await runtime.open(role, parent, SessionManager.open(file))
      sessions.add(restored)
      assert.equal(restored.sessionId, first.sessionId)
      await restored.prompt('恢复请求')
      const researchConfig = {
        ...role,
        name: 'research',
        tools: ['read'],
        systemPrompt: 'RESEARCH_ROLE_INSTRUCTION'
      }
      const research = await runtime.open(
        createResearchWorkerConfig(researchConfig),
        parent,
        SessionManager.create(cwd, join(agentDir, 'sessions', 'workers'))
      )
      sessions.add(research)
      await research.prompt('Research 派生请求')
      assert.equal(requests.length, 4)
      for (const [index, request] of requests.entries()) {
        const system = request.messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n')
        assert.match(system, /NATIVE_CHILD_APPEND/)
        assert.match(system, /CHILD_PROJECT_RULE/)
        assert.match(system, /子代理边界/)
        assert.match(system, index < 3 ? /CHILD_ROLE_INSTRUCTION/ : /# Research Worker/)
        assert.match(system, /不启动、建议或编排其他子代理/)
        assert.doesNotMatch(system, /MUST_NOT_READ_HOST_GLOBAL/)
        assert.equal(append ? system.split(append).length - 1 : 0, append ? 1 : 0)
      }
      const savedEntries = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.equal(
        savedEntries.some((entry) => entry.type === 'custom'),
        false
      )
      passed = true
    }
  )
}
