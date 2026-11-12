import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCdpPage,
  delay,
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
import { assertPortReleased, spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const taskId = `event-lifecycle-${randomUUID()}`
const fixtureRoot = join(projectRoot, 'temp/pi/plugin-events', taskId)
const agentDir = join(fixtureRoot, 'agent')
const runRoot = join(projectRoot, 'temp/run/plugin-events', taskId)
const buildRoot = join(projectRoot, 'temp/build/plugin-events', taskId)
const cwd = join(runRoot, 'same-cwd-project')
const workA = 'events-work-a'
const workB = 'events-work-b'
const publisher = 'events-fixture-a'
const subscriber = 'events-fixture-b'
const provider = 'events-local'
const model = 'events-model'
const scenario = process.env.PI_DESK_EVENTS_E2E_CASE ?? 'all'
assert.ok(['all', 'E01', 'E02', 'E03'].includes(scenario), '未知事件 E2E 场景')
const pages = []
const requests = []
const heldResponses = new Set()
const results = []
let serverOutput = ''
let providerError
let stage = '准备夹具'

function bounded(promise, label, timeout = 30000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时`)), timeout)
    })
  ]).finally(() => clearTimeout(timer))
}

function browserFixture(name, version) {
  return `export const facts = {
  version: ${version}, contexts: [], custom: [], submits: [], prompt: null,
  node: null, nodePublished: 0, sidebarMounts: [], sidebarDisposes: [], errors: [], firstWasAsync: null,
  get deliveries() { return Number(sessionStorage.getItem('${name}-deliveries') ?? '0') }
}
export const listeners = new Set()
export function render() {
  for (const listener of listeners) listener()
}
export default function(plugin) {
  const host = plugin.host
  let returned = false
  host.events.on('workbench-context', value => {
    if (facts.firstWasAsync === null) facts.firstWasAsync = returned
    facts.contexts.push(value)
    render()
  })
  host.events.on('chat-submit-result', value => { facts.submits.push(value); render() })
  host.events.onPlugin('${publisher}', 'ping', value => {
    sessionStorage.setItem('${name}-deliveries', String(facts.deliveries + 1))
    facts.custom.push(value)
    render()
  })
  returned = true
  const load = () => import('./view.js')
  plugin.registerWidget('facts', { load: () => load().then(module => module.widget) })
  ${
    name === publisher
      ? `plugin.registerContribution('session-sidebar-tab', 'context', {
    label: '事件侧栏', icon: {type:'builtin', name:'plugin'},
    load: () => load().then(module => module.sidebar)
  })
  plugin.registerContribution('application', 'late-context', {
    label: '事件晚订阅', title: '事件晚订阅', chrome: 'host',
    icon: {type:'builtin', name:'plugin'}, load: () => load().then(module => module.late)
  })`
      : ''
  }
  // Entry 订阅交给 Owner 自动释放，以便重载用例能发现宿主遗留回调。
  return () => { listeners.clear() }
}
`
}

function viewFixture(name) {
  return `import { facts, listeners, render } from './entry.js'
function output(id) {
  const element = document.createElement('output')
  element.dataset.testid = id
  element.style.cssText = 'display:block;max-height:5rem;overflow:auto;overflow-wrap:anywhere;font-size:.65rem'
  return element
}
export const widget = {
  mount({container, target, host}) {
    const root = document.createElement('section')
    const value = output('${name}-facts-' + target.source.workId)
    const update = () => { value.textContent = JSON.stringify(facts) }
    const action = (id, text, run) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.testid = '${name}-' + id + '-' + target.source.workId
      button.textContent = text
      button.onclick = async () => {
        button.disabled = true
        try { await run() } catch(error) { facts.errors.push(String(error)) }
        finally { button.disabled = false; render() }
      }
      root.append(button)
    }
    action('emit', '发布页面事件', () => host.events.emit('ping', { value: facts.custom.length + 1, version: facts.version }))
    action('node-publish', '发布 Node 事件', async () => {
      await host.piDesk.invokeGlobal('publish-node', {})
      facts.nodePublished += 1
    })
    action('node-query', '读取 Node 观察结果', async () => {
      facts.node = await host.piDesk.invokeGlobal('inspect', {})
    })
    action('prompt', '插件发送一次', async () => {
      facts.prompt = await host.pi.prompt(target.source, { mode:'auto', text:'事件插件发送' })
    })
    root.append(value)
    container.append(root)
    listeners.add(update)
    update()
    return () => { listeners.delete(update); root.remove() }
  }
}
export const sidebar = {
  mount({container, target, signal}) {
    const record = { source:target.source, cwd:target.cwd }
    facts.sidebarMounts.push(record)
    const element = output('events-sidebar-target')
    element.textContent = JSON.stringify(record)
    container.append(element)
    render()
    return () => {
      facts.sidebarDisposes.push({ ...record, aborted:signal.aborted })
      element.remove()
      render()
    }
  }
}
export const late = {
  mount({container, target, host}) {
    const root = document.createElement('section')
    const value = output('events-late-context')
    let returned = false
    let delivered = false
    let asynchronous = null
    let byMicrotask = null
    let latest
    const update = () => {
      value.textContent = JSON.stringify({context:latest, asynchronous, byMicrotask})
    }
    const stop = host.events.on('workbench-context', context => {
      if (!delivered) asynchronous = returned
      delivered = true
      latest = context
      update()
    })
    returned = true
    queueMicrotask(() => { byMicrotask = delivered; update() })
    const close = document.createElement('button')
    close.dataset.testid = 'events-late-close'
    close.textContent = '关闭事件晚订阅'
    close.onclick = () => target.close()
    root.append(value, close)
    container.append(root)
    return () => { stop(); root.remove() }
  }
}
`
}

async function writePlugin(name, version) {
  const directory = join(agentDir, 'extensions', name)
  await mkdir(join(directory, 'browser'), { recursive: true })
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name,
      version: `1.0.${version}`,
      type: 'module',
      private: true,
      piDesk: { entry: './entry.mjs' }
    })
  )
  await writeFile(
    join(directory, 'entry.mjs'),
    `export default {
  name:'${name}', setup(plugin) {
    const accepted = [], custom = []
    plugin.host.events.on('chat-input-accepted', value => { accepted.push(value) })
    plugin.host.events.onPlugin('${publisher}', 'ping', value => { custom.push(value) })
    plugin.registerMethod('inspect', async () => ({ accepted, custom, version:${version} }))
    plugin.registerMethod('publish-node', async () => {
      plugin.host.events.emit('ping', {domain:'node', version:${version}})
      return {published:true}
    })
    plugin.registerBrowserEntry('./browser/entry.js')
  }
}`
  )
  await writeFile(join(directory, 'browser/entry.js'), browserFixture(name, version))
  await writeFile(join(directory, 'browser/view.js'), viewFixture(name))
  return directory
}

async function prepareFixture(modelPort) {
  for (const directory of [cwd, join(agentDir, 'sessions'), join(agentDir, 'pi-desk')]) {
    await mkdir(directory, { recursive: true })
  }
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      packages: [],
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: 'off'
    })
  )
  await writeFile(
    join(agentDir, 'pi-desk-settings.json'),
    JSON.stringify({
      region: { locale: 'zh-CN', timeZone: 'UTC' }
    })
  )
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [
            {
              id: model,
              name: '本地事件夹具',
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
  )
  await writePlugin(publisher, 1)
  await writePlugin(subscriber, 1)
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const sessions = []
  for (const title of ['事件会话 A', '事件会话 B', '事件替换会话']) {
    const session = SessionManager.create(cwd)
    session.appendModelChange(provider, model)
    session.appendMessage({
      role: 'user',
      content: '只使用本地事件测试模型。',
      timestamp: Date.now()
    })
    session.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '事件夹具已就绪。' }],
      api: 'openai-completions',
      provider,
      model,
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }
    })
    session.appendSessionInfo(title)
    sessions.push(session.getSessionId())
  }
  await writeFile(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({
      workSessions: ['E02', 'E03'].includes(scenario)
        ? [
            { workId: workB, cwd, sessionId: sessions[1] },
            { workId: workA, cwd, sessionId: sessions[2] }
          ]
        : [workA, workB].map((workId, index) => ({ workId, cwd, sessionId: sessions[index] })),
      pinnedCount: ['E02', 'E03'].includes(scenario) ? 1 : 0
    })
  )
  return sessions
}

function chunk(response, delta, finishReason = null) {
  response.write(
    `data: ${JSON.stringify({
      id: 'events-response',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`
  )
}

async function openPage(cdpPort, origin, mobile) {
  const raw = await bounded(createCdpPage(cdpPort), '创建独立页面')
  const page = {
    send: (method, parameters) =>
      page.closed
        ? Promise.reject(new Error('测试页面已关闭'))
        : bounded(raw.send(method, parameters), method),
    once: (method) => bounded(raw.once(method), method, 120000),
    close: () => {
      page.closed = true
      raw.close()
    },
    closed: false,
    sent: [],
    received: [],
    errors: [],
    interactions: [],
    mobile,
    clientId: null,
    appSockets: new Set()
  }
  pages.push(page)
  raw.socket.on('message', (bytes) => {
    const message = JSON.parse(bytes.toString())
    if (message.method === 'Network.webSocketCreated' && message.params.url.includes('/api/ws?')) {
      page.clientId = new URL(message.params.url).searchParams.get('clientId')
      page.appSockets.add(message.params.requestId)
    }
    if (message.method === 'Runtime.exceptionThrown')
      page.errors.push(message.params.exceptionDetails)
    if (
      ['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(message.method) &&
      page.appSockets.has(message.params.requestId) &&
      message.params.response.opcode === 1
    ) {
      const frame = JSON.parse(message.params.response.payloadData)
      if (frame.head?.path === 'chat/send') {
        ;(message.method.endsWith('Sent') ? page.sent : page.received).push(frame)
      }
    }
  })
  await page.send('Network.enable')
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 1 })
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  await setViewport(page, mobile ? 390 : 1800, mobile ? 844 : 1000, mobile)
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('pi-super:locale','zh-CN');
      window.__eventInputTrace = [];
      for (const type of ['pointerdown','pointerup','mousedown','mouseup','touchstart','touchend','click','focusin']) {
        document.addEventListener(type, event => {
          const item = {type, pointerType:event.pointerType, trusted:event.isTrusted,
            target:event.target?.getAttribute?.('data-testid'),
            workId:event.target?.closest?.('[data-work-id]')?.getAttribute('data-work-id')};
          window.__eventInputTrace.push(item);
          if (window.__eventInputTrace.length > 96) window.__eventInputTrace.shift();
          setTimeout(() => { item.prevented = event.defaultPrevented }, 0);
        }, true);
      }`
  })
  await navigate(page, origin)
  await waitFor(
    page,
    `Boolean(document.querySelector('[data-testid="work-session-row-${workA}"]'))`,
    '隔离会话列表',
    () => serverOutput,
    120000
  )
  return page
}

const testId = (value) => `[data-testid="${value}"]`
const factsSelector = (name, workId) => testId(`${name}-facts-${workId}`)
const factsExpression = (name, workId) =>
  `JSON.parse(document.querySelector(${JSON.stringify(factsSelector(name, workId))}).textContent)`
const facts = (page, name = publisher, workId = workA) =>
  evaluate(page, factsExpression(name, workId))
const wait = (page, expression, label) =>
  waitFor(page, `Boolean(${expression})`, label, () => serverOutput, 60000)

async function clickTarget(page, expression, label) {
  await page.send('Page.bringToFront')
  await wait(
    page,
    `(() => {
      const element=${expression};
      return element && !element.disabled && !element.closest('[inert]') && element.getClientRects().length > 0;
    })()`,
    `操作可用：${label}`
  )
  const targetExpression = `(() => {
    const element=${expression};
    element.scrollIntoView({block:'nearest', inline:'nearest'});
    const rect=element.getBoundingClientRect();
    const x=(Math.max(0, rect.left)+Math.min(innerWidth, rect.right))/2;
    const y=(Math.max(0, rect.top)+Math.min(innerHeight, rect.bottom))/2;
    const hit=document.elementFromPoint(x,y);
    return {x,y,reachable:element===hit||element.contains(hit),hit:hit?.outerHTML.slice(0,400)};
  })()`
  const initial = await evaluate(page, targetExpression)
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: initial.x,
    y: initial.y
  })
  await wait(page, `(${targetExpression}).reachable`, `悬停后可命中：${label}`)
  const target = await evaluate(page, targetExpression)
  assert.equal(target.reachable, true, `${label} 被其他元素遮挡：${JSON.stringify(target)}`)
  console.info('[事件 E2E] 点击', label)
  const { x, y } = target
  if (page.mobile) {
    await page.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 1 }]
    })
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    return
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
}

async function click(page, selector) {
  await clickTarget(page, `document.querySelector(${JSON.stringify(selector)})`, selector)
}

async function clickButton(page, name) {
  const expression = `(() => [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')].find(element =>
    (element.getAttribute('aria-label') ?? element.textContent.trim())===${JSON.stringify(name)} &&
    !element.closest('[inert]') && element.getClientRects().length > 0))()`
  await clickTarget(page, expression, name)
}

async function until(check, label) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (providerError) throw new Error(providerError)
    if (check()) return
    await delay(50)
  }
  throw new Error(`等待超时：${label}`)
}

async function settled(page) {
  // 后台页会暂停动画帧；激活后再等待事件微任务及 React 提交，不用固定 sleep。
  await page.send('Page.bringToFront')
  await evaluate(
    page,
    `new Promise(resolve => queueMicrotask(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))`
  )
}

async function expectContext(page, workId, sessionId) {
  await wait(
    page,
    `document.querySelector(${JSON.stringify(factsSelector(publisher, workId))})`,
    '插件事实视图'
  )
  await wait(
    page,
    `(() => {
    const current=(${factsExpression(publisher, workId)}).contexts.at(-1);
    return current?.source.workId===${JSON.stringify(workId)} && current.source.sessionId===${JSON.stringify(sessionId)} && current.cwd===${JSON.stringify(cwd)};
  })()`,
    '真实聚焦 Source 与同目录'
  )
  const value = await facts(page, publisher, workId)
  assert.equal(value.firstWasAsync, true, 'Entry 首次值必须在订阅返回后交付')
  assert.equal(typeof value.contexts.at(-1).source.branchId, 'string')
  return value.contexts.at(-1)
}

async function select(page, workId, sessionId, mobile = false) {
  if (mobile) {
    const open = await evaluate(
      page,
      `document.querySelector('[data-testid="mobile-work-session-drawer"]')?.dataset.open === 'true'`
    )
    if (!open) await click(page, '[aria-label="显示工作会话菜单"]')
  }
  await click(page, testId(`work-session-row-${workId}`))
  return expectContext(page, workId, sessionId)
}

async function queryNode(page, workId = workA) {
  const before = await facts(page, subscriber, workId)
  await click(page, testId(`${subscriber}-node-query-${workId}`))
  await wait(
    page,
    `!document.querySelector(${JSON.stringify(testId(`${subscriber}-node-query-${workId}`))}).disabled`,
    'Node 查询完成'
  )
  const next = await facts(page, subscriber, workId)
  assert.deepEqual(next.errors, [], JSON.stringify(before.errors))
  return next.node
}

async function applyPlugin(page, name, version) {
  const directory = await writePlugin(name, version)
  assert.ok(page.clientId, '页面应用连接已初始化')
  const response = await evaluate(
    page,
    `fetch('/api/plugins/apply', {
    method:'POST', credentials:'include', headers:{'Content-Type':'application/json',
      'X-Pi-Desk-Client-Id':${JSON.stringify(page.clientId)}},
    body:JSON.stringify({sources:[${JSON.stringify(directory)}]})
  }).then(async response => ({status:response.status, body:await response.json()}))`
  )
  assert.equal(response.status, 200, JSON.stringify(response))
  assert.equal(response.body.code, 0, JSON.stringify(response))
  for (const item of pages) {
    await wait(
      item,
      `document.querySelector(${JSON.stringify(factsSelector(name, workA))}) && (${factsExpression(name, workA)}).version===${version}`,
      '两页目标插件重载完成'
    )
  }
}

async function swipe(page, direction) {
  // 用可访问角色定位当前聊天内容；触控轨迹由目标边界生成，不用绝对坐标定位 UI。
  const visibleLog = `(() => {
    const carousel=document.querySelector('[role="region"][aria-label="工作会话窗口"]');
    return [...(carousel?.querySelectorAll('[role="log"]') ?? [])].find(element => {
      const rect=element.getBoundingClientRect();
      return rect.width>0 && rect.height>0 && rect.left>=0 && rect.right<=innerWidth+1;
    });
  })()`
  await wait(page, `Boolean(${visibleLog})`, '当前移动聊天页进入视口')
  const rect = await evaluate(
    page,
    `(() => {
    const rect=(${visibleLog}).getBoundingClientRect();
    return {left:rect.left, width:rect.width, y:rect.top+rect.height/2};
  })()`
  )
  const start = direction === 'next' ? 0.8 : 0.2
  const end = 1 - start
  const point = (ratio) => ({ x: rect.left + rect.width * ratio, y: rect.y, id: 1 })
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(start)] })
  try {
    for (let index = 1; index <= 8; index += 1) {
      await page.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [point(start + ((end - start) * index) / 8)]
      })
    }
  } finally {
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
}

async function e01(page, sessions) {
  stage = 'E01 工作台焦点与侧栏'
  const a = await select(page, workA, sessions[0])
  await click(page, testId(`work-session-pin-${workB}`))
  await click(page, '[aria-label="显示事件侧栏"]')
  await wait(
    page,
    `document.querySelector('[data-testid="events-sidebar-target"]')`,
    '原会话侧栏挂载'
  )
  assert.deepEqual(
    await evaluate(
      page,
      `JSON.parse(document.querySelector('[data-testid="events-sidebar-target"]').textContent)`
    ),
    a
  )
  await click(page, testId(`${publisher}-emit-${workB}`))
  const b = await expectContext(page, workB, sessions[1])
  await wait(
    page,
    `JSON.parse(document.querySelector('[data-testid="events-sidebar-target"]').textContent).source.workId==='${workB}'`,
    '侧栏按固定列焦点重挂'
  )
  const snapshot = await facts(page, publisher, workB)
  const previous = snapshot.sidebarDisposes.find((value) => value.source.workId === workA)
  assert.equal(previous?.aborted, true, '旧 Source 侧栏先 Abort 再释放')
  const count = snapshot.contexts.length
  await click(page, testId(`${publisher}-emit-${workB}`))
  await settled(page)
  const repeated = await facts(page, publisher, workB)
  assert.equal(repeated.contexts.length, count, '重复聚焦不能重复通知')
  assert.equal(
    repeated.sidebarMounts.length,
    snapshot.sidebarMounts.length,
    '同 Source 侧栏不能重复挂载'
  )
  await click(page, '[aria-label="隐藏工作会话菜单"]')
  await wait(
    page,
    `!document.querySelector('[data-testid="events-sidebar-target"]')`,
    '关闭侧栏释放视图'
  )
  await click(page, testId(`${publisher}-emit-${workA}`))
  await expectContext(page, workA, sessions[0])
  await click(page, testId(`${publisher}-emit-${workB}`))
  await expectContext(page, workB, sessions[1])
  await click(page, '[aria-label="显示工作会话菜单"]')
  await click(page, testId(`${publisher}-emit-${workB}`))
  await expectContext(page, workB, sessions[1])
  await clickButton(page, '事件晚订阅')
  await wait(
    page,
    `document.querySelector('[data-testid="events-late-context"]')?.textContent`,
    '晚挂载视图首次值'
  )
  assert.deepEqual(
    await evaluate(
      page,
      `JSON.parse(document.querySelector('[data-testid="events-late-context"]').textContent)`
    ),
    { context: b, asynchronous: true, byMicrotask: true }
  )
  await click(page, testId('events-late-close'))
  await click(page, testId('sidebar-mode-sessions'))
  await select(page, workB, sessions[1])
  const rowCount = (await facts(page, publisher, workB)).contexts.length
  await select(page, workB, sessions[1])
  await settled(page)
  assert.equal(
    (await facts(page, publisher, workB)).contexts.length,
    rowCount,
    '重复点击同一会话行不能重复通知'
  )
  await select(page, workA, sessions[0])
  const oldCount = (await facts(page)).contexts.length
  await click(page, testId('sidebar-replace-work-session'))
  await click(page, testId(`workbench-picker-replace-${sessions[2]}`))
  const replacement = await expectContext(page, workA, sessions[2])
  await settled(page)
  const changed = (await facts(page)).contexts.slice(oldCount)
  assert.ok(changed.length > 0)
  assert.ok(
    changed.every(
      (value) => value === null || JSON.stringify(value) === JSON.stringify(replacement)
    ),
    '绑定替换期间不能交付旧 Source 或混合上下文'
  )
  await click(page, '[aria-label="显示事件侧栏"]')
  await wait(
    page,
    `JSON.parse(document.querySelector('[data-testid="events-sidebar-target"]').textContent).source.sessionId===${JSON.stringify(sessions[2])}`,
    '替换绑定后的侧栏 Source'
  )
  assert.deepEqual(
    await evaluate(
      page,
      `JSON.parse(document.querySelector('[data-testid="events-sidebar-target"]').textContent)`
    ),
    replacement
  )
  await click(page, testId('sidebar-mode-sessions'))
  results.push('E01 焦点、同目录身份、重复聚焦、关闭侧栏、晚挂载、绑定替换；删除在 E03 后验证')
}

async function e02(desktop, mobile, sessions) {
  stage = 'E02 页面与运行域隔离'
  await select(desktop, workA, sessions[2])
  await select(mobile, workA, sessions[2], true)
  const beforeDesktop = (await facts(desktop, subscriber)).custom.length
  const beforeMobile = (await facts(mobile, subscriber)).custom.length
  assert.equal(beforeMobile, 0, '新页面不补发其他页面的历史自定义通知')
  await click(desktop, testId(`${publisher}-emit-${workA}`))
  await wait(
    desktop,
    `(${factsExpression(subscriber, workA)}).custom.length===${beforeDesktop + 1}`,
    '本页跨插件通知'
  )
  await click(mobile, testId(`${publisher}-emit-${workA}`))
  await wait(
    mobile,
    `(${factsExpression(subscriber, workA)}).custom.length===${beforeMobile + 1}`,
    '移动页自身通知'
  )
  await settled(desktop)
  assert.equal((await facts(desktop, subscriber)).custom.length, beforeDesktop + 1)
  assert.equal(
    (await facts(mobile, subscriber)).custom.length,
    beforeMobile + 1,
    '另页事件不得穿透'
  )
  await applyPlugin(desktop, publisher, 2)
  assert.equal(
    (await facts(desktop, subscriber)).custom.length,
    beforeDesktop + 1,
    '发布者重载不回放历史'
  )
  await click(desktop, testId(`${publisher}-emit-${workA}`))
  await wait(
    desktop,
    `(${factsExpression(subscriber, workA)}).custom.length===${beforeDesktop + 2}`,
    '发布者重载保留订阅者'
  )
  assert.equal((await facts(desktop, subscriber)).custom.at(-1).version, 2)
  const deliveries = (await facts(desktop, subscriber)).deliveries
  await applyPlugin(desktop, subscriber, 2)
  assert.deepEqual((await facts(desktop, subscriber)).custom, [], '新订阅者不回放历史')
  await click(desktop, testId(`${publisher}-emit-${workA}`))
  await wait(
    desktop,
    `(${factsExpression(subscriber, workA)}).custom.length===1`,
    '订阅者重载仅收到一次'
  )
  await settled(desktop)
  assert.equal(
    (await facts(desktop, subscriber)).deliveries,
    deliveries + 1,
    '旧订阅者 Owner 不得继续收到回调'
  )
  const localCount = (await facts(desktop, subscriber)).custom.length
  await click(desktop, testId(`${publisher}-node-publish-${workA}`))
  await wait(
    desktop,
    `(${factsExpression(publisher, workA)}).nodePublished===1`,
    'Node 发布方法返回'
  )
  const node = await queryNode(desktop)
  assert.deepEqual(node.custom, [{ domain: 'node', version: 2 }], 'Node 本域跨插件通知')
  await settled(mobile)
  assert.equal(
    (await facts(desktop, subscriber)).custom.length,
    localCount,
    'Node 不自动转发 Browser'
  )
  assert.deepEqual((await facts(mobile, subscriber)).custom, [])
  // 滑动与按钮发布分别验证，避免轮播的拖拽后首击抑制干扰事件分发断言。
  await swipe(mobile, 'next')
  await expectContext(mobile, workB, sessions[1])
  await expectContext(desktop, workA, sessions[2])
  assert.equal(
    await evaluate(
      mobile,
      `document.querySelector('[role="group"][aria-label^="1 / 2"] [data-testid="session-header-title"]')?.textContent`
    ),
    '事件替换会话',
    '切固定页不能替换主会话'
  )
  await swipe(mobile, 'previous')
  await expectContext(mobile, workA, sessions[2])
  results.push(
    'E02 两页独立焦点、真实触控切固定页、主会话保留、本页自定义通知、两侧重载释放、Node 域隔离'
  )
}

async function assertSend(page, other, source, ordinal) {
  await wait(
    page,
    `(${factsExpression(subscriber, workA)}).submits.length===${ordinal}`,
    'Browser accepted 不等待模型完成'
  )
  await queryNode(page)
  await wait(
    page,
    `(${factsExpression(subscriber, workA)}).node.accepted.length===${ordinal}`,
    'Node 接管事实'
  )
  await settled(page)
  const value = await facts(page, subscriber)
  const event = value.submits[ordinal - 1]
  assert.deepEqual(event, { source: source.source, status: 'accepted', tempId: event.tempId })
  assert.equal(typeof event.tempId, 'string')
  assert.ok(event.tempId.length > 0)
  assert.deepEqual(value.node.accepted[ordinal - 1], {
    source: source.source,
    tempId: event.tempId
  })
  const request = page.sent[ordinal - 1]
  assert.ok(request, '真实 chat/send 请求已发出')
  const response = page.received.find((value) => value.head.requestId === request.head.requestId)
  assert.equal(response?.body.code, 0, JSON.stringify(response))
  assert.equal(response.body.data.tempId, event.tempId, '事件 tempId 必须等于实际响应')
  assert.deepEqual(request.body.source, source.source)
  await until(() => heldResponses.size === 1, '本地 Provider 保持响应未完成')
  assert.equal(heldResponses.size, 1, 'Provider 尚未完成时已收到接管通知')
  await settled(other)
  assert.deepEqual((await facts(other, subscriber)).submits, [], '另一页不接收提交结果')
  return event
}

function finishProvider() {
  for (const response of heldResponses) {
    chunk(response, { content: `事件本地回复 ${requests.length}` })
    chunk(response, {}, 'stop')
    response.end('data: [DONE]\n\n')
  }
  heldResponses.clear()
}

async function e03(desktop, mobile, sessions) {
  stage = 'E03 真实输入和插件 Prompt'
  await select(desktop, workA, sessions[2])
  await click(desktop, testId(`work-session-pin-${workB}`))
  await wait(
    desktop,
    `document.querySelectorAll('textarea').length===1`,
    '正常输入区唯一可见且固定列已取消'
  )
  const source = await expectContext(desktop, workA, sessions[2])
  assert.deepEqual((await queryNode(desktop)).accepted, [])
  await click(desktop, 'textarea[placeholder="输入消息，Enter 发送，Shift+Enter 换行"]')
  await desktop.send('Input.insertText', { text: '事件真实输入' })
  await click(desktop, '[aria-label="发送消息"]')
  const first = await assertSend(desktop, mobile, source, 1)
  assert.equal(desktop.sent[0].body.text, '事件真实输入')
  finishProvider()
  await wait(
    desktop,
    `document.querySelector('[role="log"]')?.textContent.includes('事件本地回复 1') && Boolean(document.querySelector('[aria-label="发送消息"]')) && document.querySelector('textarea')?.readOnly===false`,
    '首个模型回复与输入恢复'
  )
  await click(desktop, testId(`${publisher}-prompt-${workA}`))
  const second = await assertSend(desktop, mobile, source, 2)
  await wait(
    desktop,
    `(${factsExpression(publisher, workA)}).prompt?.tempId===${JSON.stringify(second.tempId)}`,
    'host.pi.prompt 返回实际 tempId'
  )
  assert.notEqual(first.tempId, second.tempId)
  assert.equal(desktop.sent[1].body.text, '事件插件发送')
  assert.equal(requests.length, 2)
  assert.ok(JSON.stringify(requests[0].messages).includes('事件真实输入'))
  assert.ok(JSON.stringify(requests[1].messages).includes('事件插件发送'))
  finishProvider()
  await wait(
    desktop,
    `document.querySelector('[role="log"]')?.textContent.includes('事件本地回复 2') && Boolean(document.querySelector('[aria-label="发送消息"]'))`,
    '第二次模型回复'
  )
  await queryNode(desktop)
  assert.equal((await facts(desktop, subscriber)).submits.length, 2)
  assert.equal((await facts(desktop, subscriber)).node.accepted.length, 2)
  assert.equal(desktop.sent.length, 2, '不能隐式重发')
  assert.equal(mobile.sent.length, 0)
  results.push(
    'E03 两条真实发送入口各一次 accepted，Browser/Node/实际响应 Source 与 tempId 一致，模型未完成即接管，另页无结果'
  )
}

async function deleteFocused(page, sessions) {
  stage = 'E01 删除当前绑定'
  await click(page, testId('sidebar-mode-sessions'))
  await select(page, workA, sessions[2])
  const beforeDelete = (await facts(page)).contexts.length
  await click(page, testId(`work-session-delete-${workA}`))
  await wait(
    page,
    `!document.querySelector(${JSON.stringify(testId(`work-session-row-${workA}`))})`,
    '删除工作会话'
  )
  await click(page, testId(`work-session-row-${workB}`))
  await expectContext(page, workB, sessions[1])
  const value = await facts(page, publisher, workB)
  const afterDelete = value.contexts.slice(beforeDelete)
  assert.ok(afterDelete.length > 0)
  assert.ok(
    afterDelete.every((context) => context === null || context.source.workId === workB),
    '删除后不能复用旧 Source'
  )
  assert.ok(value.sidebarDisposes.every((dispose) => dispose.aborted))
  results.push('E01 删除当前绑定后转向有效会话，不复用已删除 Source')
}

async function main() {
  let server, browser, modelServer, modelPort, cdpPort
  let failure
  const cleanupErrors = []
  try {
    await mkdir(runRoot, { recursive: true })
    modelPort = await reservePort()
    modelServer = createServer(async (request, response) => {
      try {
        assert.equal(request.url, '/v1/chat/completions')
        let body = ''
        for await (const part of request) body += part
        const input = JSON.parse(body)
        assert.equal(input.model, model)
        requests.push(input)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.flushHeaders()
        chunk(response, { role: 'assistant' })
        heldResponses.add(response)
        response.once('close', () => heldResponses.delete(response))
      } catch (error) {
        providerError = String(error)
        response.destroy(error)
      }
    })
    modelServer.listen(modelPort, '127.0.0.1')
    await once(modelServer, 'listening')
    const sessions = await prepareFixture(modelPort)
    const appPort = await reservePort()
    const origin = `http://127.0.0.1:${appPort}`
    server = spawnE2eServer({
      projectRoot,
      agentDir,
      port: appPort,
      development: true,
      nextDirectory: join(buildRoot, 'next'),
      onOutput: (text) => {
        serverOutput = (serverOutput + text).slice(-200000)
      }
    })
    await waitForHttp(`${origin}/api/health`, 90000, '事件隔离服务', () => serverOutput)
    await waitForHttp(origin, 120000, '首页开发态编译', () => serverOutput)
    cdpPort = await reservePort()
    browser = spawnEdge(
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      cdpPort,
      join(runRoot, 'browser'),
      '1800,1000',
      ['--edge-skip-compat-layer-relaunch']
    )
    await waitForBrowserReady(browser, cdpPort)
    const desktop = await openPage(cdpPort, origin, false)
    if (scenario === 'all' || scenario === 'E01') {
      await bounded(e01(desktop, sessions), 'E01 场景', 180000)
    }
    if (scenario !== 'E01') {
      const mobile = await openPage(cdpPort, origin, true)
      assert.notEqual(desktop.clientId, mobile.clientId)
      if (scenario === 'all' || scenario === 'E02') {
        await bounded(e02(desktop, mobile, sessions), 'E02 场景', 180000)
      }
      if (scenario === 'E03') await select(mobile, workA, sessions[2], true)
      if (scenario === 'all' || scenario === 'E03') {
        await bounded(e03(desktop, mobile, sessions), 'E03 场景', 180000)
      }
    }
    for (const page of pages) {
      assert.deepEqual((await facts(page, subscriber)).errors, [])
      assert.deepEqual((await facts(page, publisher)).errors, [])
    }
    if (scenario === 'all' || scenario === 'E01') {
      await bounded(deleteFocused(desktop, sessions), 'E01 删除场景', 60000)
    }
    assert.equal(providerError, undefined)
    for (const page of pages) assert.deepEqual(page.errors, [], '页面无未处理异常')
  } catch (error) {
    failure = error
    for (const [index, page] of pages.entries()) {
      page.interactions = await bounded(
        evaluate(page, 'window.__eventInputTrace ?? []'),
        '输入诊断',
        5000
      ).catch(() => [])
      await bounded(
        screenshot(page).then((bytes) =>
          writeFile(join(runRoot, `failure-page-${index}.png`), bytes)
        ),
        '失败截图',
        5000
      ).catch(() => undefined)
    }
  } finally {
    for (const page of pages) page.close()
    const cleanup = async (operation) => {
      try {
        await operation()
      } catch (error) {
        cleanupErrors.push(String(error))
      }
    }
    await cleanup(() => stopBrowserTree(browser, cdpPort))
    if (server) await cleanup(() => stopE2eServerTree(server))
    for (const response of heldResponses) response.destroy()
    if (modelServer)
      await cleanup(async () => {
        modelServer.closeAllConnections()
        await bounded(
          new Promise((resolveClose, reject) =>
            modelServer.close((error) => (error ? reject(error) : resolveClose()))
          ),
          '关闭本地模型'
        )
        await assertPortReleased(modelPort)
      })
    await mkdir(runRoot, { recursive: true })
    await writeFile(join(runRoot, 'server.log'), serverOutput)
    await writeFile(
      join(runRoot, 'result.json'),
      JSON.stringify(
        {
          scenario,
          stage,
          results,
          failure: failure?.stack,
          cleanupErrors,
          providerError,
          requests,
          pages: pages.map((page) => ({
            sent: page.sent,
            received: page.received,
            errors: page.errors,
            interactions: page.interactions
          })),
          resourcesReleased: cleanupErrors.length === 0
        },
        null,
        2
      )
    )
    if (!failure && cleanupErrors.length === 0) {
      for (const directory of [fixtureRoot, buildRoot, runRoot])
        await rm(directory, { recursive: true, force: true })
    }
  }
  if (failure || cleanupErrors.length) {
    console.error(`失败阶段：${stage}；现场：${runRoot}`)
    throw new AggregateError([failure, ...cleanupErrors].filter(Boolean), '插件事件 E2E 失败')
  }
  console.log(results.join('\n'))
  console.log('浏览器、服务进程树和端口已释放；隔离数据已清理。')
}

await main()
