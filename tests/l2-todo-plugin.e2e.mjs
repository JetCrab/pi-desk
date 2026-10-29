import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { assertPortReleased, spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const taskId = `todo-${process.pid}`
const agentDir = join(root, 'temp/pi/todo-plugin', taskId, 'agent')
const runDir = join(root, 'temp/run/todo-plugin', taskId)
const artifact = resolve(process.env.TODO_PLUGIN_ARTIFACT ?? join(root, 'plugins/pi-desk-todo'))
const pluginDir = join(agentDir, 'extensions/todo')
const cwd = join(runDir, 'project')
const exec = promisify(execFile)
const works = ['todo-work-one', 'todo-work-two']
const clients = []
let server
let browser
let debugPort
let log = ''
const passed = []
const entryIds = []
const scope = process.env.TODO_E2E_SCOPE ?? 'all'
const delay = (ms) => new Promise((finish) => setTimeout(finish, ms))
const todo = {
  title: '接口迁移',
  items: [
    { id: 'prepare', title: '梳理接口与依赖', status: 2 },
    { id: 'client', title: '客户端迁移', status: 2 },
    {
      id: 'backend',
      title: '后台迁移',
      status: 1,
      note: '4452139 源码与前端资源已冻结，独立 release 构建中，完成后对比依赖树与制品体积'
    },
    { id: 'sales', title: '销售端迁移', status: 3, note: '等待确认旧接口兼容范围' },
    { id: 'verify', title: '验证与交付', status: 0 }
  ]
}
async function freePort() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const value = listener.address().port
  await new Promise((finish) => listener.close(finish))
  return value
}
async function http(url, timeout = 90000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {}
    await delay(100)
  }
  throw Error('服务未就绪：' + url + '\n' + log.slice(-6000))
}
async function fixture() {
  await mkdir(pluginDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  await cp(join(artifact, 'dist'), join(pluginDir, 'dist'), { recursive: true })
  const manifest = JSON.parse(await readFile(join(artifact, 'package.json'), 'utf8'))
  manifest.pi = { extensions: ['./fixture-native.mjs'] }
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify(manifest))
  await writeFile(
    join(pluginDir, 'fixture-native.mjs'),
    `import todo from './dist/index.js'
export default function(pi) {
  let definition
  const proxy=new Proxy(pi,{get(target,key){if(key==='registerTool')return tool=>{definition=tool;target.registerTool(tool)};return Reflect.get(target,key)}})
  todo(proxy)
  pi.registerCommand('todo-fixture',{
    description:'仅供隔离测试登记进度',
    async handler(args,ctx){await definition.execute('fixture-todo',JSON.parse(args),new AbortController().signal,undefined,ctx)}
  })
}`
  )
  const entry = join(pluginDir, 'dist/browser/entry.js')
  await cp(entry, join(pluginDir, 'dist/browser/actual-entry.js'))
  await writeFile(
    entry,
    `import activate from './actual-entry.js';export default function(plugin){const dispose=activate(plugin);window.__todoHost=plugin.host;window.__todoReady=true;return ()=>{window.__todoReady=false;dispose?.()}}`
  )
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [] }))
  await writeFile(
    join(agentDir, 'pi-desk-settings.json'),
    JSON.stringify({ region: { locale: 'zh-CN', timeZone: 'UTC' } })
  )
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const sessions = []
  for (let index = 0; index < 2; index++) {
    const manager = SessionManager.create(cwd)
    manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '请迁移接口并反馈实际进度。' }],
      timestamp: Date.now()
    })
    manager.appendMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: '客户端已经验证。后台迁移继续处理，销售端等待确认兼容范围。' }
      ],
      api: 'openai-responses',
      provider: 'test',
      model: 'fixture',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'stop',
      timestamp: Date.now()
    })
    manager.appendSessionInfo(`Todo验收${index + 1}`)
    entryIds.push(manager.getBranch()[0].id)
    sessions.push({ workId: works[index], cwd, sessionId: manager.getSessionId() })
  }
  await writeFile(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({ workSessions: sessions, pinnedCount: 0 })
  )
}
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.id = 0
    this.pending = new Map()
    this.errors = []
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.method === 'Runtime.exceptionThrown')
        this.errors.push(
          message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text
        )
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(Error(message.error.message))
      else request.finish(message.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((finish, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Error('CDP超时：' + method))
      }, 60000)
      this.pending.set(id, { finish, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails)
      throw Error(result.exceptionDetails.exception?.description ?? '页面执行失败')
    return result.result.value
  }
  async wait(expression, label, timeout = 60000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await this.eval(`Boolean(${expression})`)) return
      await delay(80)
    }
    throw Error(label + '超时\n' + (await this.eval('document.body.innerText.slice(0,5000)')))
  }
  async point(selector) {
    const end = Date.now() + 5000
    let prior = ''
    let stable = 0
    while (Date.now() < end) {
      const hit = await this.eval(
        `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,width:r.width,height:r.height,ok:el.contains(document.elementFromPoint(x,y))}})()`
      )
      const key = JSON.stringify(hit)
      stable = key === prior ? stable + 1 : 0
      prior = key
      if (hit?.ok && stable >= 2) return { x: hit.x, y: hit.y }
      await this.eval('new Promise(resolve=>requestAnimationFrame(resolve))')
    }
    throw Error('目标被遮挡或不稳定：' + selector + ' ' + prior)
  }
  async click(selector) {
    const point = await this.point(selector)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point
    })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point
    })
  }
  async hover(selector) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...(await this.point(selector))
    })
  }
  async key(key, code, virtualKey) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: virtualKey
    })
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: virtualKey
    })
  }
  async size(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    })
    await this.eval(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
    )
  }
  async screenshot(name) {
    await this.eval(
      `document.querySelectorAll('nextjs-portal').forEach(element=>{element.style.display='none'})`
    )
    await this.eval(`(async()=>{
      const deadline=performance.now()+10000;
      while(performance.now()<deadline){
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const active=document.getAnimations().filter(animation=>animation.playState==='running'&&animation.effect?.getTiming().iterations!==Infinity);
        if(!active.length)return;
        let timer;
        try{
          await Promise.race([
            Promise.allSettled(active.map(animation=>animation.finished)),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('截图动画未结束')),Math.max(1,deadline-performance.now()))})
          ]);
        }finally{clearTimeout(timer)}
      }
      throw new Error('截图界面未稳定');
    })()`)

    const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(join(runDir, name), Buffer.from(image.data, 'base64'))
  }
  close() {
    for (const request of this.pending.values()) clearTimeout(request.timer)
    this.socket.close()
  }
}
async function page(url) {
  const target = await (
    await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })
  ).json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  const client = new Cdp(socket)
  clients.push(client)
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('pi-super:locale','zh-CN');localStorage.setItem('pi-super-theme','dark')`
  })
  await client.size(1080, 1000)
  await client.send('Page.navigate', { url })
  await client.wait(
    `window.__todoReady && document.querySelector('[data-testid="work-session-row-${works[0]}"]')`,
    '页面与插件就绪',
    120000
  )
  await client.click(`[data-testid="work-session-row-${works[0]}"]`)
  await client.wait(
    `document.querySelector('[data-pi-desk-plugin="todo"][data-pi-desk-kind="widget"]')`,
    '挂件挂载'
  )
  await client.wait(
    `window.__todoHost.workSessions.getSnapshot().some(item=>item.source.workId==='${works[0]}')`,
    '工作会话就绪'
  )
  return client
}
async function source(client) {
  return client.eval(
    `window.__todoHost.workSessions.getSnapshot().find(item=>item.source.workId==='${works[0]}').source`
  )
}
async function reload(url, currentSource) {
  const socket = new WebSocket(
    `${url.replace('http:', 'ws:')}api/ws?clientId=${randomUUID()}`,
    'pi-desk.v1'
  )
  async function rpc(path, body = {}) {
    const requestId = randomUUID()
    let listener
    let timer
    try {
      const result = await new Promise((finish, reject) => {
        timer = setTimeout(() => reject(Error(path + '超时')), 45000)
        listener = (raw) => {
          const frame = JSON.parse(raw.toString())
          if (frame.head?.op === 'resp' && frame.head.requestId === requestId) finish(frame.body)
        }
        socket.on('message', listener)
        socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
      })
      assert.equal(result.code, 0, `${path}: ${result.msg}`)
      return result.data
    } finally {
      clearTimeout(timer)
      socket.off('message', listener)
    }
  }
  try {
    await once(socket, 'open')
    await rpc('work-sessions/list')
    await rpc('chat/reload', { source: currentSource })
  } finally {
    socket.close()
    await once(socket, 'close')
  }
}
async function method(client, name) {
  return client.eval(
    `window.__todoHost.piDesk.invokeSession(window.__todoHost.workSessions.getSnapshot().find(item=>item.source.workId==='${works[0]}').source,${JSON.stringify(name)},{})`
  )
}
async function register(client, value) {
  await client.eval(
    `window.__todoHost.pi.commands.execute(window.__todoHost.workSessions.getSnapshot().find(item=>item.source.workId==='${works[0]}').source,'todo-fixture',${JSON.stringify(JSON.stringify(value))})`
  )
  await client.wait(`document.querySelector('[data-testid="todo-widget"]')`, '登记后显示Todo')
}
async function bounds(client) {
  await client.wait(
    `(()=>{const panel=document.querySelector('[data-testid="todo-popover"]');if(!panel)return true;const popup=panel.closest('[role="dialog"]');if(popup?.getAnimations().some(a=>a.playState==='running'))return false;const key=JSON.stringify(panel.getBoundingClientRect().toJSON());const old=window.__todoBounds;window.__todoBounds={key,count:old?.key===key?old.count+1:0};return window.__todoBounds.count>=2})()`,
    '浮层定位和动画稳定',
    5000
  )
  const issues = await client.eval(`(()=>{
    const errors=[];
    const widget=document.querySelector('[data-testid="todo-widget"]');
    const panel=document.querySelector('[data-testid="todo-popover"]');
    const input=document.querySelector('[data-work-id="${works[0]}"] textarea');
    const close=document.querySelector('[data-testid="todo-dismiss"]');
    const row=document.querySelector('[data-testid="todo-summary-row"]');
    if(widget&&row&&close){
      const outer=widget.getBoundingClientRect(),inner=row.getBoundingClientRect(),button=close.getBoundingClientRect();
      if(inner.left-outer.left<6||outer.right-inner.right<6)errors.push('摘要左右缺少留白');
      if(button.left<inner.left||button.right>=inner.right||button.top<inner.top||button.bottom>inner.bottom)errors.push('关闭按钮未内嵌于摘要背景');
      if(['transparent','rgba(0, 0, 0, 0)'].includes(getComputedStyle(row).backgroundColor))errors.push('摘要与关闭按钮缺少共享背景');
    }
    if(widget){const r=widget.getBoundingClientRect();if(r.left<0||r.right>innerWidth+1)errors.push('摘要越界');if(input&&r.bottom>input.getBoundingClientRect().top)errors.push('摘要挡住输入框')}
    if(panel){const r=panel.getBoundingClientRect();if(r.left<0||r.right>innerWidth+1||r.top<0)errors.push('浮层越界');if(input&&r.bottom>input.getBoundingClientRect().top)errors.push('浮层挡住输入框')}
    if(panel&&row){
      const p=panel.getBoundingClientRect(),r=row.getBoundingClientRect();
      const max=parseFloat(getComputedStyle(document.documentElement).fontSize)*40;
      if(Math.abs(p.left+p.right-r.left-r.right)>2)errors.push('浮层未与摘要居中');
      if(Math.abs(p.width-Math.min(max,r.width))>3)errors.push('浮层宽度未跟随摘要或超过40rem');
    }
    if(close){const r=close.getBoundingClientRect();if(!close.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))errors.push('关闭按钮被遮挡')}
    return errors
  })()`)
  assert.deepEqual(issues, [])
}
try {
  await fixture()
  const port = await freePort()
  debugPort = await freePort()
  server = spawnE2eServer({
    projectRoot: root,
    agentDir,
    port,
    development: true,
    nextDirectory: join(root, 'temp/build/todo-plugin', taskId, 'next'),
    onOutput: (text) => {
      log += text
    }
  })
  const url = `http://127.0.0.1:${port}/`
  await http(url + 'api/health')
  browser = spawn(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${join(runDir, 'browser')}`,
      'about:blank'
    ],
    { stdio: 'ignore', windowsHide: true }
  )
  await http(`http://127.0.0.1:${debugPort}/json/list`)
  const first = await page(url)
  assert.deepEqual(await method(first, 'get'), { todo: null, hidden: false })
  assert.equal(
    await first.eval(`document.querySelectorAll('[data-testid="todo-widget"]').length`),
    0
  )
  const second = await page(url)
  await first.send('Page.bringToFront')
  if (scope !== 'lifecycle') {
    await register(first, todo)
    await second.wait(`document.querySelector('[data-testid="todo-widget"]')`, '另一页面收到登记')
    assert.equal(
      await first.eval(`document.querySelectorAll('[data-testid="todo-widget"]').length`),
      1
    )
    for (const client of [first, second]) {
      await client.wait(
        `document.querySelector('[data-testid="todo-summary"]')?.textContent.includes('2/5')`,
        '初始进度同步'
      )
      assert.equal(
        await client.eval(`Boolean(document.querySelector('[data-testid="todo-popover"]'))`),
        false,
        '登记进度不自动打开浮层'
      )
    }
    await bounds(first)
    await first.screenshot('summary-dark.png')
    passed.push('E01：真实Native工具全量登记，单份摘要和多端同步，不自动打开浮层')

    const updated = structuredClone(todo)
    updated.items.find((item) => item.id === 'backend').status = 2
    const before = await first.eval(
      `document.querySelector('[data-testid="todo-widget"]').getBoundingClientRect().top`
    )
    await first.eval(`document.querySelector('[data-work-id="${works[0]}"] textarea').focus()`)
    await register(first, updated)
    for (const client of [first, second]) {
      await client.wait(
        `document.querySelector('[data-testid="todo-summary"]')?.textContent.includes('3/5')`,
        '最新进度同步'
      )
      assert.equal(
        await client.eval(`Boolean(document.querySelector('[data-testid="todo-popover"]'))`),
        false,
        '更新进度不自动打开浮层'
      )
    }
    assert.equal(
      await first.eval(
        `document.activeElement===document.querySelector('[data-work-id="${works[0]}"] textarea')`
      ),
      true,
      '进度更新不抢输入焦点'
    )
    await first.hover('[data-testid="todo-summary"]')
    await first.wait(`document.querySelector('[data-testid="todo-popover"]')`, '悬停任务列表')
    await first.wait(
      `document.querySelector('[data-testid="todo-popover"]').textContent.includes('等待确认旧接口兼容范围')`,
      '任务状态与原因'
    )
    assert.equal(
      await first.eval(
        `document.querySelectorAll('[data-testid="todo-popover"] [data-todo-id]').length`
      ),
      5
    )
    assert.equal(
      await first.eval(
        `document.querySelector('[data-testid="todo-summary"]').textContent.includes('3/5')`
      ),
      true,
      '完成数按单层任务计算'
    )
    assert.equal(
      await first.eval(
        `document.querySelector('[data-testid="todo-widget"]').getBoundingClientRect().top`
      ),
      before
    )
    await bounds(first)
    await first.screenshot('list-dark.png')
    await first.click('[data-testid="todo-summary"]')
    await first.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
    assert.equal(
      await first.eval(`Boolean(document.querySelector('[data-testid="todo-popover"]'))`),
      true,
      '点击后移开鼠标仍保持详情展开'
    )
    const runningAgain = structuredClone(updated)
    runningAgain.items.find((item) => item.id === 'backend').status = 1
    await register(first, runningAgain)
    await first.wait(
      `document.querySelector('[data-testid="todo-popover"] [data-todo-id="backend"]')?.getAttribute('data-status')==='1'`,
      '展开中的详情实时更新'
    )
    await first.key('Escape', 'Escape', 27)
    await first.wait(`!document.querySelector('[data-testid="todo-popover"]')`, 'Escape关闭详情')
    await first.wait(
      `document.activeElement===document.querySelector('[data-testid="todo-summary"]')`,
      'Escape后焦点回到摘要触发按钮',
      5000
    )
    await first.eval(`document.querySelector('[data-work-id="${works[0]}"] textarea').focus()`)
    const completed = {
      ...todo,
      items: todo.items.map(({ id, title }) => ({ id, title, status: 2 }))
    }
    await register(first, completed)
    for (const client of [first, second]) {
      await client.wait(
        `(()=>{const text=document.querySelector('[data-testid="todo-summary"]')?.textContent;return text?.includes('全部完成')&&text.includes('5/5')})()`,
        '全部完成状态同步'
      )
      assert.equal(
        await client.eval(`Boolean(document.querySelector('[data-testid="todo-popover"]'))`),
        false,
        '完成进度不自动打开浮层，关闭后的详情不重开'
      )
    }
    assert.equal(
      await first.eval(
        `document.activeElement===document.querySelector('[data-work-id="${works[0]}"] textarea')`
      ),
      true,
      '查看详情后的进度更新仍保持输入焦点'
    )
    passed.push(
      'E02：进度和完成状态静默更新、hover详情、点击保持、展开中实时更新、Escape回焦，后续更新不重开浮层或抢焦点'
    )

    if (scope !== 'focus') {
      await first.click('[data-testid="todo-dismiss"]')
      await first.wait(`!document.querySelector('[data-testid="todo-widget"]')`, '关闭展示')
      await second.wait(
        `!document.querySelector('[data-testid="todo-widget"]')`,
        '其他页面同步隐藏'
      )
      assert.deepEqual(await method(first, 'get'), { todo: completed, hidden: true })
      await first.send('Page.reload')
      await first.wait(
        `window.__todoReady && document.querySelector('[data-pi-desk-plugin="todo"][data-pi-desk-kind="widget"]')`,
        '页面刷新恢复挂载'
      )
      assert.deepEqual(await method(first, 'get'), { todo: completed, hidden: true })
      assert.equal(
        await first.eval(`document.querySelectorAll('[data-testid="todo-widget"]').length`),
        0
      )
      const replacement = {
        title: '结果交付',
        items: [{ id: 'final', title: '整理交付结果', status: 1 }]
      }
      await register(first, replacement)
      await second.wait(
        `document.querySelector('[data-testid="todo-widget"]')`,
        '再次登记其他页面显示'
      )
      assert.deepEqual(await method(first, 'get'), { todo: replacement, hidden: false })
      assert.equal(
        await first.eval(`document.querySelectorAll('[data-testid="todo-widget"]').length`),
        1
      )
      passed.push('E03：×关闭保留内存，两页面及刷新保持隐藏，新登记替换并重新显示')
    }
  } else {
    await register(first, {
      title: '结果交付',
      items: [{ id: 'final', title: '整理交付结果', status: 1 }]
    })
  }

  if (scope !== 'focus') {
    await first.click(`[data-testid="work-session-row-${works[1]}"]`)
    await first.wait(
      `document.querySelector('[data-work-id="${works[1]}"] textarea')`,
      '切换另一个会话'
    )
    await first.wait(`!document.querySelector('[data-testid="todo-widget"]')`, '其他会话不继承Todo')
    await first.click(`[data-testid="work-session-row-${works[0]}"]`)
    await first.wait(`document.querySelector('[data-testid="todo-widget"]')`, '切回保留内存')
    const previousSource = await source(first)
    const response = await fetch(url + 'api/work-sessions/branch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pi-Desk-Client-Id': randomUUID(),
        Origin: url.slice(0, -1)
      },
      body: JSON.stringify({
        workId: works[0],
        sessionId: previousSource.sessionId,
        entryId: entryIds[0],
        action: 'tree'
      })
    })
    const branchResult = await response.json()
    assert.equal(branchResult.code, 0, branchResult.msg)
    await first.wait(
      `window.__todoHost.workSessions.getSnapshot().find(item=>item.source.workId==='${works[0]}').source.branchId!==${JSON.stringify(previousSource.branchId)}`,
      '分支Source更新'
    )
    await first.wait(`!document.querySelector('[data-testid="todo-widget"]')`, 'Pi分支切换清空')
    assert.deepEqual(await method(first, 'get'), { todo: null, hidden: false })
    passed.push('E04：普通会话切换不串数据，Pi树导航清空且不从历史恢复')

    await register(first, todo)
    await reload(url, await source(first))
    await first.wait(`!document.querySelector('[data-testid="todo-widget"]')`, '会话reload清空Todo')
    assert.deepEqual(await method(first, 'get'), { todo: null, hidden: false })
    assert.deepEqual(await method(second, 'get'), { todo: null, hidden: false })
    passed.push('E06：真实会话reload重建扩展，两个页面get均为空且不从历史恢复')

    await register(first, todo)
    await first.size(390, 900)
    await first.click('[data-testid="todo-summary"]')
    await first.wait(`document.querySelector('[data-testid="todo-popover"]')`, '移动端点击展开')
    await bounds(first)
    await first.screenshot('mobile-dark.png')
    await first.eval(
      `localStorage.setItem('pi-super-theme','light');window.dispatchEvent(new StorageEvent('storage',{key:'pi-super-theme',newValue:'light'}))`
    )
    await first.screenshot('mobile-light.png')
    await first.size(300, 900)
    await first.eval(
      `document.documentElement.style.fontSize='150%';new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`
    )
    await bounds(first)
    await first.screenshot('narrow-zoom-light.png')
    await register(first, {
      ...todo,
      items: [
        ...todo.items.slice(0, -1),
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `check-${index}`,
          title: `检查接口 ${index + 1} 兼容性`,
          status: 0
        })),
        todo.items.at(-1)
      ]
    })
    await first.wait(
      `(()=>{const viewport=document.querySelector('[data-testid="todo-popover"] [data-slot="plugin-scroll-viewport"]');return viewport&&viewport.scrollHeight>viewport.clientHeight})()`,
      '长任务列表确实超出可用高度'
    )
    await first.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...(await first.point('[data-testid="todo-popover"]')),
      deltaX: 0,
      deltaY: 1200
    })
    await first.wait(
      `(()=>{
      const viewport=document.querySelector('[data-testid="todo-popover"] [data-slot="plugin-scroll-viewport"]');
      const item=document.querySelector('[data-testid="todo-popover"] [data-todo-id="verify"]');
      if(!viewport||!item)return false;
      const a=viewport.getBoundingClientRect(),b=item.getBoundingClientRect();
      return viewport.scrollTop>0&&b.top>=a.top&&b.bottom<=a.bottom+1;
    })()`,
      '长任务列表滚动到最后一项',
      5000
    )
    await first.screenshot('narrow-scrolled-light.png')
    await first.click('[data-testid="todo-dismiss"]')
    await first.wait(`!document.querySelector('[data-testid="todo-widget"]')`, '窄屏大字号关闭')
    passed.push('E05：390px、300px＋150%字号、明暗主题，长列表可滚到底，不挡输入且×可点击')
  }
  for (const client of clients) assert.deepEqual(client.errors, [], '浏览器无未处理异常')
  console.log(passed.join('\n'))
} catch (error) {
  process.exitCode = 1
  console.error(error)
  await writeFile(join(runDir, 'failure.txt'), error.stack ?? String(error))
  for (let index = 0; index < clients.length; index++) {
    await writeFile(
      join(runDir, `failure-${index}.json`),
      JSON.stringify(
        await clients[index]
          .eval(
            `({text:document.body.innerText,activeElement:document.activeElement?.outerHTML,rects:['todo-widget','todo-popover','todo-dismiss'].map(id=>({id,rect:document.querySelector('[data-testid="'+id+'"]')?.getBoundingClientRect().toJSON(),ancestors:(()=>{let el=document.querySelector('[data-testid="'+id+'"]');const result=[];while(el&&result.length<5){const s=getComputedStyle(el);result.push({tag:el.tagName,attrs:el.getAttributeNames().map(k=>[k,el.getAttribute(k)]),opacity:s.opacity,visibility:s.visibility,display:s.display});el=el.parentElement}return result})()})),input:document.querySelector('[data-work-id="${works[0]}"] textarea')?.getBoundingClientRect().toJSON()})`
          )
          .catch((error) => ({ error: String(error) })),
        null,
        2
      )
    )
    await clients[index].screenshot(`failure-${index}.png`).catch(() => {})
  }
} finally {
  for (const client of clients) client.close()
  let browserReleased = false
  try {
    if (browser) {
      const tree = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$all=Get-CimInstance Win32_Process;$ids=@(${browser.pid});do{$children=@($all|Where-Object{$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids}|Select-Object -ExpandProperty ProcessId);$ids+=$children}while($children.Count -gt 0);ConvertTo-Json -InputObject @($all|Where-Object{$_.ProcessId -in $ids}|Select-Object ProcessId,Name,CreationDate)`
        ],
        { windowsHide: true }
      )
      const owned = JSON.parse(tree.stdout)
      await exec('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], {
        windowsHide: true
      }).catch(() => {})
      const deadline = Date.now() + 10000
      while (true) {
        try {
          await assertPortReleased(debugPort)
          break
        } catch (error) {
          if (Date.now() > deadline) throw error
          await delay(100)
        }
      }
      const current = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process|Select-Object ProcessId,Name,CreationDate)'
        ],
        { windowsHide: true }
      )
      // Windows可能立即复用PID；只判断本次实际拥有的进程身份。
      const remaining = JSON.parse(current.stdout).filter((item) =>
        owned.some(
          (previous) =>
            previous.ProcessId === item.ProcessId &&
            previous.Name === item.Name &&
            previous.CreationDate === item.CreationDate
        )
      )
      assert.deepEqual(remaining, [])
    }
    browserReleased = true
  } finally {
    if (server) await stopE2eServerTree(server)
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'server.log'), log)
    await writeFile(
      join(runDir, 'result.json'),
      JSON.stringify(
        {
          passed,
          browserErrors: clients.flatMap((c) => c.errors),
          resourcesReleased: browserReleased
        },
        null,
        2
      )
    )
    console.log('验收现场：' + runDir)
  }
}
