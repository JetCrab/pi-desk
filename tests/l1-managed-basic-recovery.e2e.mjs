import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import WebSocket from 'ws'
import {
  assertPortReleased,
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runRoot = join(projectRoot, 'temp', 'pi', 'l1-managed-basic-recovery', String(process.pid))
const agentDir = join(runRoot, 'agent')
const nextDir = join(runRoot, 'next')
const projectA = join(runRoot, 'project-a')
const projectB = join(runRoot, 'project-b')
const markerPath = join(agentDir, 'normal-extension-loaded.txt')
const evidenceRoot = join(
  projectRoot,
  'temp',
  'run',
  'plugin-basic-mode',
  'second-delivery-m1-m2-20260926'
)
const execFileAsync = promisify(execFile)
const protocol = 'pi-desk.v1'
const password = 'Local-test-password-42'
const clientId = randomUUID()
let output = ''
let serverRuntime
let modelServer
let modelPort
let appPort
let authCookie = ''
let firstSocket
let recoveredSocket
let replacementSocket
let observerSocket
let normalExtensionLoadCount = 0

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function withTimeout(promise, label, timeoutMs = 10_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}等待超时`)), timeoutMs)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    if (
      serverRuntime &&
      (serverRuntime.child.exitCode !== null || serverRuntime.child.signalCode !== null)
    ) {
      throw new Error(`${label}等待期间托管CLI退出：\n${output}`)
    }
    await delay(50)
  }
  throw new Error(`${label}等待超时：\n${output}`)
}

function countOutput(text) {
  return output.split(text).length - 1
}

async function reservePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
  return address.port
}

async function startFakeModelServer() {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'close'
      })
      const base = {
        id: `chatcmpl-local-${requests.length}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'local-fake-model'
      }
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { content: `local fake response ${requests.length}` },
              finish_reason: null
            }
          ]
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 }
        }
      ]
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { server, port: address.port, requests }
}

async function waitForHealth() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (serverRuntime?.child.exitCode !== null || serverRuntime?.child.signalCode !== null) {
      throw new Error(`托管CLI提前退出：\n${output}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/health`)
      if (response.ok) return
    } catch {
      // Next 开发服务仍在准备中。
    }
    await delay(100)
  }
  throw new Error(`托管Pi Desk未在时限内健康：\n${output}`)
}

async function post(path, body, authenticated = true) {
  const response = await fetch(`http://127.0.0.1:${appPort}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pi-Desk-Client-Id': clientId,
      Origin: `http://127.0.0.1:${appPort}`,
      ...(authenticated && authCookie ? { Cookie: authCookie } : {})
    },
    body: JSON.stringify(body)
  })
  const envelope = await response.json()
  assert.equal(response.ok, true, `${path}: ${envelope.msg}\n${output}`)
  assert.equal(envelope.code, 0, `${path}: ${envelope.msg}\n${output}`)
  return envelope.data
}

async function setupAuthentication() {
  await post('/api/auth-settings/replace', { password }, false)
  const response = await fetch(`http://127.0.0.1:${appPort}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pi-Desk-Client-Id': clientId,
      Origin: `http://127.0.0.1:${appPort}`
    },
    body: JSON.stringify({ password })
  })
  const envelope = await response.json()
  assert.equal(response.ok, true, envelope.msg)
  assert.equal(envelope.code, 0, envelope.msg)
  const cookie = response.headers.get('set-cookie')
  assert.ok(cookie)
  authCookie = cookie.split(';', 1)[0]
}

async function openSocket(connectionId) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${appPort}/api/ws?clientId=${connectionId}`,
    protocol,
    { headers: { Cookie: authCookie } }
  )
  await withTimeout(
    new Promise((resolveOpen, rejectOpen) => {
      socket.once('open', resolveOpen)
      socket.once('error', rejectOpen)
    }),
    '应用WebSocket打开'
  )
  return socket
}

function receiveJsonWhere(socket, predicate, label, timeoutMs = 20_000) {
  return new Promise((resolveMessage, rejectMessage) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onError = (error) => {
      cleanup()
      rejectMessage(error)
    }
    const onClose = (code, reason) => {
      cleanup()
      rejectMessage(new Error(`${label}等待时WebSocket关闭：${code}/${reason.toString()}`))
    }
    const onMessage = (data, isBinary) => {
      if (isBinary) {
        cleanup()
        rejectMessage(new Error(`${label}收到二进制WebSocket消息`))
        return
      }
      const message = JSON.parse(data.toString('utf8'))
      if (!predicate(message)) return
      cleanup()
      resolveMessage(message)
    }
    const timer = setTimeout(() => {
      cleanup()
      rejectMessage(new Error(`${label}等待超时`))
    }, timeoutMs)
    socket.on('message', onMessage)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function receiveClose(socket) {
  return new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      socket.off('close', onClose)
      rejectClose(new Error('等待旧WebSocket关闭超时'))
    }, 15_000)
    const onClose = (code) => {
      clearTimeout(timer)
      resolveClose(code)
    }
    socket.once('close', onClose)
  })
}

async function request(socket, path, body = {}) {
  const requestId = randomUUID()
  const response = receiveJsonWhere(
    socket,
    (message) => message.head?.op === 'resp' && message.head.requestId === requestId,
    `${path} response`
  )
  socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
  const message = await response
  assert.equal(message.head.path, path)
  return message.body
}

async function findServerChildPid(supervisorPid) {
  const command = [
    `$supervisorPid = ${supervisorPid}`,
    '$children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $supervisorPid" -ErrorAction Stop)',
    '$server = $children | Where-Object { $_.CommandLine -and $_.CommandLine.Contains("l1-server.ts") } | Select-Object -First 1',
    'if ($server) { [Console]::Out.WriteLine([string]$server.ProcessId); exit 0 } else { exit 1 }'
  ].join('; ')
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 5_000 }
    )
    const pid = Number(stdout.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch (error) {
    if (error.code === 1) return null
    throw error
  }
}

async function killNormalServiceChild() {
  assert.equal(process.platform, 'win32', '该故障注入使用Windows子进程PID')
  const deadline = Date.now() + 10_000
  let pid = null
  while (Date.now() < deadline && !pid) {
    pid = await findServerChildPid(serverRuntime.child.pid)
    if (!pid) await delay(50)
  }
  assert.ok(pid, `未找到managed l1-server 子进程\n${output}`)
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/F'], {
    windowsHide: true,
    timeout: 10_000
  })
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return
  if (socket.readyState === WebSocket.OPEN) socket.close()
  await withTimeout(
    new Promise((resolveClose) => socket.once('close', resolveClose)),
    'WebSocket关闭',
    10_000
  )
}

test(
  'managed normal异常退出恢复basic并继续真实Pi聊天与Native工具',
  { timeout: 210_000 },
  async (context) => {
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(projectA, { recursive: true }),
      mkdir(projectB, { recursive: true }),
      mkdir(evidenceRoot, { recursive: true })
    ])
    await prepareIsolatedPiDirectory(agentDir)
    modelServer = await startFakeModelServer()
    modelPort = modelServer.port
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'local-fixture',
        defaultModel: 'local-fake-model',
        defaultThinkingLevel: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
        extensions: [join(agentDir, 'extensions', 'normal-only.ts')]
      }),
      'utf8'
    )
    await mkdir(join(agentDir, 'extensions'), { recursive: true })
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'local-fixture': {
            name: 'Local Test Fixture',
            baseUrl: `http://127.0.0.1:${modelPort}/v1`,
            api: 'openai-completions',
            apiKey: 'local-only',
            models: [
              {
                id: 'local-fake-model',
                name: 'Local Fake Model',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 256
              }
            ]
          }
        }
      }),
      'utf8'
    )
    await writeFile(
      join(agentDir, 'extensions', 'normal-only.ts'),
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(markerPath)}, 'loaded\\n')\nexport default function (pi) { pi.on('input', () => ({ action: 'continue' })) }\n`,
      'utf8'
    )

    appPort = await reservePort()
    context.after(async () => {
      const cleanupErrors = []
      for (const socket of [firstSocket, recoveredSocket, replacementSocket, observerSocket]) {
        try {
          await closeSocket(socket)
        } catch (error) {
          cleanupErrors.push(error)
          socket?.terminate()
        }
      }
      try {
        if (serverRuntime) await stopE2eServerTree(serverRuntime)
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (modelServer) {
        modelServer.server.closeAllConnections()
        await new Promise((resolveClose) => modelServer.server.close(() => resolveClose()))
        await assertPortReleased(modelPort)
      }
      await rm(runRoot, { recursive: true, force: true })
      await writeFile(join(evidenceRoot, 'managed-basic-recovery-server.log'), output, 'utf8')
      await writeFile(
        join(evidenceRoot, 'managed-basic-recovery-summary.json'),
        JSON.stringify(
          {
            managed: true,
            development: true,
            finalMode: 'basic',
            localModelRequests: modelServer?.requests.length ?? 0,
            normalExtensionLoadCount,
            cleanupErrors: cleanupErrors.map((error) => String(error))
          },
          null,
          2
        ),
        'utf8'
      )
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'managed recovery E2E资源清理失败')
      }
    })

    serverRuntime = spawnE2eServer({
      projectRoot,
      agentDir,
      port: appPort,
      development: true,
      managed: true,
      onOutput: (data) => {
        output += data
      }
    })
    await waitForHealth()
    await waitFor(() => countOutput('开发服务已启动') >= 1, 'normal服务ready', 30_000)
    assert.equal(existsSync(nextDir), true, 'Next开发缓存必须位于本次Pi测试运行目录')
    await setupAuthentication()

    firstSocket = await openSocket(clientId)
    const firstBootstrap = await request(firstSocket, 'work-sessions/list')
    assert.equal(firstBootstrap.code, 0, output)
    assert.equal(firstBootstrap.data.appRuntime.mode, 'normal')

    const code75SocketClosed = receiveClose(firstSocket)
    assert.equal(serverRuntime.child.send('pi-desk.restart'), true)
    await withTimeout(code75SocketClosed, '受控code75重启旧连接关闭', 15_000)
    await waitFor(() => countOutput('开发服务已启动') >= 2, 'code75后normal服务重启', 40_000)
    await waitForHealth()
    firstSocket = await openSocket(clientId)
    const code75Bootstrap = await request(firstSocket, 'work-sessions/list')
    assert.equal(code75Bootstrap.data.appRuntime.mode, 'normal')

    const added = await post('/api/work-sessions/add', { cwd: projectA })
    const source = {
      workId: added.workSession.workId,
      sessionId: added.workSession.sessionId,
      branchId: added.workSession.branchId
    }
    assert.equal(
      (
        await request(firstSocket, 'chat/subscribe', {
          subscriptions: [{ source, cursor: null }]
        })
      ).code,
      0
    )
    const normalTools = await request(firstSocket, 'pi/tools/list', { source })
    assert.equal(normalTools.code, 0)
    for (const name of ['read', 'write', 'edit', 'bash']) {
      assert.ok(
        normalTools.data.tools.some((tool) => tool.name === name),
        `normal缺少${name}`
      )
    }
    normalExtensionLoadCount = (await readFile(markerPath, 'utf8')).trim().split('\n').length
    assert.ok(normalExtensionLoadCount > 0, 'normal Session应加载隔离外部extension')

    const firstCommit = receiveJsonWhere(
      firstSocket,
      (message) =>
        message.head?.op === 'push' &&
        message.head.path === 'chat/source-event' &&
        message.body?.source?.workId === source.workId &&
        message.body?.event?.type === 'message_commit' &&
        message.body.event.durable?.index >= 1,
      'normal模式assistant聊天commit'
    )
    const normalSend = await request(firstSocket, 'chat/send', {
      source,
      mode: 'auto',
      text: 'normal seed message',
      images: []
    })
    assert.equal(normalSend.code, 0, JSON.stringify(normalSend))
    const normalCommit = await withTimeout(firstCommit, 'normal模式聊天完成')
    const firstEntryId = normalCommit.body.event.durable.entryId
    assert.ok(firstEntryId)
    const normalFullSyncPush = receiveJsonWhere(
      firstSocket,
      (message) =>
        message.head?.op === 'push' &&
        message.head.path === 'chat/source-event' &&
        message.body?.source?.workId === source.workId &&
        message.body?.event?.type === 'session_sync',
      'normal模式durable full sync'
    )
    await request(firstSocket, 'chat/subscribe', { subscriptions: [{ source, cursor: null }] })
    const normalFullSync = await withTimeout(normalFullSyncPush, 'normal模式durable快照')
    assert.equal(normalFullSync.body.event.mode, 'full')
    const normalAssistant = normalFullSync.body.event.messages.find(
      (message) => message.fixed.type === 'assistant'
    )
    assert.ok(normalAssistant)
    assert.equal(normalAssistant.location.entryId, firstEntryId)
    assert.match(normalAssistant.summary.text, /local fake response 1/)

    const oldSocketClosed = new Promise((resolveClose) => firstSocket.once('close', resolveClose))
    await killNormalServiceChild()
    await waitFor(() => output.includes('正在以基础模式恢复'), 'normal异常后切换basic', 30_000)
    await waitFor(() => countOutput('开发服务已启动') >= 2, 'basic服务ready', 40_000)
    await waitForHealth()
    await withTimeout(oldSocketClosed, '异常服务旧WebSocket关闭', 15_000)

    recoveredSocket = await openSocket(clientId)
    const recoveredBootstrap = await request(recoveredSocket, 'work-sessions/list')
    assert.equal(recoveredBootstrap.code, 0)
    assert.equal(recoveredBootstrap.data.appRuntime.mode, 'basic')
    const recoveredSource = recoveredBootstrap.data.workSessions.find(
      (workSession) => workSession.workId === source.workId
    )
    assert.ok(recoveredSource)
    assert.equal(recoveredSource.sessionId, source.sessionId)
    assert.equal(recoveredSource.branchId, source.branchId)

    const firstRecoverySync = receiveJsonWhere(
      recoveredSocket,
      (message) =>
        message.head?.op === 'push' &&
        message.head.path === 'chat/source-event' &&
        message.body?.source?.workId === source.workId &&
        message.body?.event?.type === 'session_sync',
      '恢复后权威聊天快照'
    )
    assert.equal(
      (
        await request(recoveredSocket, 'chat/subscribe', {
          subscriptions: [{ source, cursor: null }]
        })
      ).code,
      0
    )
    const recoveredSync = await withTimeout(firstRecoverySync, '恢复后的full sync')
    assert.equal(recoveredSync.body.event.mode, 'full')
    assert.ok(
      recoveredSync.body.event.messages.some(
        (message) => message.fixed.type === 'assistant' && message.location.entryId === firstEntryId
      )
    )

    const replacedCloseCode = new Promise((resolveClose) => {
      recoveredSocket.once('close', (code) => resolveClose(code))
    })
    replacementSocket = await openSocket(clientId)
    assert.equal(await withTimeout(replacedCloseCode, 'same clientId旧连接替换'), 4001)
    const replacementBootstrap = await request(replacementSocket, 'work-sessions/list')
    assert.equal(replacementBootstrap.data.appRuntime.mode, 'basic')

    const observerClientId = randomUUID()
    observerSocket = await openSocket(observerClientId)
    assert.equal((await request(observerSocket, 'work-sessions/list')).code, 0)
    const mainWorkSessionUpdate = receiveJsonWhere(
      replacementSocket,
      (message) =>
        message.head?.op === 'push' &&
        message.head.path === 'work-sessions/update' &&
        message.body?.type === 'snapshot',
      'main client work-session snapshot'
    )
    const observerWorkSessionUpdate = receiveJsonWhere(
      observerSocket,
      (message) =>
        message.head?.op === 'push' &&
        message.head.path === 'work-sessions/update' &&
        message.body?.type === 'snapshot',
      'different client work-session snapshot'
    )
    await post('/api/work-sessions/add', { cwd: projectB })
    const [mainUpdate, observerUpdate] = await Promise.all([
      withTimeout(mainWorkSessionUpdate, 'main client broadcast'),
      withTimeout(observerWorkSessionUpdate, 'observer client broadcast')
    ])
    assert.deepEqual(mainUpdate.body, observerUpdate.body)

    const basicTools = await request(replacementSocket, 'pi/tools/list', { source })
    assert.equal(basicTools.code, 0)
    for (const name of ['read', 'write', 'edit', 'bash']) {
      assert.ok(
        basicTools.data.tools.some((tool) => tool.name === name),
        `basic缺少${name}`
      )
    }
    const bash = await request(replacementSocket, 'pi/bash/execute', {
      source,
      command: 'node -p "40 + 2"',
      excludeFromContext: true
    })
    assert.equal(bash.code, 0, bash.msg)
    assert.match(bash.data.output, /42/)
    assert.equal(
      (await readFile(markerPath, 'utf8')).trim().split('\n').length,
      normalExtensionLoadCount
    )

    const beforeBasicSyncPush = receiveJsonWhere(
      replacementSocket,
      (message) =>
        message.head?.op === 'push' &&
        message.head.path === 'chat/source-event' &&
        message.body?.source?.workId === source.workId &&
        message.body?.event?.type === 'session_sync',
      'basic send前权威快照'
    )
    await request(replacementSocket, 'chat/subscribe', {
      subscriptions: [{ source, cursor: null }]
    })
    const beforeBasicSync = await withTimeout(beforeBasicSyncPush, 'basic send前快照')
    const nextAssistantIndex = beforeBasicSync.body.event.messages.length + 1
    const basicCommit = receiveJsonWhere(
      replacementSocket,
      (message) =>
        message.head?.op === 'push' &&
        message.head.path === 'chat/source-event' &&
        message.body?.source?.workId === source.workId &&
        message.body?.event?.type === 'message_commit' &&
        message.body.event.durable?.index >= nextAssistantIndex,
      'basic模式assistant聊天commit'
    )
    const basicSend = await request(replacementSocket, 'chat/send', {
      source,
      mode: 'auto',
      text: 'continue after supervisor recovery',
      images: []
    })
    assert.equal(basicSend.code, 0, JSON.stringify(basicSend))
    const basicCommitEvent = await withTimeout(basicCommit, 'basic模式本地fake聊天完成')
    const basicEntryId = basicCommitEvent.body.event.durable.entryId
    const basicFullSyncPush = receiveJsonWhere(
      replacementSocket,
      (message) =>
        message.head?.op === 'push' &&
        message.head.path === 'chat/source-event' &&
        message.body?.source?.workId === source.workId &&
        message.body?.event?.type === 'session_sync',
      'basic模式durable full sync'
    )
    await request(replacementSocket, 'chat/subscribe', {
      subscriptions: [{ source, cursor: null }]
    })
    const basicFullSync = await withTimeout(basicFullSyncPush, 'basic模式durable快照')
    assert.equal(basicFullSync.body.event.mode, 'full')
    const basicAssistant = basicFullSync.body.event.messages.find(
      (message) => message.fixed.type === 'assistant' && message.location.entryId === basicEntryId
    )
    assert.ok(basicAssistant)
    assert.match(basicAssistant.summary.text, /local fake response 2/)
    assert.equal(modelServer.requests.length, 2)
  }
)
