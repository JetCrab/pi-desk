import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import { assertPortReleased, spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await new Promise((resolveListen, rejectListen) => {
    server.once('listening', resolveListen)
    server.once('error', rejectListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

async function waitFor(predicate, label, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
}

function fixtureSource(version) {
  return `export default function (pi) {
    pi.registerTool({
      name: 'pidesk_local_fixture', label: 'Local fixture', description: 'fixture-${version}',
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text', text: '${version}' }] } }
    })
  }\n`
}

test('宿主启动注册 pidesk，设置业务加载本地变更并异步通知会话', { timeout: 180_000 }, async () => {
  const runId = `local-plugin-${randomUUID()}`
  const projectRoot = process.cwd()
  const root = resolve('temp/pi/l1-pidesk', runId)
  const evidence = resolve('temp/run/pidesk-e2e', runId)
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const plugin = join(agentDir, 'extensions', 'pidesk-local-fixture')
  const bodies = []
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      bodies.push(body)
      const first = bodies.length === 1
      const base = {
        id: `pidesk-e2e-${bodies.length}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'fixture'
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
      const delta = first
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'pidesk-e2e-call',
                type: 'function',
                function: {
                  name: 'pidesk',
                  arguments: JSON.stringify({
                    args: ['plugins', 'install', 'pidesk-local-fixture', '--scope', 'global']
                  })
                }
              }
            ]
          }
        : { content: bodies.length === 2 ? '已接纳安装请求。' : '已收到最终结果。' }
      for (const data of [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }
      ])
        response.write(`data: ${JSON.stringify(data)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  const modelPort = await listen(provider)
  const reservation = createServer()
  const port = await listen(reservation)
  await new Promise((resolveClose) => reservation.close(resolveClose))
  const clientId = randomUUID()
  const baseUrl = `http://127.0.0.1:${port}`
  let runtime
  let socket
  let output = ''
  let succeeded = false
  const messages = []
  const pending = new Map()
  const request = (path, body) =>
    new Promise((resolveResponse, rejectResponse) => {
      const requestId = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(requestId)
        rejectResponse(new Error(`请求超时：${path}`))
      }, 45_000)
      pending.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer)
          resolveResponse(response)
        },
        reject: (error) => {
          clearTimeout(timer)
          rejectResponse(error)
        }
      })
      socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
    })
  try {
    await Promise.all([
      mkdir(plugin, { recursive: true }),
      mkdir(cwd, { recursive: true }),
      mkdir(evidence, { recursive: true })
    ])
    await writeFile(join(plugin, 'index.ts'), fixtureSource('one'))
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        packages: [],
        defaultProvider: 'pidesk-e2e',
        defaultModel: 'fixture',
        defaultThinkingLevel: 'off',
        retry: { enabled: false },
        compaction: { enabled: false }
      })
    )
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'pidesk-e2e': {
            baseUrl: `http://127.0.0.1:${modelPort}/v1`,
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
    const offline = process.env.PI_OFFLINE
    process.env.PI_OFFLINE = '1'
    try {
      runtime = spawnE2eServer({
        projectRoot,
        agentDir,
        port,
        development: true,
        managed: true,
        onOutput: (chunk) => {
          output += chunk
        }
      })
    } finally {
      if (offline === undefined) delete process.env.PI_OFFLINE
      else process.env.PI_OFFLINE = offline
    }
    await waitFor(async () => {
      if (runtime.child.exitCode !== null) throw new Error(`宿主已退出：${output.slice(-8000)}`)
      try {
        return (await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) })).ok
      } catch {
        return false
      }
    }, '宿主健康检查')
    await waitFor(() => output.includes('插件加载尝试完成'), '宿主插件初始化')
    const skillPath = join(agentDir, 'pi-desk', 'dev-skills', 'pi-desk', 'SKILL.md')
    assert.match(await readFile(skillPath, 'utf8'), /name: pi-desk/)
    socket = new WebSocket(
      `${baseUrl.replace('http', 'ws')}/api/ws?clientId=${clientId}`,
      'pi-desk.v1'
    )
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString())
      messages.push(message)
      if (message.head.op !== 'resp') return
      const item = pending.get(message.head.requestId)
      if (!item) return
      pending.delete(message.head.requestId)
      if (message.body.code !== 0) item.reject(new Error(message.body.msg))
      else item.resolve(message.body.data)
    })
    await new Promise((resolveOpen, rejectOpen) => {
      socket.once('open', resolveOpen)
      socket.once('error', rejectOpen)
    })
    await request('work-sessions/list', {})
    const added = await fetch(`${baseUrl}/api/work-sessions/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
      body: JSON.stringify({ cwd })
    }).then((response) => response.json())
    assert.equal(added.code, 0, added.msg)
    const { workId, sessionId, branchId } = added.data.workSession
    const source = { workId, sessionId, branchId }
    const initialTools = await request('pi/tools/list', { source })
    assert.equal(
      initialTools.tools.find((tool) => tool.name === 'pidesk')?.description,
      'Pi Desk 命令入口。'
    )
    assert.equal(
      initialTools.tools.find((tool) => tool.name === 'pidesk_local_fixture')?.description,
      'fixture-one'
    )
    const commands = await request('pi/commands/list', { source })
    assert.equal(commands.commands.filter((command) => command.name === 'skill:pi-desk').length, 1)
    await request('chat/subscribe', { subscriptions: [{ source, cursor: null }] })
    await writeFile(join(plugin, 'index.ts'), fixtureSource('two'))
    await request('chat/send', { source, mode: 'auto', text: '加载本地插件的修改', images: [] })
    await waitFor(
      () => bodies.some((body) => body.includes('Pi Desk 命令执行结果')),
      '异步结果进入模型上下文',
      60_000
    )
    const notified = bodies.find((body) => body.includes('Pi Desk 命令执行结果'))
    assert.match(notified, /并完成加载/)
    assert.ok(
      messages.some(
        (message) =>
          message.head.op === 'push' &&
          JSON.stringify(message.body).includes('Pi Desk 命令执行结果')
      )
    )
    const updatedTools = await request('pi/tools/list', { source })
    assert.equal(
      updatedTools.tools.find((tool) => tool.name === 'pidesk_local_fixture')?.description,
      'fixture-two'
    )
    succeeded = true
  } finally {
    for (const item of pending.values()) item.reject(new Error('测试结束'))
    pending.clear()
    if (socket) {
      socket.on('error', () => undefined)
      socket.terminate()
    }
    if (runtime) await stopE2eServerTree(runtime)
    const tsconfigPath = join(projectRoot, 'tsconfig.json')
    const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8'))
    const generatedRoot = `${relative(projectRoot, root).replaceAll('\\', '/')}/next/`
    const include = tsconfig.include.filter((path) => !path.startsWith(generatedRoot))
    if (include.length !== tsconfig.include.length) {
      await writeFile(tsconfigPath, `${JSON.stringify({ ...tsconfig, include }, null, 2)}\n`)
    }
    provider.closeAllConnections()
    await new Promise((resolveClose) => provider.close(resolveClose))
    await assertPortReleased(modelPort)
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'server.log'), output)
    if (succeeded)
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(evidence, { recursive: true, force: true })
      ])
  }
})
