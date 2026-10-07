import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

import { assertPortReleased, spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const testRoot = join(projectRoot, 'temp', 'pi', 'message-platform-visual', String(process.pid))
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, '消息平台视觉项目')
const pluginPackageDir = join(testRoot, 'message-fixture-package')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const workId = 'message-platform-visual-work-session'
const desktopCustomOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '消息平台__自定义View.png'
)
const desktopErrorOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '消息平台__ErrorView.png'
)
const mobileCustomOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '消息平台__自定义View.png'
)
const password = 'Qq.445566'
let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''
let sessionId = ''

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
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

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {
      // 目标仍在启动。
    }
    await delay(100)
  }
  throw new Error(`${label}启动超时\n${serverOutput}`)
}

async function createFixture() {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(dirname(workSessionStorePath), { recursive: true })
  await mkdir(projectDir, { recursive: true })
  await mkdir(join(pluginPackageDir, 'browser'), { recursive: true })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ packages: [pluginPackageDir] }),
    'utf8'
  )
  await writeFile(
    join(pluginPackageDir, 'package.json'),
    JSON.stringify({
      name: 'message-fixture-package',
      type: 'module',
      piDesk: { entry: './entry.mjs' }
    }),
    'utf8'
  )
  await writeFile(
    join(pluginPackageDir, 'entry.mjs'),
    `export default {
  name: 'message-fixture',
  setup(plugin) {
    plugin.registerBrowserEntry('./browser/entry.js')
    plugin.declareMessage('custom-card', {
      priority: 100,
      match(input) {
        return input.message.kind === 'custom' && input.message.customType === 'ui-fixture-message'
      },
      project(input) {
        const details = input.message.kind === 'custom' && input.message.details && typeof input.message.details === 'object' && !Array.isArray(input.message.details)
          ? input.message.details
          : {}
        return {
          viewKey: 'message-fixture/custom-card',
          summary: {
            title: details.title ?? 'Fixture 自定义消息',
            status: details.status ?? 'ready'
          },
          detail: { output: details.output ?? 'Fixture canonical detail' }
        }
      }
    })
    plugin.declareMessage('read-card', {
      priority: 100,
      match(input) {
        return input.message.kind === 'tool' && input.message.toolName === 'read'
      },
      project(input) {
        return {
          viewKey: 'pi-desk/read',
          summary: {
            title: '插件 Read View',
            path: input.defaultProjection.summary.inputPreview ?? null
          },
          detail: input.defaultProjection.detail
        }
      }
    })
    for (const name of ['conflict-a', 'conflict-b']) {
      plugin.declareMessage(name, {
        priority: 100,
        match(input) {
          return input.message.kind === 'custom' && input.message.customType === 'ui-fixture-conflict'
        },
        project(input) {
          return input.defaultProjection
        }
      })
    }
  }
}
`,
    'utf8'
  )
  await writeFile(
    join(pluginPackageDir, 'browser', 'entry.js'),
    `export default function messageBrowserEntry(plugin) {
  window.__messageFixtureFactoryCount = (window.__messageFixtureFactoryCount ?? 0) + 1
  const loadView = () => import('./view.js')
  plugin.registerContribution('message-view', 'custom-card', {
    viewKey: 'message-fixture/custom-card',
    priority: 100,
    load: () => loadView().then((module) => module.customCard)
  })
  plugin.registerContribution('message-view', 'read-card', {
    viewKey: 'pi-desk/read',
    priority: 100,
    load: () => loadView().then((module) => module.readCard)
  })
}
`,
    'utf8'
  )
  await writeFile(
    join(pluginPackageDir, 'browser', 'view.js'),
    `function mountCard(container, target, kind) {
  const root = document.createElement('article')
  root.setAttribute('data-fixture-message-view', kind)
  root.style.cssText = 'border:1px solid color-mix(in srgb,var(--primary) 45%,var(--border));border-radius:14px;padding:14px;background:linear-gradient(135deg,color-mix(in srgb,var(--primary) 10%,var(--card)),var(--card));box-shadow:0 8px 24px rgba(0,0,0,.08)'
  const render = () => {
    const snapshot = target.message.getSnapshot()
    const summary = snapshot.summary
    root.innerHTML = ''
    const title = document.createElement('strong')
    title.textContent = String(summary.title ?? 'Fixture Message View')
    title.style.cssText = 'display:block;font-size:15px'
    const meta = document.createElement('div')
    meta.textContent = kind + ' · ' + String(summary.status ?? summary.path ?? snapshot.fixed.viewKey)
    meta.style.cssText = 'margin-top:4px;color:var(--muted-foreground);font-size:12px'
    root.append(title, meta)
    if (snapshot.detail) {
      const detail = document.createElement('pre')
      detail.textContent = JSON.stringify(snapshot.detail, null, 2)
      detail.style.cssText = 'margin:12px 0 0;padding:10px;border-radius:10px;background:var(--background);white-space:pre-wrap;font-size:12px'
      root.append(detail)
    } else if ('entryId' in snapshot.location && snapshot.fixed.hasDetail) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = kind === 'custom' ? '加载自定义详情' : '加载 Read 详情'
      button.style.cssText = 'margin-top:10px;min-height:36px;padding:0 12px;border:0;border-radius:9px;background:var(--primary);color:var(--primary-foreground);font-weight:600;cursor:pointer'
      button.addEventListener('click', () => void target.message.loadDetail())
      root.append(button)
    }
  }
  const unsubscribe = target.message.subscribe(render)
  render()
  container.append(root)
  return () => {
    unsubscribe()
    root.remove()
  }
}

export const customCard = {
  mount({ container, target }) {
    return mountCard(container, target, 'custom')
  }
}

export const readCard = {
  mount({ container, target }) {
    return mountCard(container, target, 'read')
  }
}
`,
    'utf8'
  )

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  const timestamp = Date.now()
  const usage = {
    input: 120,
    output: 45,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 165,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '请展示自定义消息平台。' }],
    timestamp
  })
  manager.appendCustomMessageEntry('ui-fixture-message', '构建状态', true, {
    title: 'Fixture 构建完成',
    status: 'completed',
    output: '自定义消息 Detail 已按需加载。'
  })
  manager.appendMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: '正在验证插件覆盖内置 Read View。' },
      {
        type: 'toolCall',
        id: 'message-visual-read',
        name: 'read',
        arguments: {
          path: 'plugins/pi-desk-sdk/docs/message-protocol.md',
          reasoning: '验证 Read View'
        }
      }
    ],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'toolUse',
    timestamp: timestamp + 2
  })
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'message-visual-read',
    toolName: 'read',
    content: [{ type: 'text', text: 'Read canonical output' }],
    usage,
    isError: false,
    timestamp: timestamp + 3
  })
  manager.appendCustomMessageEntry('ui-fixture-conflict', '冲突消息', true, { secret: 'raw' })
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '自定义 View、Read 覆盖和 Error View 已进入同一聊天。' }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp + 5
  })
  manager.appendSessionInfo('消息平台视觉基线')
  sessionId = manager.getSessionId()
  await writeFile(
    workSessionStorePath,
    `${JSON.stringify({ workSessions: [{ workId, cwd: projectDir, sessionId }], pinnedCount: 0 }, null, 2)}\n`,
    'utf8'
  )
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8'))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }
      for (const listener of this.events.get(message.method) ?? []) listener(message.params)
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  once(method) {
    return new Promise((resolveEvent) => {
      const listeners = this.events.get(method) ?? new Set()
      const listener = (params) => {
        listeners.delete(listener)
        resolveEvent(params)
      }
      listeners.add(listener)
      this.events.set(method, listeners)
    })
  }
  close() {
    this.socket.close()
  }
}

async function createCdpPage(url) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT'
  })
  assert.equal(response.ok, true)
  const target = await response.json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  const client = new CdpClient(socket)
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  return client
}

async function navigate(client, url) {
  const loaded = client.once('Page.loadEventFired')
  await client.send('Page.navigate', { url })
  await loaded
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本执行失败')
  return result.result.value
}

async function waitFor(client, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return
    await delay(100)
  }
  const bodyText = await evaluate(client, `document.body.innerText.slice(0, 6000)`)
  throw new Error(
    `等待页面状态超时：${label}\n--- DOM ---\n${bodyText}\n--- Server ---\n${serverOutput}`
  )
}

async function clickText(client, text) {
  const clicked = await evaluate(
    client,
    `(() => {
    const target = [...document.querySelectorAll('button, [role="button"], summary')].find((element) => element.textContent?.includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`
  )
  assert.equal(clicked, true, `未找到按钮：${text}`)
}

async function screenshot(client) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  return Buffer.from(result.data, 'base64')
}

async function setViewport(client, width, height, mobile) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile
  })
}

async function waitForPortReleased(port) {
  const deadline = Date.now() + 10_000
  let lastError
  while (Date.now() < deadline) {
    try {
      await assertPortReleased(port)
      return
    } catch (error) {
      lastError = error
      await delay(100)
    }
  }
  throw lastError ?? new Error(`端口未释放：${port}`)
}

async function stopBrowser() {
  if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    const exited = once(browserProcess, 'exit').catch(() => undefined)
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(browserProcess.pid), '/T', '/F'], {
        windowsHide: true
      })
    } catch {
      // 进程可能已经退出。
    }
    await Promise.race([exited, delay(10_000)])
  }
  if (cdpPort > 0) await waitForPortReleased(cdpPort)
}

async function publishScreenshots(screenshots) {
  for (const [path, content] of screenshots) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

async function main() {
  let client
  try {
    await createFixture()
    appPort = await reservePort()
    cdpPort = await reservePort()
    serverRuntime = spawnE2eServer({
      projectRoot,
      agentDir,
      port: appPort,
      development: true,
      onOutput: (output) => {
        serverOutput += output
      }
    })
    await waitForHttp(`http://127.0.0.1:${appPort}/api/health`, 30_000, 'Pi Desk')
    browserProcess = spawn(
      edgePath,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${join(testRoot, 'edge-profile')}`,
        '--window-size=1440,900',
        'about:blank'
      ],
      { stdio: 'ignore', windowsHide: true }
    )
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge CDP')
    client = await createCdpPage('about:blank')
    await navigate(client, `http://127.0.0.1:${appPort}/login`)
    const login = await evaluate(
      client,
      `fetch('/api/auth/login', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '9cb9a521-aa18-42f7-8b50-6cd1841a273b' },
      body: JSON.stringify({ password: ${JSON.stringify(password)} })
    }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(login.ok, true, login.body?.msg)

    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await setViewport(client, 1440, 900, false)
    await waitFor(client, `document.body.innerText.includes('消息平台视觉项目')`, '工作会话显示')
    await waitFor(
      client,
      `window.__messageFixtureFactoryCount === 1`,
      'Message Browser Entry ready'
    )
    const beforeSelectionEntryRequests = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/plugins/browser-resources/') && entry.name.endsWith('/entry.js')).length`
    )
    const beforeSelectionChunkRequests = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/plugins/browser-resources/') && entry.name.endsWith('/view.js')).length`
    )
    assert.equal(beforeSelectionEntryRequests, 1)
    assert.equal(beforeSelectionChunkRequests, 0)
    await clickText(client, '消息平台视觉项目')
    await waitFor(client, `document.body.innerText.includes('处理过程')`, '消息回合显示')
    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach((element) => { element.style.display = 'none' })`
    )
    await clickText(client, '处理过程')
    await waitFor(
      client,
      `document.body.innerText.includes('Fixture 构建完成')`,
      'Custom Message View mount'
    )
    await waitFor(
      client,
      `document.body.innerText.includes('插件 Read View')`,
      'Read Message View override'
    )
    await waitFor(
      client,
      `document.body.innerText.includes('消息视图加载失败')`,
      'Declaration Error View'
    )
    assert.equal(await evaluate(client, `window.__messageFixtureFactoryCount`), 1)
    const viewRequests = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/plugins/browser-resources/') && entry.name.endsWith('/view.js')).length`
    )
    assert.equal(viewRequests, 1)
    const detailRequestsBefore = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/chat/messages/get')).length`
    )
    assert.equal(detailRequestsBefore, 0)

    const desktopError = await screenshot(client)
    await clickText(client, '加载自定义详情')
    await waitFor(
      client,
      `document.body.innerText.includes('自定义消息 Detail 已按需加载')`,
      'Custom Detail load'
    )
    const detailRequestsAfter = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/chat/messages/get')).length`
    )
    assert.equal(detailRequestsAfter, 1)
    const desktopCustom = await screenshot(client)

    await setViewport(client, 390, 844, true)
    await waitFor(client, `document.body.innerText.includes('处理过程')`, '移动端处理过程')
    await clickText(client, '处理过程')
    await waitFor(
      client,
      `document.body.innerText.includes('Fixture 构建完成')`,
      '移动端 Custom View'
    )
    await evaluate(
      client,
      `document.querySelector('[data-fixture-message-view="custom"]')?.scrollIntoView({ block: 'center' })`
    )
    await evaluate(
      client,
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    )
    const mobileCustom = await screenshot(client)

    await publishScreenshots([
      [desktopCustomOutput, desktopCustom],
      [desktopErrorOutput, desktopError],
      [mobileCustomOutput, mobileCustom]
    ])
    console.log(`desktopCustom=${desktopCustomOutput}`)
    console.log(`desktopError=${desktopErrorOutput}`)
    console.log(`mobileCustom=${mobileCustomOutput}`)
  } finally {
    client?.close()
    await stopBrowser()
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
