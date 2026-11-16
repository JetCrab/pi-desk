import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import {
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
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runId = `notification-island-${process.pid}`
const runRoot = join(projectRoot, 'temp/run/app-notifications', runId)
const piRoot = join(projectRoot, 'temp/pi/app-notifications-visual', runId)
const buildRoot = join(projectRoot, 'temp/build/app-notifications', runId)
const agentDir = join(piRoot, 'agent')
const pluginDir = join(piRoot, 'notification-plugin')
const projectDir = join(runRoot, 'project')
const password = 'Qq.445566'
const clientId = crypto.randomUUID()
const slotSelector = '[data-testid="app-notification-slot"]'
const panelSelector = '[data-testid="app-notification-panel"]'
const moreSelector = '[data-testid="app-notification-more"]'
const latestSelector = '[data-latest="true"]'
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`
const evidence = []
const checks = []
const browserErrors = []
let appPort = 0
let cdpPort = 0
let serverRuntime
let browser
let client
let driver
let touch = false
let serverOutput = ''

async function createFixture() {
  await prepareIsolatedPiDirectory(agentDir)
  await mkdir(projectDir, { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  await mkdir(join(pluginDir, 'browser'), { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '检查工作区通知' }],
    timestamp: Date.now()
  })
  manager.appendSessionInfo('工作区通知')
  await writeFile(
    join(agentDir, 'pi-desk', 'work-sessions.json'),
    JSON.stringify({
      workSessions: [
        { workId: 'notification-visual', cwd: projectDir, sessionId: manager.getSessionId() }
      ],
      pinnedCount: 0
    })
  )
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [pluginDir] }))
  await writeFile(
    join(pluginDir, 'package.json'),
    JSON.stringify({
      name: 'app-notification-visual-fixture',
      type: 'module',
      piDesk: { entry: './entry.mjs' }
    })
  )
  await writeFile(
    join(pluginDir, 'entry.mjs'),
    `export default {
  name: 'notification-fixture',
  setup(plugin) {
    plugin.registerBrowserEntry('./browser/entry.js')
    plugin.registerMethod('publish', async input => ({ notificationId: plugin.notifications.publish(input) }))
    plugin.registerMethod('delete', async input => {
      plugin.notifications.delete(input.notificationId)
      return {}
    })
  }
}`
  )
  await writeFile(
    join(pluginDir, 'browser/entry.js'),
    `export default function entry(plugin) {
  plugin.notifications.onEvent('open-result', ({ data }) => {
    plugin.notify({ level: 'success', title: '通知事件已执行', description: String(data.runId) })
  })
}`
  )
}

function request(path, body = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const requestId = crypto.randomUUID()
    const cleanup = () => {
      clearTimeout(timer)
      driver.off('message', onMessage)
      driver.off('error', onError)
    }
    const onError = (error) => {
      cleanup()
      rejectRequest(error)
    }
    const onMessage = (data) => {
      const message = JSON.parse(data.toString())
      if (message.head?.requestId !== requestId) return
      cleanup()
      if (message.body.code !== 0) rejectRequest(new Error(message.body.msg))
      else resolveRequest(message.body.data)
    }
    const timer = setTimeout(() => onError(new Error(`请求超时：${path}`)), 15_000)
    driver.on('message', onMessage)
    driver.once('error', onError)
    driver.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
  })
}
const invoke = (method, input) =>
  request('plugins/invoke', { scope: 'global', pluginName: 'notification-fixture', method, input })
const publish = (title, level = 'info', actionable = false) =>
  invoke('publish', {
    title,
    level,
    description: '工作区 · 通知内容',
    ...(actionable
      ? { event: { name: 'open-result', data: { runId: 'notification-visual' } } }
      : {})
  })
const read = (expression) => evaluate(client, expression)
const wait = (expression, label, timeout = 15_000) =>
  waitFor(client, expression, label, () => serverOutput, timeout)
async function stable() {
  await read(`(async () => {
    const finite = () => document.getAnimations().filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime));
    for (let pass=0; pass<8; pass++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const animations=finite();
      if (!animations.length) return;
      await Promise.allSettled(animations.map(a=>a.finished));
    }
    if (finite().length) throw new Error('界面动画未收敛');
  })()`)
}
async function point(selector) {
  return read(`(() => {
    const element=${q(selector)};
    if (!(element instanceof HTMLElement)) throw new Error('未找到操作：'+${JSON.stringify(selector)});
    const rect=element.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`)
}
async function click(selector) {
  const position = await point(selector)
  if (touch) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...position, id: 1 }]
    })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...position,
      button: 'left',
      clickCount: 1
    })
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...position,
      button: 'left',
      clickCount: 1
    })
  }
}
async function move(selector) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...(await point(selector)) })
}
async function capture(name) {
  const path = join(runRoot, `${name}.png`)
  await writeFile(path, await screenshot(client))
  evidence.push(path)
}
async function layout() {
  return read(`(() => {
    const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height}};
    return {slot:rect(${JSON.stringify(slotSelector)}),panel:rect(${JSON.stringify(panelSelector)}),list:rect('[data-testid="work-session-list"]'),footer:rect('[data-testid="sidebar-shortcuts"]'),rootSize:parseFloat(getComputedStyle(document.documentElement).fontSize)};
  })()`)
}
function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1, `几何不符合预期：${actual} / ${expected}`)
}
async function startFrames() {
  await read(`(() => {
    window.__noticeFrames=[];
    window.__noticeSampling=true;
    const frame=()=>{
      const slot=${q(slotSelector)}, panel=${q(panelSelector)}, footer=document.querySelector('[data-testid="sidebar-shortcuts"]');
      window.__noticeFrames.push({height:slot.getBoundingClientRect().height,opacity:Number(getComputedStyle(panel).opacity),footer:footer.getBoundingClientRect().top,text:panel.textContent});
      if(window.__noticeSampling) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  })()`)
}
async function stopFrames() {
  return read(`(() => {window.__noticeSampling=false;return window.__noticeFrames})()`)
}
function assertMotion(frames, from, to, label) {
  closeTo(frames[0].height, from)
  closeTo(frames.at(-1).height, to)
  assert.ok(
    frames.some((f) => f.height > Math.min(from, to) + 1 && f.height < Math.max(from, to) - 1),
    `${label}没有中间高度`
  )
  assert.ok(
    frames.some((f) => f.opacity > 0.01 && f.opacity < 0.99),
    `${label}没有透明度过渡`
  )
  closeTo(Math.max(...frames.map((f) => f.footer)), Math.min(...frames.map((f) => f.footer)))
  checks.push({ label, frames: frames.length })
}
async function waitLatest(title) {
  await wait(
    `${q(latestSelector)}?.textContent.includes(${JSON.stringify(title)}) && ${q(slotSelector)}.dataset.visible==='true'`,
    `显示通知：${title}`
  )
}

let failure
try {
  await createFixture()
  appPort = await reservePort()
  serverRuntime = spawnE2eServer({
    projectRoot,
    agentDir,
    port: appPort,
    development: true,
    nextDirectory: buildRoot,
    onOutput: (output) => {
      serverOutput = (serverOutput + output).slice(-2 * 1024 * 1024)
    }
  })
  await waitForHttp(
    `http://127.0.0.1:${appPort}/api/health`,
    60_000,
    '隔离 Pi Desk',
    () => serverOutput
  )
  cdpPort = await reservePort()
  browser = spawnEdge(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    cdpPort,
    join(runRoot, 'browser-profile'),
    '1360,900'
  )
  await waitForBrowserReady(browser, cdpPort)
  client = await createCdpPage(cdpPort)
  client.events.set('Runtime.exceptionThrown', new Set([(event) => browserErrors.push(event)]))
  await setViewport(client, 1360, 900, false)
  await navigate(client, `http://127.0.0.1:${appPort}/login`)
  const login = await read(
    `fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':crypto.randomUUID()},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.json())`
  )
  assert.equal(login.code, 0, login.msg)
  const cookies = await client.send('Network.getCookies', {
    urls: [`http://127.0.0.1:${appPort}/`]
  })
  driver = new WebSocket(`ws://127.0.0.1:${appPort}/api/ws?clientId=${clientId}`, 'pi-desk.v1', {
    headers: {
      Cookie: cookies.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    },
    handshakeTimeout: 15_000
  })
  await once(driver, 'open')
  await request('work-sessions/list')
  await navigate(client, `http://127.0.0.1:${appPort}/`)
  await wait(`${q(slotSelector)} !== null`, '工作台通知插槽', 60_000)
  await stable()
  closeTo((await layout()).slot.height, 0)
  await read(
    `document.querySelectorAll('nextjs-portal').forEach(element=>element.style.display='none'); document.documentElement.classList.remove('dark')`
  )

  await startFrames()
  await publish('代码检查已完成', 'success')
  await waitLatest('代码检查已完成')
  await stable()
  const fullHeight = (await layout()).slot.height
  assertMotion(await stopFrames(), 0, fullHeight, '首条通知平滑入场')
  await capture('desktop-collapsed')
  await startFrames()
  await click(`${latestSelector} button[title]`)
  await wait(`${q(slotSelector)}.dataset.visible==='false'`, '最后一条删除')
  await stable()
  const exit = await stopFrames()
  assertMotion(exit, fullHeight, 0, '最后一条平滑退场')
  assert.ok(
    exit.filter((f) => f.height > 2).every((f) => f.text.includes('代码检查已完成')),
    '退场期间内容不能提前清空'
  )
  await wait(`${q(latestSelector)}===null`, '退场快照释放')

  const old = await publish('即将删除的通知')
  await waitLatest('即将删除的通知')
  await invoke('delete', { notificationId: old.notificationId })
  await wait(`${q(slotSelector)}.dataset.visible==='false'`, '快速删除已生效')
  const active = await publish('新的工作区通知', 'success')
  await waitLatest('新的工作区通知')
  await stable()
  closeTo((await layout()).slot.height, fullHeight)
  assert.equal(await read(`${q(panelSelector)}.inert`), false)
  checks.push('退场中新通知接管，无旧快照覆盖')

  await publish('插件依赖已重新加载')
  await publish('发布需要一次确认', 'warning')
  await publish('最新构建完成，可以查看交付物', 'success', true)
  await waitLatest('最新构建完成')
  await stable()
  const collapsed = await layout()
  await move('[data-testid="sidebar-shortcuts"]')
  await move(latestSelector)
  await wait(`${q(panelSelector)}.dataset.expanded==='true'`, '桌面悬停展开')
  await stable()
  const expanded = await layout()
  for (const key of ['slot', 'list', 'footer']) {
    closeTo(expanded[key].height, collapsed[key].height)
    closeTo(expanded[key].bottom, collapsed[key].bottom)
  }
  closeTo(expanded.panel.bottom, collapsed.panel.bottom)
  assert.ok(expanded.panel.top < collapsed.panel.top)
  await capture('desktop-expanded')
  await move('[data-testid="sidebar-shortcuts"]')
  await wait(`${q(panelSelector)}.dataset.expanded==='false'`, '移出收起')
  await click(moreSelector)
  await stable()
  await move('[data-testid="sidebar-shortcuts"]')
  assert.equal(await read(`${q(moreSelector)}.getAttribute('aria-expanded')`), 'true')
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await wait(`${q(panelSelector)}.dataset.expanded==='false'`, 'Escape 收起')
  checks.push('历史展开不挤压会话，悬停、点击保持和键盘收起通过')

  await read(
    `document.documentElement.classList.add('dark'); document.documentElement.style.fontSize='150%'`
  )
  await click(moreSelector)
  await stable()
  const scaled = await layout()
  closeTo(scaled.slot.height, scaled.rootSize * 4.5)
  assert.ok(scaled.panel.bottom <= scaled.footer.top)
  assert.equal(await read(`document.documentElement.scrollWidth<=innerWidth`), true)
  await capture('desktop-dark-large-text')
  await click(moreSelector)
  await read(
    `document.documentElement.classList.remove('dark'); document.documentElement.style.removeProperty('font-size')`
  )

  await setViewport(client, 390, 844, true)
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  touch = true
  const showMenu = 'button[aria-label="显示工作会话菜单"]'
  await wait(`${q(showMenu)}!==null`, '移动菜单入口')
  await click(showMenu)
  await stable()
  await wait(
    `${q('[data-testid="mobile-work-session-drawer"]')}.dataset.open==='true'`,
    '侧栏已打开'
  )
  await capture('mobile-collapsed')
  await click(moreSelector)
  await wait(`${q(panelSelector)}.dataset.expanded==='true'`, '触控展开')
  await stable()
  await capture('mobile-expanded')
  await click(`${latestSelector} button:not([title]):not([data-testid])`)
  await wait(
    `document.body.textContent.includes('通知事件已执行') && !${q(latestSelector)}.textContent.includes('最新构建完成')`,
    '真实通知事件消费后删除'
  )
  checks.push('移动触控展开及真实事件消费删除通过')

  await client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  assert.equal(await read(`getComputedStyle(${q(slotSelector)}).transitionDuration`), '0s')
  await invoke('delete', { notificationId: active.notificationId })
  assert.equal(browserErrors.length, 0, JSON.stringify(browserErrors))
  checks.push('150% 字号、明暗主题、减少动态效果、无页面异常通过')
  console.log(JSON.stringify({ checks, evidence }, null, 2))
} catch (error) {
  failure = error
  if (client) await capture('failure').catch(() => {})
} finally {
  const cleanupErrors = []
  driver?.terminate()
  client?.close()
  for (const operation of [
    () => stopBrowserTree(browser, cdpPort),
    () => (serverRuntime ? stopE2eServerTree(serverRuntime) : undefined)
  ]) {
    try {
      await operation()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  await mkdir(runRoot, { recursive: true })
  await writeFile(join(runRoot, 'server.log'), serverOutput)
  await writeFile(
    join(runRoot, 'checks.json'),
    JSON.stringify({ checks, evidence, failed: Boolean(failure) }, null, 2)
  )
  if (!failure && cleanupErrors.length === 0) {
    await rm(join(runRoot, 'browser-profile'), { recursive: true, force: true })
    await rm(piRoot, { recursive: true, force: true })
    await rm(buildRoot, { recursive: true, force: true })
    console.log('隔离服务与浏览器进程树已终止，端口已释放。截图待人工复核：' + runRoot)
  }
  if (failure || cleanupErrors.length)
    throw new AggregateError(
      [failure, ...cleanupErrors].filter(Boolean),
      '通知验收失败；现场：' + runRoot
    )
}
