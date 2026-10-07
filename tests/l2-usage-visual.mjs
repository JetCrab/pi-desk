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
const testRoot = join(projectRoot, 'temp', 'pi', 'pi-desk-usage', 'visual', String(process.pid))
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, '用量视觉项目')
const usagePackageDir = join(projectRoot, 'plugins', 'pi-desk-usage')
let sessionsDir = ''
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const workId = 'usage-visual-work'
const password = 'Qq.445566'
const finalOutputs = {
  desktopDashboard: join(projectRoot, 'temp', '验收', '客户端_桌面', '模型用量__24小时总览.png'),
  mobileDashboard: join(projectRoot, 'temp', '验收', '客户端_移动端', '模型用量__24小时总览.png'),
  desktopSevenDayDashboard: join(
    projectRoot,
    'temp',
    '验收',
    '客户端_桌面',
    '模型用量__7天日历.png'
  ),
  desktopMonthlyDashboard: join(
    projectRoot,
    'temp',
    '验收',
    '客户端_桌面',
    '模型用量__本月月历.png'
  ),
  mobileSevenDayDashboard: join(
    projectRoot,
    'temp',
    '验收',
    '客户端_移动端',
    '模型用量__7天日历.png'
  ),
  mobileMonthlyDashboard: join(
    projectRoot,
    'temp',
    '验收',
    '客户端_移动端',
    '模型用量__本月月历.png'
  ),
  desktopTimeline: join(projectRoot, 'temp', '验收', '客户端_桌面', '模型用量__单会话时间剖析.png'),
  mobileTimeline: join(
    projectRoot,
    'temp',
    '验收',
    '客户端_移动端',
    '模型用量__单会话时间剖析.png'
  ),
  desktopActivity: join(projectRoot, 'temp', '验收', '客户端_桌面', '模型用量__单会话活动回顾.png')
}

let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''

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

function iso(value) {
  return new Date(value).toISOString()
}

function usage(prompt, output, cost, hitRate = 0.86) {
  const cacheRead = Math.round(prompt * hitRate)
  const input = prompt - cacheRead
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: prompt + output,
    cost: {
      input: cost * 0.18,
      output: cost * 0.22,
      cacheRead: cost * 0.6,
      cacheWrite: 0,
      total: cost
    }
  }
}

function sessionBuilder(sessionId, cwd, timestamp, parentSession) {
  const entries = [
    {
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: iso(timestamp),
      cwd,
      ...(parentSession ? { parentSession } : {})
    }
  ]
  let parentId = null
  let nextId = 1
  return {
    add(type, timestampValue, value) {
      const id = nextId.toString(16).padStart(8, '0')
      nextId += 1
      entries.push({ type, id, parentId, timestamp: iso(timestampValue), ...value })
      parentId = id
      return id
    },
    text() {
      return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    }
  }
}

function addAssistant(
  builder,
  timestamp,
  prompt,
  output,
  cost,
  text,
  model = 'gpt-5.6-sol',
  hitRate = 0.86
) {
  return builder.add('message', timestamp, {
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-responses',
      provider: 'my',
      model,
      usage: usage(prompt, output, cost, hitRate),
      stopReason: 'stop',
      timestamp
    }
  })
}

async function createFixture() {
  await Promise.all([
    mkdir(join(agentDir, 'sessions'), { recursive: true }),
    mkdir(dirname(workSessionStorePath), { recursive: true }),
    mkdir(projectDir, { recursive: true })
  ])
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const probe = SessionManager.create(projectDir)
  const probeFile = probe.getSessionFile()
  assert.ok(probeFile)
  sessionsDir = dirname(probeFile)
  await rm(probeFile, { force: true })

  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ packages: [usagePackageDir] }, null, 2),
    'utf8'
  )

  const now = Date.now()
  const mainSessionId = 'usage-visual-main'
  const mainFile = join(sessionsDir, `2026-08-26T00-00-00_${mainSessionId}.jsonl`)
  const childRoot = join(sessionsDir, 'subagents', mainSessionId)
  await mkdir(childRoot, { recursive: true })
  const childAFile = join(childRoot, 'usage-child-a.jsonl')
  const childBFile = join(childRoot, 'usage-child-b.jsonl')

  const childA = sessionBuilder('usage-child-a', projectDir, now - 17 * 60 * 60 * 1000, mainFile)
  childA.add('message', now - 17 * 60 * 60 * 1000, {
    message: {
      role: 'user',
      content: [{ type: 'text', text: '实现前端传输层' }],
      timestamp: now - 17 * 60 * 60 * 1000
    }
  })
  addAssistant(
    childA,
    now - 16.8 * 60 * 60 * 1000,
    52_000,
    3_200,
    0.18,
    '开始分析前端传输层。',
    'gpt-5.6-luna',
    0.62
  )
  addAssistant(
    childA,
    now - 15.6 * 60 * 60 * 1000,
    128_000,
    5_400,
    0.42,
    '完成协议梳理。',
    'gpt-5.6-luna',
    0.76
  )
  addAssistant(
    childA,
    now - 13.8 * 60 * 60 * 1000,
    236_000,
    8_100,
    0.77,
    '实现 Runtime。',
    'gpt-5.6-luna',
    0.88
  )
  addAssistant(
    childA,
    now - 11.4 * 60 * 60 * 1000,
    318_000,
    9_200,
    1.03,
    '完成联调和测试。',
    'gpt-5.6-luna',
    0.93
  )
  await writeFile(childAFile, childA.text(), 'utf8')

  const childB = sessionBuilder('usage-child-b', projectDir, now - 16.5 * 60 * 60 * 1000, mainFile)
  childB.add('message', now - 16.5 * 60 * 60 * 1000, {
    message: {
      role: 'user',
      content: [{ type: 'text', text: '实现 Node Runtime' }],
      timestamp: now - 16.5 * 60 * 60 * 1000
    }
  })
  addAssistant(
    childB,
    now - 16.2 * 60 * 60 * 1000,
    76_000,
    4_100,
    0.25,
    '读取 Node 端实现。',
    'gpt-5.6-luna',
    0.58
  )
  addAssistant(
    childB,
    now - 14.7 * 60 * 60 * 1000,
    174_000,
    6_600,
    0.57,
    '完成核心适配。',
    'gpt-5.6-luna',
    0.81
  )
  addAssistant(
    childB,
    now - 12.1 * 60 * 60 * 1000,
    282_000,
    8_400,
    0.91,
    '补充生命周期处理。',
    'gpt-5.6-luna',
    0.9
  )
  addAssistant(
    childB,
    now - 9.2 * 60 * 60 * 1000,
    398_000,
    10_200,
    1.3,
    '完成完整测试。',
    'gpt-5.6-luna',
    0.95
  )
  await writeFile(childBFile, childB.text(), 'utf8')

  const main = sessionBuilder(mainSessionId, projectDir, now - 21 * 60 * 60 * 1000)
  const firstUser = main.add('message', now - 21 * 60 * 60 * 1000, {
    message: {
      role: 'user',
      content: [{ type: 'text', text: '建设复杂 Electron 基础设施。' }],
      timestamp: now - 21 * 60 * 60 * 1000
    }
  })
  main.add('session_info', now - 20.9 * 60 * 60 * 1000, { name: '复杂上下文会话' })
  main.add('custom', now - 20.8 * 60 * 60 * 1000, {
    customType: 'context-ignore-state',
    data: {
      enabled: false,
      mode: 'user-turns',
      keepTurns: 3,
      updatedAt: now - 20.8 * 60 * 60 * 1000
    }
  })
  addAssistant(main, now - 20 * 60 * 60 * 1000, 92_000, 4_800, 0.31, '完成初始架构梳理。')
  addAssistant(main, now - 18.3 * 60 * 60 * 1000, 168_000, 6_200, 0.55, '明确基础设施边界。')
  main.add('message', now - 17.1 * 60 * 60 * 1000, {
    message: {
      role: 'toolResult',
      toolCallId: 'launch-a',
      toolName: 'agent',
      content: [{ type: 'text', text: 'started' }],
      details: {
        version: 1,
        kind: 'launch',
        taskId: 'usage-child-a-task',
        agentType: 'dev',
        title: '实现 Front 传输 Runtime',
        sessionFile: childAFile,
        startedAt: now - 17.1 * 60 * 60 * 1000
      },
      isError: false,
      timestamp: now - 17.1 * 60 * 60 * 1000
    }
  })
  main.add('message', now - 16.6 * 60 * 60 * 1000, {
    message: {
      role: 'toolResult',
      toolCallId: 'launch-b',
      toolName: 'agent',
      content: [{ type: 'text', text: 'started' }],
      details: {
        version: 1,
        kind: 'launch',
        taskId: 'usage-child-b-task',
        agentType: 'dev',
        title: '实现 Node 传输 Runtime',
        sessionFile: childBFile,
        startedAt: now - 16.6 * 60 * 60 * 1000
      },
      isError: false,
      timestamp: now - 16.6 * 60 * 60 * 1000
    }
  })
  addAssistant(main, now - 16.1 * 60 * 60 * 1000, 274_000, 7_400, 0.89, '主代理继续装配协议。')
  main.add('custom', now - 14.9 * 60 * 60 * 1000, {
    customType: 'context-ignore-state',
    data: {
      enabled: true,
      mode: 'user-turns',
      cutoffTimestamp: now - 20 * 60 * 60 * 1000,
      pendingUsageRefreshAfterTimestamp: now - 16.1 * 60 * 60 * 1000,
      estimatedContextTokens: 182_000,
      keepTurns: 3,
      updatedAt: now - 14.9 * 60 * 60 * 1000
    }
  })
  addAssistant(
    main,
    now - 14 * 60 * 60 * 1000,
    214_000,
    6_900,
    0.7,
    '忽略旧过程后继续。',
    'gpt-5.6-sol',
    0.9
  )
  addAssistant(main, now - 12 * 60 * 60 * 1000, 386_000, 8_800, 1.22, '上下文重新增长。')
  addAssistant(main, now - 10.6 * 60 * 60 * 1000, 526_000, 10_400, 1.68, '接近上下文阈值。')
  main.add('custom', now - 10.2 * 60 * 60 * 1000, {
    customType: 'context-ignore-state',
    data: {
      enabled: true,
      mode: 'user-turns',
      cutoffTimestamp: now - 14 * 60 * 60 * 1000,
      pendingUsageRefreshAfterTimestamp: now - 10.6 * 60 * 60 * 1000,
      estimatedContextTokens: 318_000,
      keepTurns: 3,
      updatedAt: now - 10.2 * 60 * 60 * 1000
    }
  })
  main.add('compaction', now - 10 * 60 * 60 * 1000, {
    summary: '压缩后的会话摘要',
    firstKeptEntryId: firstUser,
    tokensBefore: 526_000
  })
  addAssistant(
    main,
    now - 8.4 * 60 * 60 * 1000,
    68_000,
    4_100,
    0.24,
    '压缩后继续主任务。',
    'gpt-5.6-sol',
    0.84
  )
  main.add('message', now - 7.8 * 60 * 60 * 1000, {
    message: {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'long-visual-bash',
          name: 'bash',
          arguments: { reasoning: '运行完整使用量验证' }
        }
      ],
      api: 'openai-responses',
      provider: 'my',
      model: 'gpt-5.6-sol',
      usage: usage(12_000, 1_200, 0.08),
      stopReason: 'toolUse',
      timestamp: now - 7.8 * 60 * 60 * 1000
    }
  })
  main.add('message', now - 7.5 * 60 * 60 * 1000, {
    message: {
      role: 'toolResult',
      toolCallId: 'long-visual-bash',
      toolName: 'bash',
      content: [{ type: 'text', text: '验证完成' }],
      isError: false,
      timestamp: now - 7.5 * 60 * 60 * 1000
    }
  })
  addAssistant(main, now - 5.2 * 60 * 60 * 1000, 126_000, 5_300, 0.43, '完成并行结果整合。')
  addAssistant(main, now - 1.2 * 60 * 60 * 1000, 198_000, 6_700, 0.66, '完成最终验证。')
  main.add('custom_message', now - 11 * 60 * 60 * 1000, {
    customType: 'pi-desk-subagent:completion:v1',
    content: 'Front 子代理已完成。',
    display: true,
    details: {
      version: 1,
      kind: 'terminal',
      taskId: 'usage-child-a-task',
      status: 'completed',
      endedAt: now - 11 * 60 * 60 * 1000,
      sessionFile: childAFile
    }
  })
  main.add('custom_message', now - 8.8 * 60 * 60 * 1000, {
    customType: 'pi-desk-subagent:completion:v1',
    content: 'Node 子代理已完成。',
    display: true,
    details: {
      version: 1,
      kind: 'terminal',
      taskId: 'usage-child-b-task',
      status: 'completed',
      endedAt: now - 8.8 * 60 * 60 * 1000,
      sessionFile: childBFile
    }
  })
  await writeFile(mainFile, main.text(), 'utf8')

  const monthlySessionAt = now - 3 * 24 * 60 * 60 * 1000
  const monthly = sessionBuilder('usage-monthly', projectDir, monthlySessionAt)
  monthly.add('message', monthlySessionAt, {
    message: {
      role: 'user',
      content: [{ type: 'text', text: '整理本月模型用量' }],
      timestamp: monthlySessionAt
    }
  })
  monthly.add('session_info', monthlySessionAt + 60_000, { name: '月度大用量会话' })
  addAssistant(
    monthly,
    monthlySessionAt + 120_000,
    123_456_789,
    1_234_567,
    18.4,
    '完成本月用量汇总。',
    'gpt-5.6-sol',
    0.72
  )
  await writeFile(
    join(sessionsDir, `monthly-${monthlySessionAt}-usage-monthly.jsonl`),
    monthly.text(),
    'utf8'
  )

  await writeFile(
    workSessionStorePath,
    `${JSON.stringify({ workSessions: [{ workId, cwd: projectDir, sessionId: mainSessionId }], pinnedCount: 0 }, null, 2)}\n`,
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

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // 服务仍在启动。
    }
    await delay(100)
  }
  throw new Error(`${label}启动超时\n${serverOutput}`)
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

async function waitFor(client, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return
    await delay(100)
  }
  const body = await evaluate(client, `document.body.innerText.slice(0, 5000)`)
  throw new Error(
    `等待页面状态超时：${label}\n--- DOM ---\n${body}\n--- Server ---\n${serverOutput}`
  )
}

async function clickText(client, text) {
  const clicked = await evaluate(
    client,
    `(() => { const target = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].reverse().find((element) => element.textContent?.trim().includes(${JSON.stringify(text)})); if (!target) return false; target.click(); return true })()`
  )
  assert.equal(clicked, true, `未找到按钮：${text}`)
}

async function clickExactText(client, text) {
  const clicked = await evaluate(
    client,
    `(() => { const target = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].reverse().find((element) => element.textContent?.trim() === ${JSON.stringify(text)}); if (!target) return false; target.click(); return true })()`
  )
  assert.equal(clicked, true, `未找到精确按钮：${text}`)
}

async function clickShortcut(client, text) {
  const result = await evaluate(
    client,
    `(() => {
      const buttons = [...document.querySelectorAll('button')];
      const target = buttons.find((element) => element.title === ${JSON.stringify(text)});
      if (target) target.click();
      return {
        clicked: Boolean(target),
        buttons: buttons.map((element) => ({
          text: element.textContent?.trim() ?? '',
          title: element.title,
          ariaLabel: element.getAttribute('aria-label')
        }))
      };
    })()`
  )
  assert.equal(
    result.clicked,
    true,
    `未找到快捷入口：${text}\n${JSON.stringify(result.buttons, null, 2)}`
  )
}

async function clickAriaLabel(client, label) {
  const clicked = await evaluate(
    client,
    `(() => { const target = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}); if (!target) return false; target.click(); return true })()`
  )
  assert.equal(clicked, true, `未找到操作：${label}`)
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

async function stopBrowser() {
  if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    const exited = once(browserProcess, 'exit').catch(() => undefined)
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(browserProcess.pid), '/T', '/F'], {
        windowsHide: true
      })
    } catch {
      // 浏览器可能已经退出。
    }
    await Promise.race([exited, delay(10_000)])
  }
  if (cdpPort > 0) await assertPortReleased(cdpPort)
}

async function publishScreenshots(values) {
  for (const [filePath, content] of values) {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
  }
}

async function main() {
  let client
  let failure
  const screenshots = new Map()
  try {
    await createFixture()
    appPort = await reservePort()
    cdpPort = await reservePort()
    process.env.PI_DESK_MANAGED_RESTART = '1'
    serverRuntime = spawnE2eServer({
      projectRoot,
      agentDir,
      port: appPort,
      development: false,
      onOutput: (output) => {
        serverOutput += output
      }
    })
    await waitForHttp(`http://127.0.0.1:${appPort}/api/health`, 40_000, 'Pi Desk')

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
      `fetch('/api/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':'8f43b82e-3da5-40ba-8bbd-3541d1d779de'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(async response=>({ok:response.ok,body:await response.json()}))`
    )
    assert.equal(login.ok, true, login.body?.msg)

    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await setViewport(client, 1440, 900, false)
    await waitFor(client, `document.querySelector('button[title="用量"]') !== null`, '用量应用入口')
    await clickText(client, '用量视觉项目')
    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach((element)=>{element.style.display='none'})`
    )
    await clickShortcut(client, '用量')
    await waitFor(
      client,
      `document.querySelector('[data-usage-application]') && document.body.innerText.includes('消耗趋势')`,
      '用量总览加载'
    )
    await waitFor(
      client,
      `document.querySelector('[aria-label="输入总量和缓存命中率趋势"]') !== null && document.querySelectorAll('[data-usage-session]').length >= 1`,
      '趋势和父 Session 显示'
    )
    assert.equal(await evaluate(client, `document.body.innerText.includes('Cache Write')`), false)
    assert.equal(
      await evaluate(client, `document.body.innerText.includes('面积表示输入总量')`),
      false
    )
    assert.equal(await evaluate(client, `document.body.innerText.includes('24 小时')`), true)
    assert.equal(
      await evaluate(client, `document.querySelector('[data-usage-calendar]') === null`),
      true
    )
    assert.equal(
      await evaluate(client, `document.querySelectorAll('.usage-chart-hit-zone').length`),
      48
    )
    await evaluate(
      client,
      `document.querySelector('[data-usage-session] button[aria-expanded="false"]')?.click()`
    )
    await waitFor(
      client,
      `document.body.innerText.includes('实现 Front 传输 Runtime') && document.body.innerText.includes('实现 Node 传输 Runtime')`,
      '子代理折叠展开'
    )
    screenshots.set(finalOutputs.desktopDashboard, await screenshot(client))

    await clickText(client, '7 天')
    await waitFor(
      client,
      `document.querySelector('[data-usage-calendar="range"]') !== null && document.querySelector('[aria-label="输入总量和缓存命中率趋势"]') !== null`,
      '7 天趋势和日历加载'
    )
    assert.equal(
      await evaluate(
        client,
        `document.querySelectorAll('[data-usage-calendar="range"] [data-usage-date]').length`
      ),
      7
    )
    await waitFor(client, `document.body.innerText.includes('亿')`, '7 天亿级用量显示')
    assert.equal(
      await evaluate(
        client,
        `(() => { const chart=document.querySelector('.usage-chart-panel'); const calendar=document.querySelector('[data-usage-calendar="range"]'); return Boolean(chart && calendar && (chart.compareDocumentPosition(calendar) & 4)); })()`
      ),
      true
    )
    screenshots.set(finalOutputs.desktopSevenDayDashboard, await screenshot(client))
    const selectedRangeDate = await evaluate(
      client,
      `(() => { const target=[...document.querySelectorAll('[data-usage-date]:not(:disabled)')].find((element) => element.textContent?.includes('亿')); if (!target) return false; target.click(); return true })()`
    )
    assert.equal(selectedRangeDate, true)
    await waitFor(
      client,
      `document.querySelector('[data-usage-date][data-selected="true"]') !== null && document.body.innerText.includes('月度大用量会话')`,
      '7 天日历日期筛选 Session'
    )

    await clickText(client, '30 天')
    await waitFor(
      client,
      `document.querySelector('[data-usage-calendar="range"]') !== null && document.querySelectorAll('[data-usage-calendar="range"] [data-usage-date]').length === 30`,
      '30 天日历加载'
    )
    await clickText(client, '本月')
    await waitFor(
      client,
      `document.querySelector('[data-usage-calendar="month"]') !== null && document.querySelector('[aria-label="输入总量和缓存命中率趋势"]') !== null`,
      '本月趋势和月历加载'
    )
    await waitFor(client, `document.body.innerText.includes('月度大用量会话')`, '月度 Session 显示')
    screenshots.set(finalOutputs.desktopMonthlyDashboard, await screenshot(client))

    await setViewport(client, 390, 844, true)
    await clickText(client, '7 天')
    await waitFor(
      client,
      `document.querySelector('[data-usage-application]')?.getBoundingClientRect().width <= 390 && document.querySelector('[data-usage-calendar="range"]') !== null`,
      '移动端 7 天日历适配'
    )
    assert.equal(
      await evaluate(
        client,
        `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`
      ),
      true
    )
    screenshots.set(finalOutputs.mobileSevenDayDashboard, await screenshot(client))
    await clickText(client, '本月')
    await waitFor(
      client,
      `document.querySelector('[data-usage-calendar="month"]') !== null`,
      '移动端本月日历适配'
    )
    screenshots.set(finalOutputs.mobileMonthlyDashboard, await screenshot(client))
    await clickText(client, '24 小时')
    await waitFor(
      client,
      `document.querySelector('[data-usage-calendar]') === null && document.querySelector('[aria-label="输入总量和缓存命中率趋势"]') !== null`,
      '恢复 24 小时视图'
    )
    assert.equal(
      await evaluate(client, `document.querySelectorAll('.usage-chart-hit-zone').length`),
      48
    )
    screenshots.set(finalOutputs.mobileDashboard, await screenshot(client))

    await setViewport(client, 1440, 900, false)
    await clickAriaLabel(client, '关闭 模型用量')
    await clickAriaLabel(client, '更多操作')
    await waitFor(client, `document.body.innerText.includes('会话分析')`, '会话分析菜单')
    await clickText(client, '会话分析')
    await waitFor(
      client,
      `document.querySelector('[data-usage-session-analysis]') && document.querySelector('[aria-label="Token/分趋势"]') !== null`,
      '会话时间剖析加载'
    )
    await waitFor(
      client,
      `document.querySelectorAll('.usage-profiler-context-line').length >= 3 && document.querySelectorAll('.usage-profiler-marker').length === 3`,
      '主子代理上下文和事件标记'
    )
    const selected = await evaluate(
      client,
      `(() => { const chart=document.querySelector('[aria-label="Token/分趋势"]'); if (!chart) return false; const rect=chart.getBoundingClientRect(); chart.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:rect.left+rect.width*.66,clientY:rect.top+rect.height/2,pointerId:1,pointerType:'mouse'})); return true })()`
    )
    assert.equal(selected, true)
    await waitFor(
      client,
      `document.body.innerText.includes('选中时间段') && document.body.innerText.includes('运行完整使用量验证')`,
      '选择时间段并回顾 Bash 活动'
    )
    assert.equal(
      await evaluate(
        client,
        `(() => { const detail=document.querySelector('[data-usage-selected="true"]'); if (!detail) return false; const rect=detail.getBoundingClientRect(); return rect.top < window.innerHeight && rect.bottom > 0; })()`
      ),
      true
    )
    assert.equal(
      await evaluate(
        client,
        `document.querySelector('[aria-label="上下文大小趋势"]')?.getBoundingClientRect().height <= 120`
      ),
      true
    )
    screenshots.set(finalOutputs.desktopTimeline, await screenshot(client))
    await clickExactText(client, '代理')
    await waitFor(
      client,
      `document.querySelector('[aria-label="代理使用量"]') !== null`,
      '代理用量列表'
    )
    assert.equal(
      await evaluate(
        client,
        `document.querySelectorAll('.usage-profiler-agent-metric').length >= 12`
      ),
      true
    )
    await clickExactText(client, '事件')
    await waitFor(
      client,
      `document.body.innerText.includes('运行完整使用量验证') && document.querySelector('[aria-label="会话活动列表"]') !== null`,
      '活动回顾列表'
    )
    screenshots.set(finalOutputs.desktopActivity, await screenshot(client))
    await clickExactText(client, '趋势')

    await setViewport(client, 390, 844, true)
    if (
      !(await evaluate(client, `document.querySelector('[data-usage-session-analysis]') !== null`))
    ) {
      await clickAriaLabel(client, '更多操作')
      await waitFor(client, `document.body.innerText.includes('会话分析')`, '移动端会话分析菜单')
      await clickText(client, '会话分析')
    }
    await waitFor(
      client,
      `document.querySelector('[data-usage-session-analysis]')?.getBoundingClientRect().width <= 390 && document.querySelector('[aria-label="Token/分趋势"]') !== null`,
      '移动端时间轴适配'
    )
    const touchSelected = await evaluate(
      client,
      `(() => { const chart=document.querySelector('[aria-label="Token/分趋势"]'); if (!chart) return false; const rect=chart.getBoundingClientRect(); chart.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:rect.left+rect.width*.62,clientY:rect.top+rect.height/2,pointerId:2,pointerType:'touch'})); return true })()`
    )
    assert.equal(touchSelected, true)
    await waitFor(
      client,
      `document.body.innerText.includes('选中时间段') && document.querySelector('[data-usage-selected="true"]') !== null`,
      '移动端触摸选择时间段'
    )
    assert.equal(
      await evaluate(
        client,
        `(() => { const detail=document.querySelector('[data-usage-selected="true"]'); if (!detail) return false; const rect=detail.getBoundingClientRect(); return rect.top < window.innerHeight && rect.bottom > 0; })()`
      ),
      true
    )
    screenshots.set(finalOutputs.mobileTimeline, await screenshot(client))
    await clickExactText(client, '代理')
    await waitFor(
      client,
      `document.querySelector('[aria-label="代理使用量"]') !== null`,
      '移动端代理列表'
    )
    assert.equal(
      await evaluate(
        client,
        `(() => { const metrics=[...document.querySelectorAll('.usage-profiler-agent-metric')]; return metrics.length >= 12 && metrics.every((element) => getComputedStyle(element).display !== 'none'); })()`
      ),
      true
    )

    await publishScreenshots(screenshots)
  } catch (error) {
    failure = error
  } finally {
    const cleanupErrors = []
    try {
      client?.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await stopBrowser()
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      if (serverRuntime) await stopE2eServerTree(serverRuntime)
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      if (appPort > 0) await assertPortReleased(appPort)
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await rm(testRoot, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
    const errors = [...(failure ? [failure] : []), ...cleanupErrors]
    if (errors.length > 0) throw new AggregateError(errors, '用量视觉验收失败')
  }
}

await main()
