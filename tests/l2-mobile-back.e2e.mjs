import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  clickAriaLabel,
  clickText,
  createCdpPage,
  evaluate,
  navigate,
  reservePort,
  setViewport,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForBrowserReady,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runId = `mobile-back-${Date.now()}-${process.pid}`
const runRoot = join(projectRoot, 'temp/run/mobile-back', runId)
const testRoot = join(projectRoot, 'temp/pi/mobile-back', runId)
const agentDir = join(testRoot, 'agent')
const cwd = join(testRoot, 'project')
const workId = 'mobile-back-session'
const fileSelector = `[data-work-id="${workId}"] [data-testid="file-workspace"]`
const chatSelector = `[data-work-id="${workId}"] footer textarea`
const visible = (selector) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  return Boolean(element && !element.closest('[inert], [aria-hidden="true"]') && element.getBoundingClientRect().width > 0);
})()`
const scenario = process.argv[2]
assert.ok(!scenario || ['files', 'images', 'dialogs', 'terminal', 'navigation'].includes(scenario))
const nativeSource = await readFile(
  join(
    projectRoot,
    'apps/android/app/src/main/java/com/jetcrab/android/web/WebTaskBackDispatcher.java'
  ),
  'utf8'
)
const backScript = nativeSource.match(/ESCAPE_DISPATCH_SCRIPT = """([\s\S]*?)""";/)?.[1]
assert.ok(backScript, '必须使用安卓客户端实际派发的返回脚本')

async function prepareFixture() {
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(runRoot, { recursive: true })
  await writeFile(join(cwd, 'sample.ts'), 'export const message = "手机文件返回测试"\n')
  await writeFile(join(cwd, 'sample.html'), '<html><body><button>预览内容</button></body></html>')
  await sharp({ create: { width: 320, height: 180, channels: 3, background: '#808080' } })
    .png()
    .toFile(join(cwd, 'sample.png'))
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const session = SessionManager.create(cwd)
  session.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '手机返回测试' }],
    timestamp: Date.now()
  })
  session.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '返回后仍然留在这段聊天。' }],
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
    timestamp: Date.now()
  })
  await writeFile(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({
      workSessions: [{ workId, cwd, sessionId: session.getSessionId() }],
      pinnedCount: 0
    })
  )
}

let client
let server
let browser
let cdpPort
let output = ''
let passed = false
const check = (expression, label) => waitFor(client, expression, label, () => output, 30_000)
async function click(selector) {
  await check(
    `${visible(selector)} && (() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    return !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
  })()`,
    `等待操作 ${selector}`
  )
  assert.equal(
    await evaluate(
      client,
      `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click(); return true;
  })()`
    ),
    true
  )
}
async function back(consumed = true) {
  const result = await evaluate(client, backScript)
  assert.equal(
    result.keydown || result.keyup,
    consumed,
    `安卓返回消费错误：${JSON.stringify(result)}`
  )
}
async function blur() {
  await evaluate(client, 'document.activeElement?.blur()')
  assert.equal(await evaluate(client, 'document.activeElement === document.body'), true)
}
async function openSidebar() {
  await clickAriaLabel(client, '显示工作会话菜单')
  await check(
    '[...document.querySelectorAll("[data-testid=mobile-work-session-drawer]")].some(e => e.dataset.open === "true")',
    '侧栏打开'
  )
}
async function openFile(path) {
  await openSidebar()
  await click('[data-testid="sidebar-mode-files"]')
  await click(`[data-testid="project-file-${path}"]`)
  await check(visible(fileSelector), '文件预览可见')
  await check(
    'document.querySelector("[data-testid=mobile-work-session-drawer]")?.dataset.open === "false"',
    '打开文件后侧栏关闭'
  )
}
async function assertChat() {
  await check(visible(chatSelector), '返回到聊天')
}

try {
  await prepareFixture()
  const port = await reservePort()
  cdpPort = await reservePort()
  server = spawnE2eServer({
    projectRoot,
    agentDir,
    port,
    development: true,
    nextDirectory: join(projectRoot, 'temp/build/mobile-back', runId),
    onOutput: (text) => {
      output = (output + text).slice(-200_000)
    }
  })
  await waitForHttp(`http://127.0.0.1:${port}/api/health`, 30_000, 'Pi Desk', () => output)
  browser = spawnEdge(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    cdpPort,
    join(runRoot, 'browser')
  )
  await waitForBrowserReady(browser, cdpPort)
  client = await createCdpPage(cdpPort)
  await setViewport(client, 390, 844, true)
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  await navigate(client, `http://127.0.0.1:${port}/login`)
  const login = await evaluate(
    client,
    `fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '7c52e56f-c34a-4f53-9879-451dd4c35c74' },
    body: JSON.stringify({password: 'Qq.445566'})
  }).then(async r => ({ok:r.ok, body:await r.json()}))`
  )
  assert.equal(login.ok, true, JSON.stringify(login))
  await evaluate(
    client,
    `localStorage.setItem('pi-super:workbench-layout', JSON.stringify({primaryWorkId:${JSON.stringify(workId)}}))`
  )
  await navigate(client, `http://127.0.0.1:${port}/`)
  await assertChat()

  if (!scenario || scenario === 'files') {
    await openFile('sample.ts')
    await check(
      `document.querySelector(${JSON.stringify(fileSelector)})?.textContent.includes('手机文件返回测试')`,
      '代码内容加载'
    )
    await blur()
    await back()
    await assertChat()
    await click('[data-testid="session-files-entry"]')
    await check(visible(fileSelector), '恢复文件预览')
    await openSidebar()
    await back()
    await check(
      'document.querySelector("[data-testid=mobile-work-session-drawer]")?.dataset.open === "false"',
      '返回只关闭侧栏'
    )
    await check(visible(fileSelector), '关闭侧栏保留文件')
    await back()
    await assertChat()
    await openFile('sample.html')
    await check(visible('[role="group"][aria-label="HTML 显示方式"]'), 'HTML模式可切换')
    await clickText(client, '预览')
    await check(
      `document.querySelector(${JSON.stringify(fileSelector + ' iframe')}) !== null`,
      'HTML预览加载'
    )
    await evaluate(
      client,
      `document.querySelector(${JSON.stringify(fileSelector + ' iframe')}).focus()`
    )
    await back()
    await assertChat()
    await blur()
    await back(false)
    console.log('通过：代码失焦、侧栏优先、HTML iframe、聊天根层返回')
  }
  if (!scenario || scenario === 'images') {
    await openFile('sample.png')
    await check(
      `document.querySelector(${JSON.stringify(fileSelector + ' [aria-label="全屏查看图片"]')}) !== null`,
      '图片加载'
    )
    await clickAriaLabel(client, '全屏查看图片')
    await check('document.querySelector("[aria-label=退出全屏]") !== null', '图片全屏')
    await back()
    await check('document.querySelector("[aria-label=全屏查看图片]") !== null', '返回退出图片全屏')
    await check(visible(fileSelector), '退出全屏保留文件预览')
    await blur()
    await back()
    await assertChat()
    console.log('通过：全屏图片逐层返回')
  }
  if (!scenario || scenario === 'dialogs') {
    await openFile('sample.ts')
    await openSidebar()
    await click('[data-testid="sidebar-shortcuts"] button[title="设置"]')
    await check('document.querySelector("[data-slot=app-dialog-content]") !== null', '设置弹层打开')
    await back()
    await check('document.querySelector("[data-slot=app-dialog-content]") === null', '返回关闭设置')
    await check(visible(fileSelector), '关闭设置不关闭下层文件')
    await blur()
    await back()
    await assertChat()
    console.log('通过：通用弹层一次只关闭一层')
  }
  if (!scenario || scenario === 'terminal') {
    await openSidebar()
    await click('[data-testid="sidebar-mode-files"]')
    await click('[data-testid="project-files-terminal-open"]')
    await check(visible('[data-testid="terminal-panel"]'), '手机终端打开')
    await check(
      'document.querySelector("[data-testid=terminal-panel] textarea") !== null',
      '终端可输入'
    )
    await evaluate(
      client,
      'document.querySelector("[data-testid=terminal-panel] textarea").focus()'
    )
    for (const type of ['keyDown', 'keyUp']) {
      await client.send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      })
    }
    await check(visible('[data-testid="terminal-panel"]'), '真实键盘Escape保留终端')
    await back()
    await check(visible('[data-testid="terminal-collapsed-bar"]'), '返回只收起终端')
    await assertChat()
    await click('[data-testid="terminal-collapsed-bar"]')
    await check(visible('[data-testid="terminal-panel"]'), '保留终端可重新展开')
    await blur()
    await back()
    await assertChat()
    await blur()
    await back(false)
    console.log('通过：终端聚焦与失焦返回，保留终端进程')
  }
  if (!scenario || scenario === 'navigation') {
    await clickAriaLabel(client, '更多操作')
    await check('document.querySelector("[role=menu]") !== null', '聊天菜单打开')
    await back()
    await check('document.querySelector("[role=menu]") === null', '返回只关闭菜单')
    await clickAriaLabel(client, '更多操作')
    await clickText(client, '任务中心')
    await check(visible('[data-slot="app-dialog-content"][aria-label="任务中心"]'), '任务中心打开')
    await back()
    await check(
      'document.querySelector("[data-slot=app-dialog-content]") === null',
      '返回关闭任务中心'
    )
    await clickAriaLabel(client, '更多操作')
    await click('[aria-label="切换会话分支"]')
    await check(visible('[aria-label="会话分支选择器"]'), '分支面板打开')
    await back()
    await check(
      'document.querySelector("[aria-label=会话分支选择器]") === null',
      '返回关闭分支面板'
    )
    await clickAriaLabel(client, '更多操作')
    await click('[aria-label="切换会话分支"]')
    await check(visible('[aria-label="会话分支选择器"]'), '分支面板再次打开')
    await blur()
    await back()
    await check(
      'document.querySelector("[aria-label=会话分支选择器]") === null',
      '分支失焦仍可返回'
    )
    await assertChat()
    await blur()
    await back(false)
    await back(false)
    console.log('通过：菜单和分支面板逐层返回，聊天根层连续返回不误开分支')
  }
  passed = true
} catch (error) {
  await writeFile(join(runRoot, 'server.log'), output)
  await writeFile(join(runRoot, 'failure.txt'), String(error.stack ?? error))
  if (client) {
    const pageState = await evaluate(
      client,
      `({text: document.body.innerText, focus: document.activeElement?.outerHTML})`
    ).catch(String)
    await writeFile(join(runRoot, 'page.json'), JSON.stringify(pageState, null, 2))
  }
  console.error(`失败现场：${runRoot}`)
  throw error
} finally {
  client?.close()
  const cleanup = await Promise.allSettled([
    browser ? stopBrowserTree(browser, cdpPort) : undefined,
    server ? stopE2eServerTree(server) : undefined
  ])
  for (const result of cleanup) {
    if (result.status === 'rejected') {
      passed = false
      console.error('清理失败', result.reason)
    }
  }
  if (passed) {
    await rm(runRoot, { recursive: true, force: true })
    await rm(testRoot, { recursive: true, force: true })
    await rm(join(projectRoot, 'temp/build/mobile-back', runId), { recursive: true, force: true })
  }
  assert.ok(
    cleanup.every((result) => result.status === 'fulfilled'),
    '验证进程未完整释放'
  )
}
