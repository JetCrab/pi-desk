import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clickAriaLabel,
  clickText,
  createCdpPage,
  evaluate,
  navigate,
  publishScreenshots,
  reservePort,
  screenshot,
  setViewport,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'
import {
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const testRoot = join(projectRoot, 'temp', 'pi', 'workbench-model-context-e2e', String(process.pid))
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, '模型上下文验收项目')
const extensionDir = join(agentDir, 'extensions', 'context-view-fixture')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const resultPath = join(testRoot, 'result.json')
const desktopCapturePath = join(testRoot, 'desktop.png')
const mobileCapturePath = join(testRoot, 'mobile.png')
const desktopOutput = join(projectRoot, 'temp', '验收', '客户端_桌面', '系统上下文__查看.png')
const mobileOutput = join(projectRoot, 'temp', '验收', '客户端_移动端', '系统上下文__查看.png')
const workId = 'model-context-work'
const password = 'Qq.445566'
const usage = {
  input: 10,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''

async function createFixture() {
  await prepareIsolatedPiDirectory(agentDir)
  await Promise.all([
    mkdir(projectDir, { recursive: true }),
    mkdir(extensionDir, { recursive: true }),
    mkdir(dirname(workSessionStorePath), { recursive: true }),
    rm(desktopOutput, { force: true }),
    rm(mobileOutput, { force: true })
  ])
  await writeFile(
    join(agentDir, 'SYSTEM.md'),
    '系统提示词验收标记\n\n仅用于查看当前模型上下文。\n',
    'utf8'
  )
  await writeFile(
    join(extensionDir, 'index.ts'),
    `export default function contextViewFixture(pi) {
  pi.on('context', async (event) => ({
    messages: [
      ...event.messages,
      {
        role: 'user',
        content: [{ type: 'text', text: '上下文钩子验收标记' }],
        timestamp: Date.parse('2026-01-01T00:00:05.000Z')
      }
    ]
  }))
}
`,
    'utf8'
  )

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  const timestamp = Date.now()
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '历史用户消息验收标记' }],
    timestamp
  })
  manager.appendMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: '历史助手消息验收标记' },
      {
        type: 'toolCall',
        id: 'context-read-call',
        name: 'read',
        arguments: { path: 'README.md', reasoning: '验证上下文工具定义' }
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
    toolCallId: 'context-read-call',
    toolName: 'read',
    content: [{ type: 'text', text: '工具结果验收标记' }],
    usage,
    isError: false,
    timestamp: timestamp + 2
  })
  manager.appendSessionInfo('系统上下文验收会话')

  const sessionFile = manager.getSessionFile()
  assert.ok(sessionFile)
  await writeFile(
    workSessionStorePath,
    `${JSON.stringify(
      {
        workSessions: [{ workId, cwd: projectDir, sessionId: manager.getSessionId() }],
        pinnedCount: 0
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

async function login(client) {
  await navigate(client, `http://127.0.0.1:${appPort}/login`)
  const result = await evaluate(
    client,
    `fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': crypto.randomUUID() },
      body: JSON.stringify({ password: ${JSON.stringify(password)} })
    }).then(async response => ({ ok: response.ok, body: await response.json() }))`
  )
  assert.equal(result.ok, true, result.body?.msg)
  await evaluate(
    client,
    `localStorage.setItem('pi-desk:workbench-layout', JSON.stringify({ primaryWorkId: ${JSON.stringify(workId)} }))`
  )
}

async function prepareVisualCapture(client) {
  await evaluate(
    client,
    `document.querySelectorAll('nextjs-portal').forEach((element) => { element.style.display = 'none' })`
  )
  await evaluate(
    client,
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
  )
}

async function openModelContext(client) {
  await clickAriaLabel(client, '更多操作')
  await waitFor(
    client,
    `(() => {
      const item = document.querySelector('[role="menu"] [aria-label="查看系统上下文"]');
      return item instanceof HTMLElement && item.getAttribute('data-disabled') === null;
    })()`,
    '更多菜单中的系统上下文入口可用',
    () => serverOutput,
    60_000
  )
  await clickText(client, '查看系统上下文')
  await waitFor(
    client,
    `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const text = dialog?.textContent ?? '';
      return dialog !== null && text.includes('系统上下文') && text.includes('系统提示词验收标记') && text.includes('上下文钩子验收标记') && text.includes('历史用户消息验收标记') && text.includes('read');
    })()`,
    '系统上下文内容加载',
    () => serverOutput,
    60_000
  )
  await waitFor(
    client,
    `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog instanceof HTMLElement && [...dialog.getAnimations()].every((animation) => animation.playState === 'finished');
    })()`,
    '系统上下文弹窗动画完成'
  )
}

async function dialogMetrics(client) {
  return evaluate(
    client,
    `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const body = dialog?.querySelector('[data-slot="app-dialog-body-viewport"]');
      if (!(dialog instanceof HTMLElement) || !(body instanceof HTMLElement)) return null;
      const rect = dialog.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight
      };
    })()`
  )
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
    await waitForHttp(
      `http://127.0.0.1:${appPort}/api/health`,
      30_000,
      'Pi Desk',
      () => serverOutput
    )

    browserProcess = spawnEdge(edgePath, cdpPort, join(testRoot, 'edge-profile'), '1440,900')
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge CDP')
    client = await createCdpPage(cdpPort)
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    await setViewport(client, 1440, 900, false)
    await login(client)
    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitFor(
      client,
      `document.querySelector('[data-work-id=${JSON.stringify(workId)}] textarea') !== null`,
      '模型上下文验收会话加载',
      () => serverOutput,
      60_000
    )

    await openModelContext(client)
    const desktopMetrics = await dialogMetrics(client)
    assert.ok(desktopMetrics)
    assert.ok(desktopMetrics.width >= 1_000, JSON.stringify(desktopMetrics))
    assert.ok(
      desktopMetrics.bodyScrollHeight > desktopMetrics.bodyClientHeight,
      JSON.stringify(desktopMetrics)
    )
    await prepareVisualCapture(client)
    const desktopCapture = await screenshot(client)

    await clickAriaLabel(client, '关闭弹窗')
    await waitFor(
      client,
      `document.querySelector('[role="dialog"]') === null`,
      '桌面系统上下文弹窗关闭'
    )
    await setViewport(client, 390, 844, true)
    await openModelContext(client)
    const mobileMetrics = await dialogMetrics(client)
    assert.ok(mobileMetrics)
    assert.ok(mobileMetrics.width <= mobileMetrics.viewportWidth + 1, JSON.stringify(mobileMetrics))
    assert.ok(
      mobileMetrics.height >= mobileMetrics.viewportHeight - 2,
      JSON.stringify(mobileMetrics)
    )
    assert.ok(
      mobileMetrics.bodyScrollHeight > mobileMetrics.bodyClientHeight,
      JSON.stringify(mobileMetrics)
    )
    await prepareVisualCapture(client)
    const mobileCapture = await screenshot(client)

    await publishScreenshots([
      [desktopOutput, desktopCapture],
      [mobileOutput, mobileCapture]
    ])
    await mkdir(dirname(resultPath), { recursive: true })
    await writeFile(
      resultPath,
      `${JSON.stringify({ desktopMetrics, mobileMetrics }, null, 2)}\n`,
      'utf8'
    )
    await writeFile(desktopCapturePath, desktopCapture)
    await writeFile(mobileCapturePath, mobileCapture)
    console.log(JSON.stringify({ desktopMetrics, mobileMetrics }, null, 2))
    console.log(`desktop=${desktopOutput}`)
    console.log(`mobile=${mobileOutput}`)
  } finally {
    client?.close()
    await stopBrowserTree(browserProcess, cdpPort)
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
