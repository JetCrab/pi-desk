import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import {
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const testRoot = join(projectRoot, 'temp', 'pi', 'app-notifications-visual', String(process.pid))
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, 'project')
const pluginDir = join(testRoot, 'notification-plugin')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const temporaryDesktopCollapsed = join(testRoot, 'desktop-collapsed.png')
const temporaryDesktopExpanded = join(testRoot, 'desktop-expanded.png')
const temporaryMobileCollapsed = join(testRoot, 'mobile-collapsed.png')
const temporaryMobileExpanded = join(testRoot, 'mobile-expanded.png')
const desktopCollapsedOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '全局通知__默认单行.png'
)
const desktopExpandedOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '全局通知__悬停展开.png'
)
const mobileCollapsedOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '全局通知__默认单行.png'
)
const mobileExpandedOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '全局通知__三点展开.png'
)
const password = 'Qq.445566'
const workId = 'app-notification-visual'

let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''

function closeTo(actual, expected, tolerance = 1) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `尺寸不符合预期：actual=${actual}, expected=${expected}`
  )
}

async function createFixture() {
  await prepareIsolatedPiDirectory(agentDir)
  await mkdir(dirname(workSessionStorePath), { recursive: true })
  await mkdir(projectDir, { recursive: true })
  await mkdir(join(pluginDir, 'browser'), { recursive: true })

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  const timestamp = Date.now()
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '全局通知视觉验收' }],
    timestamp
  })
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '准备展示全局通知。' }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: timestamp + 1
  })
  manager.appendSessionInfo('全局通知视觉验收')

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
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ packages: [pluginDir] }),
    'utf8'
  )
  await writeFile(
    join(pluginDir, 'package.json'),
    JSON.stringify({
      name: 'app-notification-visual-fixture',
      type: 'module',
      piDesk: { entry: './entry.mjs' }
    }),
    'utf8'
  )
  await writeFile(
    join(pluginDir, 'entry.mjs'),
    `export default {
  name: 'notification-fixture',
  setup(plugin) {
    plugin.setState({ status: 'ready' })
    plugin.registerBrowserEntry('./browser/entry.js')
    const notifications = [
      { level: 'info', title: '插件依赖已经重新加载', description: '12 分钟前' },
      { level: 'success', title: '桌面端验收截图已登记', description: '8 分钟前' },
      { level: 'info', title: '有 3 个后台任务仍在运行', description: '5 分钟前' },
      { level: 'warning', title: '发布需要一次确认', description: '2 分钟前' },
      {
        level: 'success',
        title: '最新构建完成，可以查看交付物',
        description: '刚刚',
        event: { name: 'open-result', data: { runId: 'run-latest' } }
      }
    ]
    for (const notification of notifications) plugin.notifications.publish(notification)
  }
}
`,
    'utf8'
  )
  await writeFile(
    join(pluginDir, 'browser', 'entry.js'),
    `export default function entry(plugin) {
  plugin.notifications.onEvent('open-result', ({ data }) => {
    plugin.notify({ level: 'success', title: '通知事件已执行', description: String(data.runId) })
  })
}
`,
    'utf8'
  )
}

async function waitForAnimations(client, label) {
  await waitFor(
    client,
    `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
    label,
    () => serverOutput
  )
}

async function readLayout(client) {
  return evaluate(
    client,
    `(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return null;
        const value = element.getBoundingClientRect();
        return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
      };
      const panel = document.querySelector('[data-testid="app-notification-panel"]');
      const notificationCards = [...document.querySelectorAll('[data-testid^="app-notification-"]')]
        .filter((element) => element.getAttribute('data-testid') !== 'app-notification-slot' && element.getAttribute('data-testid') !== 'app-notification-panel' && element.getAttribute('data-testid') !== 'app-notification-more');
      return {
        sidebar: rect('aside'),
        sessionList: rect('[data-testid="work-session-list"]'),
        slot: rect('[data-testid="app-notification-slot"]'),
        panel: rect('[data-testid="app-notification-panel"]'),
        latest: rect('[data-latest="true"]'),
        shortcuts: rect('[data-testid="sidebar-shortcuts"]'),
        expanded: panel?.getAttribute('data-expanded') === 'true',
        panelBorderTop: panel instanceof HTMLElement ? getComputedStyle(panel).borderTopWidth : null,
        panelBorderLeft: panel instanceof HTMLElement ? getComputedStyle(panel).borderLeftWidth : null,
        titles: notificationCards.map((element) => element.textContent?.trim() ?? ''),
        latestTitle: document.querySelector('[data-latest="true"]')?.textContent?.trim() ?? '',
        moreButton: document.querySelector('[data-testid="app-notification-more"]') !== null
      };
    })()`
  )
}

function assertFixedLayout(before, after) {
  closeTo(after.sessionList.top, before.sessionList.top)
  closeTo(after.sessionList.bottom, before.sessionList.bottom)
  closeTo(after.sessionList.height, before.sessionList.height)
  closeTo(after.slot.top, before.slot.top)
  closeTo(after.slot.bottom, before.slot.bottom)
  closeTo(after.slot.height, 48)
  closeTo(after.latest.top, before.latest.top)
  closeTo(after.latest.bottom, before.latest.bottom)
  closeTo(after.shortcuts.top, before.shortcuts.top)
  closeTo(after.shortcuts.height, before.shortcuts.height)
  closeTo(after.panel.bottom, before.panel.bottom)
}

async function moveMouse(client, rect, ratio = 0.5) {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height * ratio,
    button: 'none',
    pointerType: 'mouse'
  })
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
    await setViewport(client, 1440, 900, false)
    await navigate(client, `http://127.0.0.1:${appPort}/login`)
    const login = await evaluate(
      client,
      `fetch('/api/auth/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '5a5d88a2-09c2-4df5-971b-79e5bc991a21' },
        body: JSON.stringify({ password: ${JSON.stringify(password)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(login.ok, true, login.body?.msg)

    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitFor(
      client,
      `document.querySelector('[data-testid="app-notification-panel"]') !== null && document.querySelector('[data-latest="true"]')?.textContent.includes('最新构建完成')`,
      '桌面通知默认态',
      () => serverOutput,
      30_000
    )
    await waitForAnimations(client, '桌面通知出现动画')
    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach((element) => { element.style.display = 'none' })`
    )

    const desktopCollapsed = await readLayout(client)
    assert.equal(desktopCollapsed.expanded, false)
    closeTo(desktopCollapsed.slot.height, 48)
    closeTo(desktopCollapsed.panel.height, 48)
    closeTo(desktopCollapsed.panel.left, desktopCollapsed.sidebar.left)
    closeTo(desktopCollapsed.panel.right, desktopCollapsed.sidebar.right)
    assert.equal(desktopCollapsed.panelBorderTop, '1px')
    assert.equal(desktopCollapsed.panelBorderLeft, '0px')
    assert.match(desktopCollapsed.latestTitle, /最新构建完成/)
    await writeFile(temporaryDesktopCollapsed, await screenshot(client))

    await moveMouse(client, desktopCollapsed.latest)
    await waitFor(
      client,
      `document.querySelector('[data-testid="app-notification-panel"]')?.getAttribute('data-expanded') === 'true'`,
      '桌面 Hover 展开通知'
    )
    await waitForAnimations(client, '桌面通知展开动画')
    const desktopExpanded = await readLayout(client)
    assertFixedLayout(desktopCollapsed, desktopExpanded)
    assert.equal(desktopExpanded.expanded, true)
    assert.ok(desktopExpanded.panel.height > desktopCollapsed.panel.height)
    assert.ok(desktopExpanded.panel.top < desktopCollapsed.panel.top)
    assert.match(desktopExpanded.titles[0], /插件依赖已经重新加载/)
    assert.match(desktopExpanded.titles.at(-1), /最新构建完成/)

    await moveMouse(client, desktopExpanded.panel, 0.2)
    await waitFor(
      client,
      `(() => {
        const panel = document.querySelector('[data-testid="app-notification-panel"]');
        const rect = panel?.getBoundingClientRect();
        const target = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height * 0.2) : null;
        return panel?.getAttribute('data-expanded') === 'true' && target !== null && panel.contains(target);
      })()`,
      '鼠标进入上拉通知区后保持展开'
    )
    await writeFile(temporaryDesktopExpanded, await screenshot(client))

    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 900,
      y: 20,
      button: 'none',
      pointerType: 'mouse'
    })
    await waitFor(
      client,
      `document.querySelector('[data-testid="app-notification-panel"]')?.getAttribute('data-expanded') === 'false'`,
      '桌面通知移出收起'
    )

    await setViewport(client, 390, 844, true)
    await waitFor(
      client,
      `document.documentElement.clientWidth === 390 && document.querySelector('[aria-label="显示工作会话菜单"]') !== null`,
      '移动工作台布局'
    )
    await evaluate(client, `document.querySelector('[aria-label="显示工作会话菜单"]')?.click()`)
    await waitFor(
      client,
      `(() => {
        const drawer = document.querySelector('[aria-label="关闭工作会话菜单"]')?.nextElementSibling;
        const panel = drawer?.querySelector('[data-testid="app-notification-panel"]');
        return drawer instanceof HTMLElement && panel instanceof HTMLElement && drawer.getBoundingClientRect().left >= -1;
      })()`,
      '移动通知抽屉'
    )
    await waitForAnimations(client, '移动抽屉动画')

    const mobileCollapsed = await readLayout(client)
    assert.equal(mobileCollapsed.expanded, false)
    assert.equal(mobileCollapsed.moreButton, true)
    closeTo(mobileCollapsed.slot.height, 48)
    closeTo(mobileCollapsed.panel.height, 48)
    await writeFile(temporaryMobileCollapsed, await screenshot(client))

    await evaluate(
      client,
      `document.querySelector('[data-testid="app-notification-more"]')?.click()`
    )
    await waitFor(
      client,
      `document.querySelector('[data-testid="app-notification-panel"]')?.getAttribute('data-expanded') === 'true'`,
      '手机三点展开通知'
    )
    await waitForAnimations(client, '手机通知展开动画')
    const mobileExpanded = await readLayout(client)
    assertFixedLayout(mobileCollapsed, mobileExpanded)
    assert.equal(mobileExpanded.expanded, true)
    assert.ok(mobileExpanded.panel.top < mobileCollapsed.panel.top)
    assert.match(mobileExpanded.titles.at(-1), /最新构建完成/)
    await writeFile(temporaryMobileExpanded, await screenshot(client))

    const consumed = await evaluate(
      client,
      `(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label')?.includes('最新构建完成') && item.getAttribute('aria-label')?.includes('点击处理'));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`
    )
    assert.equal(consumed, true)
    await waitFor(
      client,
      `document.body.innerText.includes('通知事件已执行') && !document.querySelector('[data-latest="true"]')?.textContent.includes('最新构建完成')`,
      '通知 Event 消费并删除',
      () => serverOutput
    )

    await publishScreenshots([
      [desktopCollapsedOutput, await readFile(temporaryDesktopCollapsed)],
      [desktopExpandedOutput, await readFile(temporaryDesktopExpanded)],
      [mobileCollapsedOutput, await readFile(temporaryMobileCollapsed)],
      [mobileExpandedOutput, await readFile(temporaryMobileExpanded)]
    ])
    console.log(
      JSON.stringify(
        {
          screenshots: [
            desktopCollapsedOutput,
            desktopExpandedOutput,
            mobileCollapsedOutput,
            mobileExpandedOutput
          ]
        },
        null,
        2
      )
    )
  } finally {
    client?.close()
    await stopBrowserTree(browserProcess, cdpPort)
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
