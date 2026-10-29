import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clickAriaLabel,
  createCdpPage,
  evaluate,
  navigate,
  reservePort,
  screenshot,
  setViewport,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForBrowserReady,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'
import {
  assertPortReleased,
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const taskId = `context-mcp-${process.pid}`
const runRoot = join(projectRoot, 'temp/run/workbench-context', taskId)
const piRoot = join(projectRoot, 'temp/pi/workbench-model-context-e2e', taskId)
const agentDir = join(piRoot, 'agent')
const buildRoot = join(projectRoot, 'temp/build/workbench-context', taskId)
const projectDir = join(runRoot, 'project')
const workId = 'context-mcp-work'
const password = 'Qq.445566'
let appPort = 0
let cdpPort = 0
let modelPort = 0
let serverRuntime
let browserProcess
let modelServer
let client
let serverOutput = ''
let releaseModel = () => undefined
let passed = false
let modelRequests = 0

async function fixture() {
  await Promise.all([
    prepareIsolatedPiDirectory(agentDir),
    mkdir(projectDir, { recursive: true }),
    mkdir(join(agentDir, 'extensions'), { recursive: true }),
    mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  ])
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '上下文与 MCP 交互验收' }],
    timestamp: Date.now()
  })
  await Promise.all([
    writeFile(
      join(agentDir, 'pi-desk', 'work-sessions.json'),
      JSON.stringify({
        workSessions: [{ workId, cwd: projectDir, sessionId: manager.getSessionId() }],
        pinnedCount: 0
      })
    ),
    writeFile(
      join(agentDir, 'pi-desk-settings.json'),
      JSON.stringify({ region: { locale: 'zh-CN', timeZone: 'UTC' } })
    ),
    writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'context-fixture',
        defaultModel: 'test',
        defaultThinkingLevel: 'off',
        defaultProjectTrust: 'yes',
        retry: { enabled: false },
        compaction: { enabled: false }
      })
    ),
    writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'context-fixture': {
            baseUrl: `http://127.0.0.1:${modelPort}/v1`,
            api: 'openai-completions',
            apiKey: 'fixture-only',
            models: [
              {
                id: 'test',
                name: '交互验收模型',
                reasoning: false,
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
              }
            ]
          }
        }
      })
    ),
    writeFile(
      join(agentDir, 'SYSTEM.md'),
      `# 当前系统提示词

系统提示词验收标记。

## 工作目标

读取项目资料，回答当前问题，并说明已验证的结果。
涉及代码变更时，只修改与任务直接相关的文件。

## 工具使用

- 读取文件前确认目标路径。
- 执行命令前说明目的。
- 文件搜索优先限定目录和类型。
- 操作结束后检查实际结果。

## 会话上下文

系统提示词描述会话的工作约定。
工具页展示当前会话登记的工具定义。
会话 MCP 提供原生状态查询和连接操作。

## 交互约定

需要用户选择时，等待用户回答。
用户取消操作后，结束对应的等待。
保持错误原因和恢复操作清楚可见。

## 验收环境

本会话使用独立的演示配置与模拟模型。
MCP 通知和授权链接由测试扩展产生。
不连接真实服务，不使用真实登录凭据。
`
    ),
    writeFile(
      join(agentDir, 'extensions', 'mcp-fixture.ts'),
      `export default function (pi) {
      let status = 0
      let login = 0
      pi.registerCommand('mcp', { handler: async (args, ctx) => {
        if (!args) {
          status += 1
          ctx.ui.notify('状态查询 #' + status + '\\n文档服务: connected, 3 tools\\n代码服务: needs sign-in', 'info')
          return
        }
        if (args === 'login' && ++login === 1) {
          ctx.ui.notify('登录测试：没有可登录服务', 'error')
          return
        }
        const name = await ctx.ui.select('选择 MCP 服务', ['文档服务', '代码服务'])
        if (!name) { ctx.ui.notify('已取消 MCP 操作', 'info'); return }
        if (args === 'login') {
          ctx.ui.notify('请打开授权链接：https://example.com/authorize', 'info')
          const url = await ctx.ui.input('粘贴授权回调地址', 'http://127.0.0.1/callback?code=...')
          ctx.ui.notify(url ? '登录交互完成：' + name : '已取消登录', 'info')
        } else ctx.ui.notify('重连完成：' + name, 'info')
      } })
    }`
    )
  ])
}

async function startModel() {
  const held = new Promise((resolveHeld) => {
    releaseModel = resolveHeld
  })
  modelServer = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 排空请求体。 */
    }
    modelRequests += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const event = (content, finish = null) =>
      response.write(
        `data: ${JSON.stringify({ id: 'context-test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`
      )
    event('Agent 正在运行，等待上下文读取验收。')
    await held
    event('运行结束。', 'stop')
    response.end('data: [DONE]\n\n')
  })
  modelServer.listen(modelPort, '127.0.0.1')
  await once(modelServer, 'listening')
}

async function wait(expression, label) {
  await waitFor(client, expression, label, () => serverOutput.slice(-12000), 60000)
}
async function click(text, scope = '[role="dialog"]') {
  const expression = `(() => { const buttons = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})]; const button = buttons.find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) return false; button.click(); return true })()`
  assert.equal(await evaluate(client, expression), true, `可点击：${text}`)
}
async function openContext() {
  await clickAriaLabel(client, '更多操作')
  await wait(
    `document.querySelector('[role="menu"] [aria-label="工具与上下文"]')?.getAttribute('data-disabled') === null`,
    '上下文入口可用'
  )
  await clickAriaLabel(client, '工具与上下文')
  await wait(
    `document.querySelector('[role="dialog"]')?.textContent.includes('系统提示词验收标记')`,
    '系统提示词加载'
  )
  const tabs = await evaluate(
    client,
    `[...document.querySelectorAll('[role="dialog"] [role="radio"]')].map(e => ({text:e.textContent.trim(), selected:e.getAttribute('aria-checked')}))`
  )
  assert.deepEqual(tabs, [
    { text: '系统提示词', selected: 'true' },
    { text: '工具', selected: 'false' },
    { text: '会话 MCP', selected: 'false' }
  ])
}
async function closeContext() {
  await clickAriaLabel(client, '关闭弹窗')
  await wait(`!document.querySelector('[role="dialog"]')`, '弹窗关闭')
}
async function mcpReady(marker) {
  await wait(
    `(() => {const d=document.querySelector('[role="dialog"]');return d?.textContent.includes(${JSON.stringify(marker)}) && [...d.querySelectorAll('button')].some(e=>e.textContent.trim()==='刷新状态' && !e.disabled)})()`,
    marker
  )
}
async function question(title) {
  await wait(
    `document.querySelector('[data-testid="native-ui-question"]')?.textContent.includes(${JSON.stringify(title)}) && !document.querySelector('[role="dialog"]')`,
    title
  )
}
async function chooseServer() {
  await question('选择 MCP 服务')
  await click('代码服务', '[data-testid="native-ui-question"]')
  await wait(
    `(() => {const q=document.querySelector('[data-testid="native-ui-question"]');return [...(q?.querySelectorAll('button') ?? [])].some(e=>e.textContent.trim()==='提交' && !e.disabled)})()`,
    '服务选择可提交'
  )
  await click('提交', '[data-testid="native-ui-question"]')
}
async function capture(name) {
  await evaluate(client, 'window.__piDeskHideNextDevIndicator?.()')
  const metrics = await evaluate(
    client,
    `(() => { const d=document.querySelector('[role="dialog"]'); const r=d.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:innerWidth, height:innerHeight, scroll:d.scrollWidth, client:d.clientWidth } })()`
  )
  assert.ok(
    metrics.left >= -1 &&
      metrics.right <= metrics.width + 1 &&
      metrics.top >= -1 &&
      metrics.bottom <= metrics.height + 1,
    JSON.stringify(metrics)
  )
  assert.ok(metrics.scroll <= metrics.client + 1, JSON.stringify(metrics))
  await writeFile(join(runRoot, name + '.png'), await screenshot(client))
}
async function setTheme(theme) {
  await evaluate(
    client,
    `localStorage.setItem('pi-super-theme', ${JSON.stringify(theme)}); window.dispatchEvent(new StorageEvent('storage', {key:'pi-super-theme',newValue:${JSON.stringify(theme)}})); true`
  )
  await wait(
    `document.documentElement.classList.contains('dark') === ${theme === 'dark'}`,
    '主题切换'
  )
}

try {
  modelPort = await reservePort()
  await startModel()
  await fixture()
  appPort = await reservePort()
  cdpPort = await reservePort()
  serverRuntime = spawnE2eServer({
    projectRoot,
    agentDir,
    port: appPort,
    development: true,
    nextDirectory: join(buildRoot, '.next'),
    onOutput: (output) => {
      serverOutput = (serverOutput + output).slice(-200000)
    }
  })
  await waitForHttp(`http://127.0.0.1:${appPort}/api/health`, 60000, 'Pi Desk', () => serverOutput)
  browserProcess = spawnEdge(
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    cdpPort,
    join(runRoot, 'browser')
  )
  await waitForBrowserReady(browserProcess, cdpPort)
  client = await createCdpPage(cdpPort)
  await setViewport(client, 1440, 900, false)
  await navigate(client, `http://127.0.0.1:${appPort}/login`)
  const login = await evaluate(
    client,
    `fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':crypto.randomUUID()},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.json())`
  )
  assert.equal(login.code, 0, login.msg)
  await evaluate(client, `localStorage.setItem('pi-super-theme','light')`)
  await navigate(client, `http://127.0.0.1:${appPort}/`)
  await wait(
    `document.querySelector('[data-testid="work-session-row-${workId}"]') !== null`,
    '会话列表加载'
  )
  await evaluate(
    client,
    `document.querySelector('[data-testid="work-session-row-${workId}"]').click()`
  )
  await wait(`document.querySelector('[data-work-id="${workId}"] textarea') !== null`, '会话加载')
  await openContext()
  await capture('system-desktop-light')
  await click('工具')
  await wait(
    `document.querySelector('[role="dialog"]')?.textContent.includes('read')`,
    '工具列表加载'
  )
  await click('会话 MCP')
  await mcpReady('状态查询 #1')
  await capture('mcp-desktop-light')
  await click('刷新状态')
  await mcpReady('状态查询 #2')
  assert.match(
    await evaluate(
      client,
      `document.querySelector('[role="dialog"] section[aria-label="会话通知"] p')?.textContent`
    ),
    /状态查询 #2/
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelector('[role="dialog"]').textContent.includes('状态查询 #3')`
    ),
    false
  )
  await click('登录')
  await mcpReady('登录测试：没有可登录服务')
  await click('登录')
  await chooseServer()
  await question('粘贴授权回调地址')
  await wait(
    `(() => {const a=document.querySelector('[data-testid="native-ui-output"] a[href="https://example.com/authorize"]'); return a && a.getBoundingClientRect().height > 0})()`,
    '授权链接展开可见'
  )
  await click('取消', '[data-testid="native-ui-question"]')
  await wait(`!document.querySelector('[data-testid="native-ui-question"]')`, '取消登录结束等待')
  await openContext()
  await click('会话 MCP')
  await mcpReady('已取消登录')
  await click('重连')
  await chooseServer()
  await wait(`!document.querySelector('[data-testid="native-ui-question"]')`, '重连选择完成')
  await openContext()
  await click('会话 MCP')
  await mcpReady('重连完成：代码服务')
  console.log('MCP 自动查询、刷新、登录失败保留、服务选择及授权取消通过')
  await closeContext()
  await evaluate(client, `document.querySelector('[data-work-id="${workId}"] textarea').focus()`)
  await client.send('Input.insertText', { text: '开始运行中读取验收' })
  await wait(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`, '消息可发送')
  await clickAriaLabel(client, '发送消息')
  await wait(
    `document.body.innerText.includes('Agent 正在运行，等待上下文读取验收。') && document.querySelector('[aria-label="停止当前响应"]') !== null`,
    'Agent 运行中'
  )
  await openContext()
  await capture('system-running')
  assert.equal(modelRequests, 1, '只读查看不额外调用模型')
  await click('会话 MCP')
  await mcpReady('状态查询 #')
  assert.deepEqual(
    await evaluate(
      client,
      `[...document.querySelectorAll('[role="dialog"] button')].filter(e=>['登录','重连','退出登录','刷新状态'].includes(e.textContent.trim())).map(e=>({name:e.textContent.trim(),disabled:e.disabled}))`
    ),
    [
      { name: '刷新状态', disabled: false },
      { name: '登录', disabled: true },
      { name: '重连', disabled: true },
      { name: '退出登录', disabled: true }
    ]
  )
  for (const [name, width, height, mobile, theme] of [
    ['mcp-desktop-dark', 1440, 900, false, 'dark'],
    ['mcp-mobile-light', 390, 844, true, 'light'],
    ['mcp-mobile-dark', 390, 844, true, 'dark']
  ]) {
    await closeContext()
    await setViewport(client, width, height, mobile)
    await setTheme(theme)
    await openContext()
    await click('会话 MCP')
    await mcpReady('状态查询 #')
    await capture(name)
  }
  releaseModel()
  await wait(`!document.querySelector('[aria-label="停止当前响应"]')`, 'Agent 结束')
  passed = true
  await writeFile(
    join(runRoot, 'result.json'),
    JSON.stringify(
      {
        passed,
        modelRequests,
        checks: ['E01', 'E02', 'E03', 'E04-布局自动检查'],
        fixture: '模拟 MCP 命令与模型；真实宿主、HTTP、WebSocket、浏览器交互'
      },
      null,
      2
    )
  )
  console.log(`浏览器定向验收通过；截图待视觉检查：${runRoot}`)
} catch (error) {
  await mkdir(runRoot, { recursive: true })
  await writeFile(join(runRoot, 'failure.txt'), String(error.stack ?? error))
  if (client) {
    await Promise.race([
      screenshot(client).then((image) => writeFile(join(runRoot, 'failure.png'), image)),
      new Promise((resolveTimeout) => {
        const timer = setTimeout(resolveTimeout, 5000)
        timer.unref()
      })
    ]).catch(() => undefined)
  }
  throw error
} finally {
  releaseModel()
  client?.close()
  if (browserProcess) await stopBrowserTree(browserProcess, cdpPort)
  if (serverRuntime) await stopE2eServerTree(serverRuntime)
  if (modelServer) {
    modelServer.closeAllConnections()
    await new Promise((resolveClose) => modelServer.close(resolveClose))
    await assertPortReleased(modelPort)
  }
  await writeFile(join(runRoot, 'server.log'), serverOutput)
  if (passed) {
    await Promise.all([
      rm(piRoot, { recursive: true, force: true }),
      rm(buildRoot, { recursive: true, force: true }),
      rm(join(runRoot, 'browser'), { recursive: true, force: true }),
      rm(projectDir, { recursive: true, force: true })
    ])
  }
}
