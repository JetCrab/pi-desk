import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const testRoot = join(projectRoot, 'temp', 'pi', 'task-center-visual', String(process.pid))
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, '视觉验收项目')
const logPath = join(projectDir, 'temp', 'pi', 'task-center-visual', 'run.log')
const childSessionDir = join(agentDir, 'task-center-child-sessions')
const extensionDir = join(agentDir, 'extensions', 'task-center-visual')
const summaryOutput = join(projectRoot, 'temp', '验收', '客户端_桌面', '任务中心__输入框摘要.png')
const menuOutput = join(projectRoot, 'temp', '验收', '客户端_桌面', '输入框__更多菜单.png')
const desktopOutput = join(projectRoot, 'temp', '验收', '客户端_桌面', '任务中心__会话详情.png')
const mobileOutput = join(projectRoot, 'temp', '验收', '客户端_移动端', '任务中心__任务列表.png')
const mobileMenuOutput = join(projectRoot, 'temp', '验收', '客户端_移动端', '输入框__更多菜单.png')
const password = 'Qq.445566'
let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
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
  await mkdir(projectDir, { recursive: true })
  await mkdir(dirname(logPath), { recursive: true })
  await writeFile(logPath, '服务启动\n正在监听 3000 端口\n', 'utf8')

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir, childSessionDir)
  const timestamp = Date.now()
  const usage = {
    input: 1200,
    output: 345,
    cacheRead: 6000,
    cacheWrite: 0,
    totalTokens: 7545,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.001, cacheWrite: 0, total: 0.004 }
  }
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '请审查任务中心协议和消息持续性。' }],
    timestamp
  })
  manager.appendMessage({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '检查 Snapshot、实时增量和重连边界。' },
      { type: 'text', text: '协议审查完成：重新打开使用有界 Snapshot，打开期间使用实时增量。' },
      {
        type: 'toolCall',
        id: 'visual-tool-call',
        name: 'read',
        arguments: { path: 'docs/任务中心_1_公共协议.md', reasoning: '核对公共协议' }
      }
    ],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'toolUse',
    timestamp: timestamp + 1
  })
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'visual-tool-call',
    toolName: 'read',
    content: [{ type: 'text', text: '协议文件读取完成' }],
    usage,
    isError: false,
    timestamp: timestamp + 2
  })
  for (let index = 0; index < 205; index += 1) {
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `长子代理处理消息 ${index}` }],
      api: 'openai-responses',
      provider: 'test',
      model: 'test-model',
      usage,
      stopReason: 'stop',
      timestamp: timestamp + 3 + index
    })
  }
  manager.appendMessage({
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '协议审查完成：任务详情保留完整公共消息，页面渐进挂载会话元素。'
      }
    ],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp + 208
  })
  const sessionFile = manager.getSessionFile()
  assert.ok(sessionFile)
  const displaySessionFile = `${sessionFile}\\${'nested-session-directory\\'.repeat(4)}session.json`

  await mkdir(extensionDir, { recursive: true })
  await writeFile(
    join(extensionDir, 'index.ts'),
    `const channel = 'pi-desk:task-report:v1'
export default function taskCenterVisual(pi) {
  pi.on('session_start', () => {
    pi.events.emit(channel, {
      type: 'upsert',
      tasks: [
        {
          taskId: 'visual-running',
          taskKind: '服务',
          taskType: 'development',
          title: '启动 Pi Desk 开发服务',
          info: [{ label: '运行地址', value: '127.0.0.1 / 3000' }],
          status: 'running',
          activity: '正在监听 3000 端口',
          startedAt: Date.now() - 73000,
          endedAt: null,
          detailSource: { kind: 'text-file', path: ${JSON.stringify(logPath)} },
          interrupt: async () => undefined
        },
        {
          taskId: 'visual-conversation',
          taskKind: '子代理',
          taskType: 'explore',
          title: '审查任务中心协议',
          info: [],
          infoLoader: () => [
            { label: '运行信息', value: 'test/test-model · 7,545/128,000 tokens' },
            { label: '消息数', value: '1/209（用户/总数）' },
            { label: '会话文件', value: ${JSON.stringify(displaySessionFile)} }
          ],
          status: 'completed',
          activity: '执行完成',
          startedAt: Date.now() - 180000,
          endedAt: Date.now() - 1000,
          detailSource: { kind: 'pi-conversation', sessionFile: ${JSON.stringify(sessionFile)} },
          interrupt: null
        }
      ]
    })
  })
}
`,
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
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本执行失败')
  }
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
      const target = [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')].reverse().find((button) => button.textContent?.includes(${JSON.stringify(text)}));
      if (!target) return false;
      target.click();
      return true;
    })()`
  )
  assert.equal(clicked, true, `未找到按钮：${text}`)
}

async function clickAriaLabel(client, label) {
  const clicked = await evaluate(
    client,
    `(() => {
      const target = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
      if (!target) return false;
      target.click();
      return true;
    })()`
  )
  assert.equal(clicked, true, `未找到操作：${label}`)
}

async function screenshot(client) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  return Buffer.from(result.data, 'base64')
}

async function stopBrowser() {
  if (!browserProcess || browserProcess.exitCode !== null || browserProcess.signalCode !== null)
    return
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(browserProcess.pid), '/T', '/F'], {
      windowsHide: true
    })
  } catch {
    // 进程可能已经退出。
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
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '51aed4e9-fbc7-4fe9-8995-0ee4fb3812c1' },
        body: JSON.stringify({ password: ${JSON.stringify(password)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(login.ok, true, login.body?.msg)
    const created = await evaluate(
      client,
      `fetch('/api/work-sessions/add', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': 'a522968a-e973-4f01-9450-15747f8c680d' },
        body: JSON.stringify({ cwd: ${JSON.stringify(projectDir)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(created.ok, true, created.body?.msg)

    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitFor(client, `document.body.innerText.includes('视觉验收项目')`, '工作会话出现在侧栏')
    await clickText(client, '视觉验收项目')
    await waitFor(
      client,
      `document.body.innerText.includes('1 个任务执行中')`,
      '输入框上方任务摘要'
    )
    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach((element) => { element.style.display = 'none' })`
    )
    const summary = await screenshot(client)
    await clickAriaLabel(client, '更多操作')
    await waitFor(client, `document.body.innerText.includes('任务中心')`, '更多菜单打开')
    const menu = await screenshot(client)
    await clickText(client, '任务中心')
    await waitFor(
      client,
      `document.querySelector('[role="dialog"]')?.textContent.includes('任务中心') === true`,
      '桌面任务中心打开'
    )
    await clickText(client, '审查任务中心协议')
    await waitFor(
      client,
      `document.body.innerText.includes('协议审查完成')`,
      'Conversation 详情显示'
    )
    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach((element) => { element.style.display = 'none' })`
    )
    const taskLayout = await evaluate(
      client,
      `(() => {
        const buttons = [...document.querySelectorAll('[role="dialog"] button')];
        const inspectRow = (button, identityText, titleText) => {
          const time = button?.querySelector('time');
          const metadata = time?.parentElement;
          const identity = [...(button?.querySelectorAll('span') ?? [])].find(
            (span) => span.textContent?.trim() === identityText
          );
          const title = [...(button?.querySelectorAll('span') ?? [])].find(
            (span) => span.textContent?.trim() === titleText
          );
          const metadataBox = metadata?.getBoundingClientRect();
          const identityBox = identity?.getBoundingClientRect();
          const titleBox = title?.getBoundingClientRect();
          return {
            text: button?.textContent ?? '',
            metadataText: metadata?.textContent?.trim() ?? '',
            firstRowAligned:
              metadataBox !== undefined &&
              identityBox !== undefined &&
              identityBox.top < metadataBox.bottom &&
              identityBox.bottom > metadataBox.top,
            titleSecondRow:
              titleBox !== undefined &&
              metadataBox !== undefined &&
              identityBox !== undefined &&
              titleBox.top >= Math.max(metadataBox.bottom, identityBox.bottom) - 1
          };
        };
        const running = buttons.find((button) => button.textContent?.includes('启动 Pi Desk 开发服务'));
        const conversation = buttons.find((button) => button.textContent?.includes('审查任务中心协议'));
        return {
          running: inspectRow(running, '服务 / development', '启动 Pi Desk 开发服务'),
          conversation: inspectRow(conversation, '子代理 / explore', '审查任务中心协议'),
          info: [...document.querySelectorAll('[role="dialog"] dl')].map((element) => element.textContent ?? '').join(' ')
        };
      })()`
    )
    assert.match(taskLayout.running.text, /服务\s*\/\s*development/)
    assert.match(
      taskLayout.running.metadataText,
      /\d+(?:秒|分钟|小时(?:\d+分钟)?)\s*·\s*\d{1,2}:\d{2}/
    )
    assert.equal(/[执行启动]/.test(taskLayout.running.metadataText), false)
    assert.equal(taskLayout.running.firstRowAligned, true)
    assert.equal(taskLayout.running.titleSecondRow, true)
    assert.equal(taskLayout.running.text.includes('执行中'), false)
    assert.equal(taskLayout.running.text.includes('正在监听 3000 端口'), false)
    assert.match(taskLayout.conversation.text, /子代理\s*\/\s*explore/)
    assert.match(
      taskLayout.conversation.metadataText,
      /\d+(?:秒|分钟|小时(?:\d+分钟)?)\s*·\s*\d{1,2}:\d{2}/
    )
    assert.equal(/[执行启动]/.test(taskLayout.conversation.metadataText), false)
    assert.equal(taskLayout.conversation.firstRowAligned, true)
    assert.equal(taskLayout.conversation.titleSecondRow, true)
    assert.match(taskLayout.info, /运行信息.*test\/test-model.*7,545\/128,000 tokens/)
    assert.match(taskLayout.info, /消息数.*1\/209.*用户\/总数/)
    assert.ok(
      (await evaluate(
        client,
        `document.querySelectorAll('[role="dialog"] [data-chat-turn]').length`
      )) <= 30
    )
    await clickText(client, '处理过程')
    await waitFor(
      client,
      `[...document.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent?.includes('处理过程') && button.getAttribute('aria-expanded') === 'true')`,
      '长子代理处理过程展开'
    )
    await waitFor(
      client,
      `(() => {
        const trigger = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent?.includes('处理过程') && button.getAttribute('aria-expanded') === 'true');
        const panel = trigger?.closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"]');
        const scroll = document.querySelector('[role="dialog"] .pi-desk-chat-scrollbar');
        return panel instanceof HTMLElement && panel.clientHeight > 100 && scroll instanceof HTMLElement && scroll.scrollHeight > scroll.clientHeight + 100;
      })()`,
      '长子代理处理过程布局完成'
    )
    const mountedProcessItems = await evaluate(
      client,
      `document.querySelectorAll('[role="dialog"] [data-chat-process-item]').length`
    )
    assert.ok(mountedProcessItems <= 64, `初始处理过程元素过多：${mountedProcessItems}`)
    const navigationReady = await evaluate(
      client,
      `(() => {
        const scroll = document.querySelector('[role="dialog"] .pi-desk-chat-scrollbar');
        if (!(scroll instanceof HTMLElement)) return false;
        scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
        return true;
      })()`
    )
    assert.equal(navigationReady, true)
    await waitFor(
      client,
      `document.querySelector('[aria-label="回到聊天底部"]') !== null`,
      '任务详情回到底部导航'
    )
    await clickAriaLabel(client, '回到聊天底部')
    await evaluate(
      client,
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    )
    await waitFor(
      client,
      `(() => {
        const scroll = document.querySelector('[role="dialog"] .pi-desk-chat-scrollbar');
        return scroll instanceof HTMLElement && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2;
      })()`,
      '任务详情到达底部'
    )
    await evaluate(
      client,
      `(() => {
        const scroll = document.querySelector('[role="dialog"] .pi-desk-chat-scrollbar');
        if (!(scroll instanceof HTMLElement)) return false;
        scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
        return true;
      })()`
    )
    await waitFor(
      client,
      `document.querySelector('[aria-label="定位到上一条用户消息"]') !== null`,
      '任务详情上一条用户消息导航'
    )
    await clickAriaLabel(client, '定位到上一条用户消息')
    await waitFor(
      client,
      `(() => {
        const scroll = document.querySelector('[role="dialog"] .pi-desk-chat-scrollbar');
        const user = scroll?.querySelector('[data-chat-user-message]');
        if (!(scroll instanceof HTMLElement) || !(user instanceof HTMLElement)) return false;
        return Math.abs(user.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12) <= 2;
      })()`,
      '启动 Prompt 定位到顶部'
    )
    const desktop = await screenshot(client)

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true
    })
    await delay(300)
    if (!(await evaluate(client, `document.body.innerText.includes('2 条执行记录')`))) {
      await clickAriaLabel(client, '返回任务列表')
    }
    await waitFor(client, `document.body.innerText.includes('2 条执行记录')`, '移动端任务列表显示')
    const mobileRow = await evaluate(
      client,
      `(() => {
        const row = [...document.querySelectorAll('[role="dialog"] button')].find(
          (button) => button.textContent?.includes('审查任务中心协议')
        );
        const time = row?.querySelector('time');
        const metadata = time?.parentElement;
        const identity = [...(row?.querySelectorAll('span') ?? [])].find(
          (span) => span.textContent?.trim() === '子代理 / explore'
        );
        const title = [...(row?.querySelectorAll('span') ?? [])].find(
          (span) => span.textContent?.trim() === '审查任务中心协议'
        );
        const metadataBox = metadata?.getBoundingClientRect();
        const identityBox = identity?.getBoundingClientRect();
        const titleBox = title?.getBoundingClientRect();
        return {
          text: row?.textContent ?? '',
          metadataText: metadata?.textContent?.trim() ?? '',
          firstRowAligned:
            metadataBox !== undefined &&
            identityBox !== undefined &&
            identityBox.top < metadataBox.bottom &&
            identityBox.bottom > metadataBox.top,
          titleSecondRow:
            titleBox !== undefined &&
            metadataBox !== undefined &&
            identityBox !== undefined &&
            titleBox.top >= Math.max(metadataBox.bottom, identityBox.bottom) - 1
        };
      })()`
    )
    assert.match(mobileRow.text, /子代理\s*\/\s*explore/)
    assert.match(mobileRow.metadataText, /\d+(?:秒|分钟|小时(?:\d+分钟)?)\s*·\s*\d{1,2}:\d{2}/)
    assert.equal(/[执行启动]/.test(mobileRow.metadataText), false)
    assert.equal(mobileRow.firstRowAligned, true)
    assert.equal(mobileRow.titleSecondRow, true)
    assert.equal(mobileRow.text.includes('执行中'), false)
    const mobile = await screenshot(client)
    await clickText(client, '审查任务中心协议')
    await waitFor(
      client,
      `(() => {
        const scroll = document.querySelector('[role="dialog"] [data-task-info-scroll]');
        return scroll instanceof HTMLElement && scroll.clientHeight <= 128 && scroll.scrollHeight > scroll.clientHeight;
      })()`,
      '移动端任务信息区域限高滚动'
    )
    assert.equal(
      await evaluate(
        client,
        `(() => {
          const button = document.querySelector('[role="dialog"] [aria-label="返回任务列表"]');
          return (
            button instanceof HTMLButtonElement &&
            button.textContent?.trim() === '' &&
            button.children.length === 1 &&
            button.firstElementChild?.tagName.toLowerCase() === 'svg'
          );
        })()`
      ),
      true
    )
    await clickAriaLabel(client, '关闭任务中心')
    await waitFor(
      client,
      `document.querySelector('[role="dialog"]') === null`,
      '移动端任务中心关闭'
    )
    await clickAriaLabel(client, '更多操作')
    await waitFor(client, `document.body.innerText.includes('任务中心')`, '移动端更多菜单打开')
    const mobileMenu = await screenshot(client)

    await mkdir(dirname(summaryOutput), { recursive: true })
    await mkdir(dirname(menuOutput), { recursive: true })
    await mkdir(dirname(desktopOutput), { recursive: true })
    await mkdir(dirname(mobileOutput), { recursive: true })
    await mkdir(dirname(mobileMenuOutput), { recursive: true })
    await writeFile(summaryOutput, summary)
    await writeFile(menuOutput, menu)
    await writeFile(desktopOutput, desktop)
    await writeFile(mobileOutput, mobile)
    await writeFile(mobileMenuOutput, mobileMenu)
    console.log(`summary=${summaryOutput}`)
    console.log(`menu=${menuOutput}`)
    console.log(`desktop=${desktopOutput}`)
    console.log(`mobile=${mobileOutput}`)
    console.log(`mobileMenu=${mobileMenuOutput}`)
  } finally {
    client?.close()
    await stopBrowser()
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
