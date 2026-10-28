import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { assertPortReleased, spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const taskId = `slots-${process.pid}`
const agentDir = join(projectRoot, 'temp/pi/plugin-session-slots', taskId, 'agent')
const runRoot = join(projectRoot, 'temp/run/plugin-session-slots', taskId)
const fixtureDir = join(agentDir, 'extensions', 'slot-fixture')
const projectDir = join(runRoot, 'slot-project')
const exec = promisify(execFile)
const workIds = ['slot-work-one', 'slot-work-two']
let server
let browser
let cdpPort
let serverLog = ''
const results = []
const delay = (ms) => new Promise((finish) => setTimeout(finish, ms))

async function port() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const value = listener.address().port
  await new Promise((finish) => listener.close(finish))
  return value
}
async function waitHttp(url, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {}
    await delay(150)
  }
  throw new Error(`服务启动超时：${url}\n${serverLog}`)
}
function browserEntry(version) {
  return `export default function (plugin) {
  window.__slotFactoryCount = (window.__slotFactoryCount ?? 0) + 1
  window.__slotVersion = ${version}
  const view = () => import('./view.js')
  plugin.registerWidget('above', { load: () => view().then(m => m.above) })
  plugin.registerWidget('below', { placement: 'belowEditor', load: () => view().then(m => m.below) })
  plugin.registerWidget('empty', { load: () => {
    const view = {
      mount() {
        window.__slotEmptyMounted = true
      }
    }
    if (window.__slotEmptyReady) return Promise.resolve(view)
    return new Promise(resolve => {
      window.__slotResolveEmpty = () => {
        window.__slotEmptyReady = true
        resolve(view)
      }
    })
  } })
  const action = label => ({ type: 'action', icon: {type:'builtin',name:'wrench'}, label,
    async onSelect({source,host,signal}) {
      await host.piDesk.invokeGlobal('action', { workId: source.workId })
      if (!signal.aborted) host.notify({level:'success',title:'按钮已执行'})
    }
  })
  plugin.registerSessionHeaderItem('a-run', {
    inline: {type:'custom',minWidthRem:14,load:()=>view().then(m=>m.run)},
    overflow: {type:'custom',load:()=>view().then(m=>m.run)}
  })
  plugin.registerSessionHeaderItem('b-info', {inline:action('会话信息'),overflow:action('会话信息')})
  plugin.registerSessionHeaderItem('c-check', {inline:action('环境检查'),overflow:action('环境检查')})
  plugin.registerSessionHeaderItem('d-mixed', {inline:action('更多状态'),overflow:{type:'custom',load:()=>view().then(m=>m.info)}})
  plugin.registerSessionHeaderItem('e-custom', {inline:{type:'custom',minWidthRem:5,load:()=>view().then(m=>m.info)},overflow:action('状态详情')})
  plugin.registerSessionHeaderItem('f-empty', {
    inline: {
      type: 'custom',
      minWidthRem: 60,
      load: () => {
        if (window.__slotHeaderReady) return view().then(m => m.emptyHeader)
        return new Promise(resolve => {
          window.__slotResolveHeaderEmpty = () => {
            window.__slotHeaderReady = true
            resolve(view().then(m => m.emptyHeader))
          }
        })
      }
    },
    overflow: { type: 'custom', load: () => view().then(m => m.emptyHeader) }
  })
}
`
}
async function createFixture() {
  await mkdir(join(fixtureDir, 'browser'), { recursive: true })
  await mkdir(projectDir, { recursive: true })
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [] }))
  await writeFile(
    join(agentDir, 'pi-desk-settings.json'),
    JSON.stringify({ region: { locale: 'zh-CN', timeZone: 'UTC' } })
  )
  await writeFile(
    join(fixtureDir, 'package.json'),
    JSON.stringify({
      name: 'slot-fixture',
      version: '1.0.0',
      type: 'module',
      piDesk: { entry: './entry.mjs' }
    })
  )
  await writeFile(
    join(fixtureDir, 'entry.mjs'),
    `export default {
  name:'slot-fixture',
  setup(plugin) {
    let state = {running:false,actions:0,lastWorkId:''}
    plugin.setState(state)
    plugin.registerMethod('toggle', async () => {state={...state,running:!state.running};plugin.setState(state);return state})
    plugin.registerMethod('action', async input => {state={...state,actions:state.actions+1,lastWorkId:input.workId};plugin.setState(state);return state})
    plugin.registerBrowserEntry('./browser/entry.js')
  }
}`
  )
  await writeFile(join(fixtureDir, 'browser/entry.js'), browserEntry(1))
  await writeFile(
    join(fixtureDir, 'browser/view.js'),
    `
function observe(container,target,signal,render) {
  const key = target.kind+':'+(target.presentation ?? 'widget')+':'+target.source.workId
  window.__slotMounts ??= {}
  window.__slotDisposes ??= {}
  window.__slotMounts[key]=(window.__slotMounts[key]??0)+1
  const root=document.createElement('div')
  root.dataset.fixtureSource=target.source.workId
  root.style.cssText='color:inherit;font:inherit;min-width:0;max-width:100%'
  container.append(root)
  const cleanup=render(root)
  return () => {
    window.__slotDisposes[key]=(window.__slotDisposes[key]??0)+1
    if (!signal.aborted) window.__slotCleanupWithoutAbort=true
    cleanup?.()
    root.remove()
  }
}
function widget(position) {
 return {mount({container,target,host,signal}) {
  return observe(container,target,signal,root=>{
    root.dataset.testid='fixture-widget-'+position
    root.style.cssText+=';padding:4px 8px;font-size:.75rem;line-height:1.6;overflow-wrap:anywhere'
    const render=()=>{const state=host.globalState.getSnapshot();root.textContent=(position==='above'?'上方挂件 · 当前阶段：接口迁移':'下方挂件 · 环境就绪')+' · 操作 '+(state?.actions??0)}
    const stop=host.globalState.subscribe(render)
    render()
    return stop
  })
 }}
}
export const above=widget('above')
export const below=widget('below')
export const run={mount({container,target,host,signal}) {
 return observe(container,target,signal,root=>{
  const button=document.createElement('button')
  button.type='button'
  button.dataset.testid='fixture-run-'+target.presentation
  button.style.cssText='display:flex;align-items:center;gap:8px;max-width:100%;min-width:0;min-height:28px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--muted);color:inherit;font:inherit;white-space:normal;overflow-wrap:anywhere'
  const render=()=>{
    const running=host.globalState.getSnapshot()?.running===true
    button.setAttribute('aria-label',running?'停止模拟项目':'运行模拟项目')
    button.textContent=(running?'■ 停止模拟项目 · 运行中':'▷ 运行模拟项目 · 环境就绪')
  }
  const click=async()=>{button.disabled=true;try{await host.piDesk.invokeGlobal('toggle',{})}finally{if(!signal.aborted)button.disabled=false}}
  button.addEventListener('click',click)
  root.append(button)
  const stop=host.globalState.subscribe(render)
  render()
  return ()=>{stop();button.removeEventListener('click',click)}
 })
}}
export const emptyHeader = {
  mount({ container, target }) {
    const root = document.createElement('div')
    root.dataset.testid = 'fixture-header-empty-' + target.presentation
    container.append(root)
    const setContent = text => {
      root.textContent = text
    }
    window.__slotSetHeaderContent = setContent
    window.__slotHeaderMountCount = (window.__slotHeaderMountCount ?? 0) + 1
    return () => {
      if (window.__slotSetHeaderContent === setContent) delete window.__slotSetHeaderContent
      root.remove()
    }
  }
}
export const info={mount({container,target,signal}) {
 return observe(container,target,signal,root=>{
   root.textContent='自定义信息'
   root.style.cssText+=';padding:4px 8px;font-size:.75rem'
 })
}}
`
  )
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const records = []
  for (let index = 0; index < 2; index += 1) {
    const session = SessionManager.create(projectDir)
    session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '验证插件插槽，不调用模型。' }],
      timestamp: Date.now()
    })
    session.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '输入区挂件与标题操作分别显示；项目运行仅为状态模拟。' }],
      api: 'openai-responses',
      provider: 'test',
      model: 'test-model',
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
    session.appendSessionInfo(`插槽会话${index + 1}`)
    records.push({ workId: workIds[index], cwd: projectDir, sessionId: session.getSessionId() })
  }
  await writeFile(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({ workSessions: records, pinnedCount: 0 })
  )
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.id = 1
    this.pending = new Map()
    this.clientId = null
    this.errors = []
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.method === 'Network.webSocketCreated' && message.params.url.includes('/api/ws?'))
        this.clientId = new URL(message.params.url).searchParams.get('clientId')
      if (message.method === 'Runtime.exceptionThrown')
        this.errors.push(
          message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text
        )
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error.message))
      else request.finish(message.result)
    })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((finish, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('CDP超时：' + method))
      }, 30000)
      this.pending.set(id, { finish, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  close() {
    for (const request of this.pending.values()) clearTimeout(request.timer)
    this.socket.close()
  }
}
async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.exceptionDetails)
    throw new Error(response.exceptionDetails.exception?.description ?? '页面执行失败')
  return response.result.value
}
async function wait(client, expression, label, timeout = 60000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await evaluate(client, `Boolean(${expression})`)) return
    await delay(100)
  }
  throw new Error(
    label +
      '超时\n' +
      (await evaluate(client, 'document.body.innerText.slice(0,7000)')) +
      '\n' +
      serverLog.slice(-6000)
  )
}
async function click(client, selector) {
  const diagnostic = await evaluate(
    client,
    `(async()=>{
      const describe=e=>e?{tag:e.tagName,label:e.getAttribute('aria-label'),testId:e.getAttribute('data-testid')}:null;
      const e=document.querySelector(${JSON.stringify(selector)});
      if(!e)throw new Error('找不到按钮：'+${JSON.stringify(selector)});
      e.scrollIntoView({block:'nearest'});
      const deadline=performance.now()+5000;
      let previous='';
      let stableFrames=0;
      let r;
      while(stableFrames<4){
        await new Promise(resolve=>requestAnimationFrame(resolve));
        r=e.getBoundingClientRect();
        const rect=JSON.stringify([r.x,r.y,r.width,r.height]);
        const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        const actionable=e.isConnected&&r.width>0&&r.height>0&&!e.disabled&&e.contains(hit);
        stableFrames=actionable?(rect===previous?stableFrames+1:1):0;
        previous=rect;
        if(performance.now()>deadline)throw new Error('点击目标未稳定或被遮挡：'+${JSON.stringify(selector)});
      }
      const point={x:r.x+r.width/2,y:r.y+r.height/2};
      window.__slotClickEvents=[];
      window.__slotClickObserver?.abort();
      const controller=new AbortController();
      window.__slotClickObserver=controller;
      for(const type of ['pointerdown','click'])document.addEventListener(type,event=>{
        window.__slotClickEvents.push({type,target:describe(event.target),button:describe(event.target.closest('button'))});
      },{capture:true,signal:controller.signal});
      return {point,rect:{x:r.x,y:r.y,width:r.width,height:r.height},target:describe(e),hit:describe(document.elementFromPoint(point.x,point.y))};
    })()`
  )
  console.log('点击诊断：' + JSON.stringify({ selector, ...diagnostic }))
  const point = diagnostic.point
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...point
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...point
  })
  console.log(
    '点击事件：' +
      JSON.stringify({ selector, events: await evaluate(client, 'window.__slotClickEvents') })
  )
}
async function viewport(client, width, height) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluate(
    client,
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
  )
}
async function capture(client, name) {
  await wait(
    client,
    `!Array.from(document.querySelectorAll('[data-pi-desk-toast]')).some(e=>e.textContent.includes('按钮已执行'))`,
    '截图前测试通知正常退出',
    10000
  )
  await evaluate(
    client,
    `(async()=>{
      let timer;
      const settled=(async()=>{
        while(true){
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          const animations=document.getAnimations().filter(animation=>
            (animation.playState==='running'||animation.pending)&&
            Number.isFinite(animation.effect?.getComputedTiming().endTime)
          );
          if(!animations.length)return;
          await Promise.all(animations.map(animation=>animation.finished.catch(()=>{})));
        }
      })();
      try{
        await Promise.race([settled,new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('截图前有限动画未在截止时间内完成')),10000);
        })]);
      }finally{clearTimeout(timer)}
    })()`
  )
  await evaluate(
    client,
    'document.querySelectorAll("nextjs-portal").forEach(e=>{e.style.display="none"})'
  )
  const image = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(join(runRoot, name), Buffer.from(image.data, 'base64'))
}
async function api(client, path, body) {
  assert.ok(client.clientId, '页面clientId已建立')
  return evaluate(
    client,
    `fetch(${JSON.stringify('/api/' + path)},{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':${JSON.stringify(client.clientId)}},body:JSON.stringify(${JSON.stringify(body)})}).then(async r=>({status:r.status,body:await r.json()}))`
  )
}
async function selectSession(client, index) {
  await click(client, `[data-testid="work-session-row-${workIds[index]}"]`)
  await wait(
    client,
    `document.querySelector('[data-testid="fixture-widget-above"][data-fixture-source="${workIds[index]}"]')`,
    '切换会话挂件'
  )
}
async function assertBounds(client) {
  const result = await evaluate(
    client,
    `(()=>{
    const column=document.querySelector('[data-work-id="${workIds[0]}"]');
    if(!column)return ['会话列缺失'];
    const r=column.getBoundingClientRect();
    const errors=[];
    const header=column.querySelector('header');
    if(header.scrollWidth>header.clientWidth+1)errors.push('标题横向溢出');
    const plugin=column.querySelector('[data-testid="session-header-items"]');
    if(plugin){const p=plugin.getBoundingClientRect();if(p.right>r.right+1)errors.push('标题项越界')}
    const more=document.querySelector('[data-testid="session-header-overflow"]');
    if(more){const m=more.getBoundingClientRect();if(m.left<0||m.right>innerWidth+1)errors.push('更多浮层越界')}
    return errors;
  })()`
  )
  assert.deepEqual(result, [])
}

let client
try {
  await createFixture()
  const appPort = await port()
  cdpPort = await port()
  console.time('隔离服务启动')
  server = spawnE2eServer({
    projectRoot,
    agentDir,
    port: appPort,
    development: true,
    nextDirectory: join(projectRoot, 'temp/build/pi-desk', taskId),
    onOutput: (text) => {
      serverLog += text
    }
  })
  await waitHttp(`http://127.0.0.1:${appPort}/api/health`, 90000)
  console.timeEnd('隔离服务启动')
  console.time('首页开发态编译')
  await waitHttp(`http://127.0.0.1:${appPort}/`, 120000)
  console.timeEnd('首页开发态编译')
  browser = spawn(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${join(runRoot, 'browser')}`,
      'about:blank'
    ],
    { stdio: 'ignore', windowsHide: true }
  )
  const target = (await (await waitHttp(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find(
    (item) => item.type === 'page'
  )
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  client = new CdpClient(socket)
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Network.enable')
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('pi-super:locale','zh-CN');localStorage.setItem('pi-super-theme','light');`
  })
  await viewport(client, 1600, 1000)
  await client.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` })
  await wait(
    client,
    `document.querySelector('[data-testid="work-session-row-${workIds[0]}"]')`,
    '工作会话列表',
    120000
  )
  await selectSession(client, 0)
  await wait(
    client,
    `document.querySelector('[data-testid="fixture-widget-below"]') && document.querySelector('[data-testid="fixture-run-inline"]')`,
    '上下挂件与标题自定义视图'
  )
  await wait(client, `typeof window.__slotResolveEmpty === 'function'`, '空挂件加载开始')
  const loading = await evaluate(
    client,
    `(()=>{const host=document.querySelector('[data-pi-desk-kind="widget"][data-pi-desk-contribution="empty"]').parentElement;return {height:host.getBoundingClientRect().height,text:host.textContent,status:!!host.querySelector('[role="status"]'),mounted:window.__slotEmptyMounted===true}})()`
  )
  assert.deepEqual(loading, { height: 0, text: '', status: false, mounted: false })
  await capture(client, 'widgets-loading-light.png')
  results.push('E00：挂件加载中无加载提示，宿主整体零高度')
  await evaluate(client, 'window.__slotResolveEmpty()')
  await wait(client, `window.__slotEmptyMounted === true`, '空挂件挂载完成')
  const order = await evaluate(
    client,
    `(()=>{const above=document.querySelector('[data-testid="fixture-widget-above"]').getBoundingClientRect();const below=document.querySelector('[data-testid="fixture-widget-below"]').getBoundingClientRect();const editor=document.querySelector('[data-work-id="${workIds[0]}"] textarea').getBoundingClientRect();const empty=document.querySelector('[data-pi-desk-kind="widget"][data-pi-desk-contribution="empty"]').parentElement;return {above:above.bottom<=editor.top,below:below.top>=editor.bottom,emptyHeight:empty.getBoundingClientRect().height}})()`
  )
  assert.equal(order.above, true)
  assert.equal(order.below, true)
  assert.equal(order.emptyHeight, 0)
  results.push('E01：上下Widget位置正确，空挂件宿主整体无占位')
  await wait(client, `typeof window.__slotResolveHeaderEmpty === 'function'`, '标题空条目开始加载')
  const headerLoading = await evaluate(
    client,
    `(()=>{const header=document.querySelector('[data-testid="plugin-session-header-custom"][data-contribution-name="f-empty"][data-presentation="inline"]');return {outOfFlow:getComputedStyle(header).position==='absolute',hidden:header.getAttribute('aria-hidden')==='true',loading:!!header.querySelector('[role="status"]'),more:!!document.querySelector('[data-testid="session-header-more"]')}})()`
  )
  assert.deepEqual(headerLoading, { outOfFlow: true, hidden: true, loading: false, more: false })
  await capture(client, 'header-loading-light.png')
  results.push('E06：标题自定义项静默加载，无宽度占位且不触发更多')
  await evaluate(client, 'window.__slotResolveHeaderEmpty()')
  await wait(
    client,
    `document.querySelector('[data-testid="fixture-header-empty-inline"]')`,
    '标题空条目挂载完成'
  )
  await viewport(client, 2400, 1000)
  const baselineHeader = await evaluate(
    client,
    `({width:document.querySelector('[data-testid="session-header-items"]').getBoundingClientRect().width,mounts:window.__slotHeaderMountCount})`
  )
  await evaluate(client, `window.__slotSetHeaderContent('临时状态')`)
  await wait(
    client,
    `document.querySelector('[data-testid="plugin-session-header-custom"][data-contribution-name="f-empty"][data-presentation="inline"]').getAttribute('aria-hidden')==='false'`,
    '标题内容出现后参与布局'
  )
  const headerExpansion = await evaluate(
    client,
    `(()=>{const header=document.querySelector('[data-testid="session-header-items"]');return {width:header.getBoundingClientRect().width,expected:60*parseFloat(getComputedStyle(document.documentElement).fontSize)+parseFloat(getComputedStyle(header).columnGap)}})()`
  )
  assert.equal(headerExpansion.width - baselineHeader.width, headerExpansion.expected)
  await evaluate(client, `window.__slotSetHeaderContent('')`)
  await wait(
    client,
    `document.querySelector('[data-testid="session-header-items"]').getBoundingClientRect().width===${baselineHeader.width}`,
    '标题清空后释放宽度与间距'
  )
  assert.equal(await evaluate(client, 'window.__slotHeaderMountCount'), baselineHeader.mounts)
  await viewport(client, 1600, 1000)
  await capture(client, 'header-empty-light.png')
  results.push('E07：标题空内容无宽度和间距，内容出现与清空不重复挂载')
  await click(client, '[aria-label="运行模拟项目"]')
  await wait(client, `document.querySelector('[aria-label="停止模拟项目"]')`, '自定义动态状态')
  await click(client, '[data-testid="session-header-items"] button[aria-label="会话信息"]')
  await wait(
    client,
    `document.querySelector('[data-testid="fixture-widget-above"]').textContent.includes('操作 1')`,
    '普通按钮回调'
  )
  await assertBounds(client)
  await capture(client, 'wide-light.png')
  results.push('E02：平铺图标文字按钮回调一次')

  await viewport(client, 300, 900)
  await wait(client, `document.querySelector('[data-testid="session-header-more"]')`, '300px收纳')
  await click(client, '[data-testid="session-header-more"]')
  await wait(
    client,
    `document.querySelector('[data-testid="fixture-run-overflow"]') && document.querySelector('[data-testid="fixture-header-empty-overflow"]')`,
    '折叠自定义挂载'
  )
  assert.deepEqual(
    await evaluate(
      client,
      `(()=>{const empty=document.querySelector('[data-testid="plugin-session-header-custom"][data-contribution-name="f-empty"][data-presentation="overflow"]');return {outOfFlow:getComputedStyle(empty).position==='absolute',hidden:empty.getAttribute('aria-hidden')==='true',loading:!!document.querySelector('[data-testid="session-header-overflow"] [role="status"]')}})()`
    ),
    { outOfFlow: true, hidden: true, loading: false }
  )
  results.push('E08：更多菜单中的空自定义条目无占位和加载提示')
  assert.equal(
    await evaluate(
      client,
      `document.querySelector('[data-testid="fixture-run-overflow"]').textContent.includes('停止')`
    ),
    true
  )
  await click(client, '[aria-label="停止模拟项目"]')
  await wait(client, `document.querySelector('[aria-label="运行模拟项目"]')`, '折叠状态更新')
  assert.equal(
    await evaluate(client, `!!document.querySelector('[data-testid="session-header-overflow"]')`),
    true,
    '自定义点击不关闭更多'
  )
  await assertBounds(client)
  await capture(client, 'narrow-light.png')
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await wait(
    client,
    `!document.querySelector('[data-testid="fixture-run-overflow"]')`,
    '关闭后释放折叠挂载'
  )
  await click(client, '[data-testid="session-header-more"]')
  await wait(client, `document.querySelector('[data-testid="fixture-run-overflow"]')`, '重新打开')
  assert.equal(
    await evaluate(
      client,
      `document.querySelector('[data-testid="fixture-run-overflow"]').textContent.includes('运行')`
    ),
    true
  )
  await click(client, '[data-testid="session-header-overflow"] button[aria-label="会话信息"]')
  await wait(
    client,
    `document.querySelector('[data-testid="fixture-widget-above"]').textContent.includes('操作 2')`,
    '菜单普通按钮'
  )
  results.push('E03：自定义视图动态更新、折叠重挂保持状态、内部交互不自动关闭')

  await viewport(client, 1600, 1000)
  await wait(client, `document.querySelector('[data-testid="fixture-run-inline"]')`, '恢复宽列')
  await selectSession(client, 1)
  await wait(
    client,
    `!document.querySelector('[data-testid="fixture-widget-above"][data-fixture-source="${workIds[0]}"]')`,
    '旧Source视图释放'
  )
  await selectSession(client, 0)
  await writeFile(join(fixtureDir, 'browser/entry.js'), browserEntry(2))
  const applied = await api(client, 'plugins/apply', { sources: [fixtureDir] })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  await wait(
    client,
    `window.__slotVersion===2 && document.querySelector('[data-testid="fixture-run-inline"]')`,
    '目标插件热重载',
    90000
  )
  assert.equal(await evaluate(client, 'window.__slotCleanupWithoutAbort===true'), false)
  const activeMounts = await evaluate(
    client,
    `Object.fromEntries(Object.entries(window.__slotMounts).map(([key,value])=>[key,value-(window.__slotDisposes[key]??0)]))`
  )
  assert.ok(
    Object.values(activeMounts).every((value) => value >= 0 && value <= 2),
    JSON.stringify(activeMounts)
  )
  results.push('E04：会话切换和热重载释放旧视图，清理前先Abort')

  await evaluate(
    client,
    `localStorage.setItem('pi-super-theme','dark');window.dispatchEvent(new StorageEvent('storage',{key:'pi-super-theme',newValue:'dark'}))`
  )
  await capture(client, 'wide-dark.png')
  await viewport(client, 390, 900)
  await click(client, '[data-testid="session-header-more"]')
  await wait(
    client,
    `document.querySelector('[data-testid="session-header-overflow"]')`,
    '移动端更多'
  )
  await assertBounds(client)
  await capture(client, 'mobile-dark.png')
  await evaluate(
    client,
    `document.documentElement.style.fontSize='150%';new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`
  )
  await assertBounds(client)
  await capture(client, 'zoom-dark.png')
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await wait(
    client,
    `!document.querySelector('[data-testid="session-header-overflow"]')`,
    '关闭390px更多'
  )
  await viewport(client, 300, 900)
  await click(client, '[data-testid="session-header-more"]')
  await wait(
    client,
    `document.querySelector('[data-testid="fixture-run-overflow"]')`,
    '300px放大字号更多'
  )
  await assertBounds(client)
  await click(client, '[data-testid="fixture-run-overflow"][aria-label="运行模拟项目"]')
  await wait(
    client,
    `document.querySelector('[data-testid="fixture-run-overflow"][aria-label="停止模拟项目"]')`,
    '300px放大字号运行控件可点击'
  )
  assert.equal(
    await evaluate(client, `!!document.querySelector('[data-testid="session-header-overflow"]')`),
    true
  )
  await capture(client, 'narrow-zoom-dark.png')
  results.push('E05：300px、390px、明暗主题、150%字号通过')
  assert.deepEqual(client.errors, [], '没有浏览器未处理异常')
  console.log(results.join('\n'))
} catch (error) {
  process.exitCode = 1
  console.error(error)
  if (client) await capture(client, 'failure.png').catch(() => {})
} finally {
  client?.close()
  if (browser) {
    const tree = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$all=Get-CimInstance Win32_Process;$ids=@(${browser.pid});do{$children=@($all|Where-Object{$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids}|Select-Object -ExpandProperty ProcessId);$ids+=$children}while($children.Count -gt 0);ConvertTo-Json -InputObject @($ids)`
      ],
      { windowsHide: true }
    )
    const ids = JSON.parse(tree.stdout)
    await exec('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], {
      windowsHide: true
    }).catch(() => {})
    const end = Date.now() + 10000
    while (true) {
      try {
        await assertPortReleased(cdpPort)
        break
      } catch (error) {
        if (Date.now() > end) throw error
        await delay(100)
      }
    }
    const remaining = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `ConvertTo-Json -InputObject @(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id)`
      ],
      { windowsHide: true }
    )
    assert.deepEqual(JSON.parse(remaining.stdout), [])
  }
  if (server) await stopE2eServerTree(server)
  await mkdir(runRoot, { recursive: true })
  await writeFile(join(runRoot, 'server.log'), serverLog)
  await writeFile(
    join(runRoot, 'result.json'),
    JSON.stringify(
      { results, browserErrors: client?.errors ?? [], resourcesReleased: true },
      null,
      2
    )
  )
  console.log('验收现场：' + runRoot)
}
