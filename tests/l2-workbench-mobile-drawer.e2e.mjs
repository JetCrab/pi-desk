import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
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
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const testRoot = join(projectRoot, 'temp', 'pi', 'workbench-mobile-drawer-e2e', String(process.pid))
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, '长会话项目')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const resultPath = join(projectRoot, 'temp', 'pi', 'workbench-mobile-drawer-e2e', 'result.json')
const screenshotPath = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '工作台__工作会话抽屉.png'
)
const workId = 'mobile-drawer-large-session'
const turnCount = 1_200
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
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(dirname(workSessionStorePath), { recursive: true })
  await mkdir(projectDir, { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  const timestamp = Date.now()

  for (let index = 0; index < turnCount; index += 1) {
    manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: `长会话 ${index} 用户` }],
      timestamp: timestamp + index * 2
    })
    manager.appendMessage({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `长会话 ${index} 回答\n\n${'动态高度内容。'.repeat(1 + (index % 6))}`
        }
      ],
      api: 'openai-responses',
      provider: 'test',
      model: 'test-model',
      usage,
      stopReason: 'stop',
      timestamp: timestamp + index * 2 + 1
    })
  }
  manager.appendSessionInfo('移动抽屉长会话 1200 轮')

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

async function readPerformanceMetrics(client) {
  const result = await client.send('Performance.getMetrics')
  return Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]))
}

async function measureDrawerToggle(client, label, expectedOpen) {
  const before = await readPerformanceMetrics(client)
  const clickMs = await evaluate(
    client,
    `(() => {
      const target = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
      if (!(target instanceof HTMLElement)) return null;
      const startedAt = performance.now();
      target.click();
      return performance.now() - startedAt;
    })()`
  )
  assert.notEqual(clickMs, null, `未找到移动抽屉操作：${label}`)

  await waitFor(
    client,
    expectedOpen
      ? `(() => {
          const backdrop = document.querySelector('[aria-label="关闭工作会话菜单"]');
          const drawer = backdrop?.nextElementSibling;
          if (!(backdrop instanceof HTMLElement) || !(drawer instanceof HTMLElement)) return false;
          const rect = drawer.getBoundingClientRect();
          return backdrop.getAttribute('aria-hidden') !== 'true' && rect.left >= -1 && rect.right > 0;
        })()`
      : `(() => {
          const backdrop = document.querySelector('[aria-label="关闭工作会话菜单"]');
          return backdrop === null || backdrop.getAttribute('aria-hidden') === 'true';
        })()`,
    expectedOpen ? '移动工作会话抽屉打开' : '移动工作会话抽屉关闭'
  )
  await evaluate(
    client,
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
  )

  const after = await readPerformanceMetrics(client)
  const delta = (name, scale = 1) => ((after[name] ?? 0) - (before[name] ?? 0)) * scale
  return {
    clickMs,
    taskDurationMs: delta('TaskDuration', 1_000),
    recalcStyleDurationMs: delta('RecalcStyleDuration', 1_000),
    layoutDurationMs: delta('LayoutDuration', 1_000),
    recalcStyleCount: delta('RecalcStyleCount'),
    layoutCount: delta('LayoutCount'),
    jsEventListenersDelta: delta('JSEventListeners'),
    nodesDelta: delta('Nodes')
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
    await waitForHttp(
      `http://127.0.0.1:${appPort}/api/health`,
      30_000,
      'Pi Desk',
      () => serverOutput
    )

    browserProcess = spawnEdge(edgePath, cdpPort, join(testRoot, 'edge-profile'), '390,844')
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge CDP')
    client = await createCdpPage(cdpPort)
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    await setViewport(client, 390, 844, true)
    await navigate(client, `http://127.0.0.1:${appPort}/login`)
    const login = await evaluate(
      client,
      `fetch('/api/auth/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '6234c5f0-78ef-49e1-bcb9-0920d76c8c26' },
        body: JSON.stringify({ password: ${JSON.stringify(password)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(login.ok, true, login.body?.msg)

    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitFor(
      client,
      `document.querySelector('[data-testid="work-session-row-${workId}"]') !== null`,
      '长会话列表项'
    )
    const selected = await evaluate(
      client,
      `(() => {
        const row = document.querySelector('[data-testid="work-session-row-${workId}"]');
        if (!(row instanceof HTMLElement)) return false;
        row.click();
        return true;
      })()`
    )
    assert.equal(selected, true)
    await waitFor(
      client,
      `document.body.innerText.includes('长会话 1199 用户')`,
      '长会话消息加载',
      () => serverOutput,
      60_000
    )
    await waitFor(
      client,
      `document.querySelector('[aria-label="显示工作会话菜单"]') !== null`,
      '移动工作台布局'
    )
    await evaluate(
      client,
      `new Promise((resolve) => requestIdleCallback(() => requestIdleCallback(resolve)))`
    )
    await client.send('Performance.enable')
    await evaluate(
      client,
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    )

    const before = await evaluate(
      client,
      `(() => {
        const group = document.querySelector('#work-session-columns');
        const backdrop = document.querySelector('[aria-label="关闭工作会话菜单"]');
        return {
          renderedTurns: document.querySelectorAll('[data-chat-turn]').length,
          domElements: document.querySelectorAll('*').length,
          resizeHookPresent: group?.classList.contains('pi-desk-workbench-resize-group') ?? false,
          backdropMounted: backdrop !== null,
          historyLength: window.history.length
        };
      })()`
    )
    assert.ok(before.renderedTurns <= 30, `移动端初始 Turn 过多：${before.renderedTurns}`)

    const open = await measureDrawerToggle(client, '显示工作会话菜单', true)
    const openedHistoryLength = await evaluate(client, 'window.history.length')
    assert.equal(openedHistoryLength, before.historyLength, '打开移动抽屉不应写入浏览器历史')
    await evaluate(
      client,
      `(() => {
        window.__piDeskFirstDrawerBackdrop = document.querySelector('[aria-label="关闭工作会话菜单"]');
        return true;
      })()`
    )
    const escapeResult = await evaluate(
      client,
      `(() => {
        const target = document.activeElement || document.body || document.documentElement;
        if (!target) return null;
        const init = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true };
        const keydown = new KeyboardEvent('keydown', init);
        target.dispatchEvent(keydown);
        const keyup = new KeyboardEvent('keyup', init);
        target.dispatchEvent(keyup);
        return { keydown: keydown.defaultPrevented, keyup: keyup.defaultPrevented };
      })()`
    )
    assert.equal(escapeResult?.keydown, true, '移动抽屉应消费 Android 返回派发的 Escape')
    await waitFor(
      client,
      `document.querySelector('[aria-label="关闭工作会话菜单"]')?.getAttribute('aria-hidden') === 'true'`,
      'Escape 关闭移动工作会话抽屉'
    )
    const reopenAfterEscape = await measureDrawerToggle(client, '显示工作会话菜单', true)
    const close = await measureDrawerToggle(client, '关闭工作会话菜单', false)
    const reopen = await measureDrawerToggle(client, '显示工作会话菜单', true)
    const after = await evaluate(
      client,
      `(() => {
        const group = document.querySelector('#work-session-columns');
        const backdrop = document.querySelector('[aria-label="关闭工作会话菜单"]');
        const drawer = backdrop?.nextElementSibling;
        const rect = drawer instanceof HTMLElement ? drawer.getBoundingClientRect() : null;
        const createButton = drawer?.querySelector('[data-testid="sidebar-create-work-session"]');
        const replaceButton = drawer?.querySelector('[data-testid="sidebar-replace-work-session"]');
        const createRect = createButton instanceof HTMLElement ? createButton.getBoundingClientRect() : null;
        const replaceRect = replaceButton instanceof HTMLElement ? replaceButton.getBoundingClientRect() : null;
        return {
          domElements: document.querySelectorAll('*').length,
          resizeHookPresent: group?.classList.contains('pi-desk-workbench-resize-group') ?? false,
          backdropStable: backdrop !== null && backdrop === window.__piDeskFirstDrawerBackdrop,
          drawerVisible: rect !== null && rect.left >= -1 && rect.right > 0,
          drawerWidth: rect?.width ?? 0,
          viewportWidth: innerWidth,
          createButtonRightGap: rect && createRect ? rect.right - createRect.right : null,
          createButtonLeft: createRect?.left ?? null,
          createButtonTop: createRect?.top ?? null,
          replaceButtonLeft: replaceRect?.left ?? null,
          replaceButtonTop: replaceRect?.top ?? null
        };
      })()`
    )
    assert.equal(before.resizeHookPresent, false, '移动单列不应启用桌面 resize :has 钩子')
    assert.equal(before.backdropMounted, true, '移动抽屉遮罩应保持稳定挂载')
    assert.equal(after.resizeHookPresent, false)
    assert.equal(after.backdropStable, true, '移动抽屉重复开关不应替换遮罩 DOM')
    assert.equal(after.drawerVisible, true)
    assert.ok(after.drawerWidth > 0 && after.drawerWidth < after.viewportWidth)
    assert.notEqual(after.createButtonRightGap, null, '应找到新建工作会话按钮')
    assert.notEqual(after.createButtonLeft, null)
    assert.notEqual(after.createButtonTop, null)
    assert.notEqual(after.replaceButtonLeft, null, '应找到替换工作会话按钮')
    assert.notEqual(after.replaceButtonTop, null)
    assert.ok(
      after.createButtonRightGap >= 7 && after.createButtonRightGap <= 9,
      `新建按钮应贴近抽屉右侧内边距，实际为 ${after.createButtonRightGap}px`
    )
    assert.ok(after.createButtonLeft > after.replaceButtonLeft, '新建按钮应位于替换按钮右侧')
    assert.ok(
      Math.abs(after.createButtonTop - after.replaceButtonTop) < 1,
      '顶部操作按钮应保持同一行'
    )
    assert.equal(after.domElements, before.domElements, '移动抽屉开关不应增删聊天 DOM')
    for (const [label, metrics] of Object.entries({ open, reopenAfterEscape, close, reopen })) {
      assert.ok(metrics.clickMs < 10, `${label} 同步点击处理过慢：${metrics.clickMs}ms`)
      assert.ok(
        metrics.recalcStyleDurationMs < 10,
        `${label} 样式重算过慢：${metrics.recalcStyleDurationMs}ms`
      )
      assert.equal(metrics.layoutCount, 0, `${label} 不应触发布局`)
      assert.equal(metrics.nodesDelta, 0, `${label} 不应产生 DOM 节点增量`)
      assert.ok(
        metrics.jsEventListenersDelta <= 0,
        `${label} 不应增加事件监听器：${metrics.jsEventListenersDelta}`
      )
    }
    assert.ok(close.taskDurationMs < 40, `关闭抽屉主线程任务过慢：${close.taskDurationMs}ms`)
    assert.ok(reopen.taskDurationMs < 40, `再次打开抽屉主线程任务过慢：${reopen.taskDurationMs}ms`)
    const drawerScreenshot = await screenshot(client)

    const output = {
      generatedAt: new Date().toISOString(),
      turns: turnCount,
      messages: turnCount * 2,
      before,
      open,
      escapeResult,
      reopenAfterEscape,
      close,
      reopen,
      after
    }
    await mkdir(dirname(resultPath), { recursive: true })
    await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
    await publishScreenshots([[screenshotPath, drawerScreenshot]])
    console.log(JSON.stringify(output, null, 2))
    console.log(`screenshot=${screenshotPath}`)
  } finally {
    client?.close()
    await stopBrowserTree(browserProcess, cdpPort)
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
