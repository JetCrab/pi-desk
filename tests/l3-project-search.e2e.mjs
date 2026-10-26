import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  waitForHttp,
  waitForBrowserReady
} from './l4-browser-cdp-runtime.mjs'
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runId = `scope-navigation-${Date.now()}-${process.pid}`
const output = join(root, 'temp/run/project-search', runId)
const testRoot = join(root, 'temp/pi/project-search-e2e', runId)
const agentDir = join(testRoot, 'agent')
const fixtureRoot = join(root, 'temp/tests/project-search', runId)
const project = join(fixtureRoot, 'search-demo')
const otherProject = join(fixtureRoot, 'second-demo')
const otherWorkId = 'search-fixture-other'
const workId = 'search-fixture-session'
const clientId = 'a517e875-a4e2-460a-9226-9d5f8b30f0ae'
let appPort
let cdpPort
let service
let browser
let page
let serverOutput = ''
let passed = false
const checks = []
const rgEvents = []
let inputSelector = '[data-testid="project-file-search"]'
let resultSelector = '[role="region"][aria-label="搜索结果"]'

async function progress(message) {
  console.log(`[项目搜索验收] ${message}`)
  checks.push(message)
  await writeFile(join(output, 'progress.json'), JSON.stringify(checks, null, 2))
}
async function visible(selector) {
  return evaluate(
    page,
    `(() => { const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getBoundingClientRect().width>0 && el.getBoundingClientRect().height>0); return Boolean(element); })()`
  )
}
async function click(selector) {
  const position = await evaluate(
    page,
    `(() => {
    const scope=document.querySelector('[data-slot="app-dialog-content"]')??document;
    const element=[...scope.querySelectorAll(${JSON.stringify(selector)})].find(el=>{const rect=el.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.left>=0&&rect.right<=innerWidth&&!el.closest('[inert],[aria-hidden="true"]')});
    if(!element) return null;
    element.scrollIntoView({block:'nearest'});
    const rect=element.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`
  )
  assert.ok(position, `找不到可见控件：${selector}`)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...position
  })
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...position
  })
}
async function press(key, code = key, modifiers = 0) {
  const windowsVirtualKeyCode =
    {
      Backspace: 8,
      Enter: 13,
      Escape: 27,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40
    }[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
  const event = {
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode
  }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
}
async function search(query) {
  await click(inputSelector)
  await evaluate(page, `document.querySelector(${JSON.stringify(inputSelector)}).select()`)
  if (query) await page.send('Input.insertText', { text: query })
  else await press('Backspace')
  await waitFor(
    page,
    `document.querySelector(${JSON.stringify(inputSelector)})?.value === ${JSON.stringify(query)} && document.querySelector(${JSON.stringify(resultSelector)})?.getAttribute('aria-busy') === 'false'`,
    '搜索完成',
    () => serverOutput,
    60_000
  )
}
async function scope(name) {
  await click(`[data-testid="project-search-scope-${name}"]`)
  await waitFor(
    page,
    `document.querySelector('[data-testid="project-search-scope-${name}"]')?.getAttribute('aria-checked') === 'true' && document.querySelector(${JSON.stringify(resultSelector)})?.getAttribute('aria-busy') === 'false'`,
    '范围查询完成',
    () => serverOutput,
    60_000
  )
}
async function capture(name) {
  await waitFor(
    page,
    `!document.body.innerText.includes('正在与 HEAD 比较')`,
    '文件比较状态稳定',
    () => serverOutput
  )
  await evaluate(
    page,
    `document.querySelectorAll('nextjs-portal').forEach(portal => { if(portal.shadowRoot?.querySelector('[data-next-mark]')) portal.style.setProperty('display','none','important') })`
  )
  await writeFile(join(output, name), await screenshot(page))
}
async function fixture() {
  process.env.TSX_TSCONFIG_PATH = join(root, 'tsconfig.json')
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  await mkdir(join(project, 'src'), { recursive: true })
  await mkdir(join(project, 'docs'), { recursive: true })
  execFileSync('git', ['init', '--quiet', project], { windowsHide: true })
  for (const name of [
    'session',
    'session-store',
    'session-types',
    'session-cache',
    'session-client'
  ]) {
    const lines = Array.from({ length: 110 }, (_, i) => `// readingLine${i + 1}`)
    lines[0] = `export const session = '${name}'`
    lines[41] = 'export const SESSION_LIMIT = 20'
    lines[81] = "export const marker = 'needleMarker 中文 😀 session'"
    await writeFile(join(project, 'src', `${name}.ts`), lines.join('\n') + '\n')
  }
  await writeFile(join(project, 'src', 'filename-only.ts'), 'body-only-keyword\n')
  await writeFile(join(project, 'docs', 'guide.md'), '# 示例文档\n\nneedleMarker\n')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const session = SessionManager.create(project)
  session.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '项目搜索验收' }],
    timestamp: Date.now()
  })
  await mkdir(otherProject, { recursive: true })
  execFileSync('git', ['init', '--quiet', otherProject], { windowsHide: true })
  await writeFile(
    join(otherProject, 'other.ts'),
    'export const other = "needleMarker second-project"\n'
  )
  const other = SessionManager.create(otherProject)
  other.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '另一个搜索项目' }],
    timestamp: Date.now()
  })
  await writeFile(
    join(agentDir, 'pi-desk', 'work-sessions.json'),
    JSON.stringify({
      workSessions: [
        { workId, cwd: project, sessionId: session.getSessionId() },
        { workId: otherWorkId, cwd: otherProject, sessionId: other.getSessionId() }
      ],
      pinnedCount: 0
    })
  )
}
async function api(body) {
  return evaluate(
    page,
    `fetch('/api/project-files/search',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':${JSON.stringify(clientId)}},body:JSON.stringify(${JSON.stringify({ cwd: project, workId, ...body })})}).then(async response=>({status:response.status,body:await response.json()}))`
  )
}
function nextRgEvent(phase, pid) {
  const previous = pid && rgEvents.find((event) => event.phase === phase && event.pid === pid)
  if (previous) return Promise.resolve(previous)
  return new Promise((resolveEvent, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      service.child.off('message', receive)
    }
    const receive = (message) => {
      if (
        message?.type !== 'search-test-rg' ||
        message.phase !== phase ||
        (pid && message.pid !== pid)
      )
        return
      cleanup()
      resolveEvent(message)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`未观测到rg ${phase}`))
    }, 15_000)
    service.child.on('message', receive)
  })
}
async function verifyHttpCancellation() {
  const directory = join(project, 'cancellation')
  await mkdir(directory)
  const data = Buffer.alloc(2 * 1024 * 1024, 97)
  for (let index = 0; index < 32; index += 8) {
    await Promise.all(
      Array.from({ length: 8 }, (_, offset) =>
        writeFile(join(directory, `sample-${index + offset}.txt`), data)
      )
    )
  }
  await evaluate(
    page,
    `fetch('/api/project-files/list',{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':${JSON.stringify(clientId)}},body:JSON.stringify(${JSON.stringify({ cwd: project, workId, path: '' })})}).then(response=>response.json())`
  )
  const spawned = nextRgEvent('spawn')
  await evaluate(
    page,
    `(() => {window.__cancelProbe = new AbortController();window.__cancelError=null;fetch('/api/project-files/search',{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':${JSON.stringify(clientId)}},body:JSON.stringify(${JSON.stringify({ cwd: project, workId, query: 'missing-cancellation-probe', scope: 'content' })}),signal:window.__cancelProbe.signal}).then(()=>{window.__cancelError='completed'}).catch(error=>{window.__cancelError=error.name});})()`
  )
  const process = await spawned
  const closed = nextRgEvent('close', process.pid)
  await evaluate(page, 'window.__cancelProbe.abort()')
  const exit = await closed
  assert.ok(exit.signal, `rg应被取消而不是自然完成：${JSON.stringify(exit)}`)
  await waitFor(page, `window.__cancelError === 'AbortError'`, '浏览器搜索取消')
  const independent = await api({ query: 'filename-only', scope: 'files' })
  assert.equal(independent.status, 200)
  assert.equal(independent.body.data.fileMatches.length, 1)
  await progress('真实HTTP中断已停止运行中的rg，其他请求仍正常')
}
async function verifySharedViews() {
  const previous = await evaluate(
    page,
    `window.__searchRequests.filter(item=>item.input.query==='needleMarker'&&item.input.scope==='all').length`
  )
  await click('[aria-label="放大文件"]')
  await waitFor(
    page,
    `document.querySelector('[data-slot="app-dialog-content"] [data-testid="project-file-search"]') !== null`,
    '放大目录搜索就绪',
    () => serverOutput
  )
  inputSelector = '[data-slot="app-dialog-content"] [data-testid="project-file-search"]'
  resultSelector = '[data-slot="app-dialog-content"] [role="region"][aria-label="搜索结果"]'
  await search('needleMarker')
  assert.equal(
    await evaluate(
      page,
      `window.__searchRequests.filter(item=>item.input.query==='needleMarker'&&item.input.scope==='all').length`
    ),
    previous + 1,
    '侧栏与放大目录不能重复请求'
  )
  await click('[data-testid="project-search-line-src/session.ts-82"]')
  await waitFor(
    page,
    `Boolean(document.querySelector('[data-slot="app-dialog-content"] header [title="src/session.ts"]')) && document.querySelector('[data-slot="app-dialog-content"] [data-testid="code-preview"] .view-lines')?.textContent.includes('needleMarker') === true`,
    '放大视图命中定位',
    () => serverOutput
  )
  await waitFor(
    page,
    `(() => {const dialog=document.querySelector('[data-slot="app-dialog-content"]');return dialog?.innerText.includes('处变更')&&!dialog.innerText.includes('正在与 HEAD')})()`,
    '放大文件比较完成',
    () => serverOutput
  )
  await capture('desktop-expanded.png')
  await click('[aria-label="退出放大"]')
  await waitFor(
    page,
    `document.querySelector('[data-slot="app-dialog-content"]') === null`,
    '退出放大'
  )
  inputSelector = '[data-testid="project-file-search"]'
  resultSelector = '[role="region"][aria-label="搜索结果"]'
  await click('[aria-label="显示工作会话"]')
  await click(`[data-testid="work-session-row-${otherWorkId}"]`)
  await waitFor(
    page,
    `document.querySelector('[data-work-id="${otherWorkId}"] textarea') !== null`,
    '第二个会话就绪',
    () => serverOutput
  )
  await click('[aria-label="显示项目文件"]')
  await waitFor(
    page,
    `document.querySelector('[aria-label="搜索项目"]') !== null`,
    '第二个项目目录就绪',
    () => serverOutput
  )
  await click('[aria-label="搜索项目"]')
  await scope('content')
  await search('needleMarker')
  assert.equal(await evaluate(page, `document.querySelectorAll('[data-search-result]').length`), 1)
  assert.equal(
    await evaluate(
      page,
      `window.__searchRequests.filter(item=>item.input.query==='needleMarker').at(-1).input.workId`
    ),
    otherWorkId
  )
  assert.equal(await visible('[data-testid="project-search-line-other.ts-1"]'), true)
  await click('[aria-label="显示工作会话"]')
  await click(`[data-testid="work-session-row-${workId}"]`)
  await click('[aria-label="显示项目文件"]')
  await waitFor(
    page,
    `document.querySelector(${JSON.stringify(inputSelector)})?.value==='needleMarker'`,
    '原会话保留搜索条件',
    () => serverOutput
  )
  assert.equal(
    await evaluate(
      page,
      `document.querySelector('[data-testid="project-search-scope-all"]').getAttribute('aria-checked')`
    ),
    'true'
  )
  await search('session')
  await progress('放大目录共享查询、多会话搜索隔离及恢复通过')
}
async function verifyVisualStates() {
  await setViewport(page, 375, 812, true)
  await search('readingLine')
  await waitFor(
    page,
    `window.__searchRequests.filter(item=>item.input.query==='readingLine').at(-1)?.result?.data.truncated===true`,
    '真实结果截断'
  )
  await capture('mobile-truncated.png')
  await click('[data-testid="project-search-option-regex"]')
  await search('[')
  await capture('mobile-pattern-error.png')
  await click('[data-testid="project-search-option-regex"]')
  await search('')
  await evaluate(
    page,
    `(() => {window.__delaySearch=new Promise((resolve,reject)=>{window.__releaseSearch=resolve;window.__rejectSearch=reject})})()`
  )
  await click(inputSelector)
  await page.send('Input.insertText', { text: 'network-probe' })
  await waitFor(
    page,
    `document.querySelector(${JSON.stringify(resultSelector)})?.getAttribute('aria-busy')==='true'`,
    '搜索加载状态'
  )
  await capture('mobile-loading.png')
  await waitFor(page, `window.__delaySearch === null`, '查询进入延迟传输')
  await evaluate(page, `window.__rejectSearch(new TypeError('网络连接中断'))`)
  await waitFor(
    page,
    `document.querySelector(${JSON.stringify(resultSelector)})?.querySelector('[role="alert"]')?.textContent.includes('网络连接中断')===true`,
    '网络错误反馈'
  )
  await capture('mobile-network-error.png')
  await search('session')
  await evaluate(page, `document.documentElement.style.fontSize='20px'`)
  assert.equal(await evaluate(page, 'document.documentElement.scrollWidth <= innerWidth'), true)
  await capture('mobile-text-zoom.png')
  await evaluate(page, `document.documentElement.style.fontSize=''`)
  await progress('文字放大、真实截断、正则错误和延迟／断网反馈视觉检查就绪')
}
async function run() {
  await fixture()
  appPort = await reservePort()
  cdpPort = await reservePort()
  service = spawnE2eServer({
    projectRoot: root,
    agentDir,
    port: appPort,
    development: true,
    environment: {
      NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'tests/l4-search-process-observer.mjs')).href}`,
      PI_DESK_SEARCH_TEST_CWD: project
    },
    nextDirectory: join(root, 'temp/build/project-search', runId, 'next'),
    onOutput: (chunk) => {
      serverOutput = (serverOutput + chunk).slice(-1024 * 1024)
    }
  })
  service.child.on('message', (message) => {
    if (message?.type === 'search-test-rg' && rgEvents.length < 1000) rgEvents.push(message)
  })
  await waitForHttp(`http://127.0.0.1:${appPort}/api/health`, 60_000, 'Pi Desk', () => serverOutput)
  browser = spawnEdge(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    cdpPort,
    join(output, 'browser'),
    '1440,900'
  )
  await waitForBrowserReady(browser, cdpPort)
  page = await createCdpPage(cdpPort)
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-color-scheme', value: 'dark' }
    ]
  })
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    window.__searchRequests=[];window.__searchErrors=[];
    const originalFetch=window.fetch.bind(window);
    window.fetch=async (...args)=>{const url=String(args[0]);const tracked=url.endsWith('/api/project-files/search')||url.endsWith('/api/project-files/get');const item=tracked?{input:JSON.parse(args[1].body)}:null;if(item)window.__searchRequests.push(item);try{if(url.endsWith('/api/project-files/search')&&window.__delaySearch){const gate=window.__delaySearch;window.__delaySearch=null;await gate}const response=await originalFetch(...args);if(item){item.status=response.status;item.result=await response.clone().json()}return response}catch(error){if(item)item.error=error.name;throw error}};
    window.addEventListener('error',event=>window.__searchErrors.push(event.message));
    window.addEventListener('unhandledrejection',event=>window.__searchErrors.push(String(event.reason)));
  `
  })
  await setViewport(page, 1440, 900, false)
  await navigate(page, `http://127.0.0.1:${appPort}/login`)
  const login = await evaluate(
    page,
    `fetch('/api/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':${JSON.stringify(clientId)}},body:JSON.stringify({password:'Qq.445566'})}).then(async response=>({ok:response.ok,body:await response.json()}))`
  )
  assert.equal(login.ok, true, JSON.stringify(login.body))
  await navigate(page, `http://127.0.0.1:${appPort}/`)
  await waitFor(
    page,
    `document.querySelector('[data-testid="work-session-row-${workId}"]') !== null`,
    '工作会话列表就绪',
    () => serverOutput,
    60_000
  )
  await click(`[data-testid="work-session-row-${workId}"]`)
  await waitFor(
    page,
    `document.querySelector('[data-work-id="${workId}"] textarea') !== null`,
    '工作会话加载',
    () => serverOutput,
    90_000
  )
  await progress('隔离服务与工作会话就绪')
  await click('[aria-label="显示项目文件"]')
  await waitFor(
    page,
    `document.querySelector('[data-testid="project-folder-src"]') !== null`,
    '项目树加载',
    () => serverOutput,
    60_000
  )
  await waitFor(
    page,
    `document.querySelector('[data-testid="project-git-changes-toggle"]') !== null`,
    'Git工具栏加载',
    () => serverOutput,
    60_000
  )
  await click('[data-testid="project-git-changes-toggle"]')
  await click('[aria-label="搜索项目"]')
  await waitFor(
    page,
    `document.querySelector(${JSON.stringify(inputSelector)}) !== null`,
    '搜索控件显示',
    () => serverOutput
  )
  assert.equal(await visible('[data-testid="project-git-changes-toggle"]'), false)
  assert.equal(
    await evaluate(
      page,
      `document.querySelector('[data-testid="project-search-scope-all"]').getAttribute('aria-checked')`
    ),
    'true'
  )
  await search('session')
  assert.equal(
    await evaluate(
      page,
      `document.querySelectorAll('[data-testid^="project-search-result-"]').length`
    ),
    3
  )
  assert.ok(
    (await evaluate(
      page,
      `document.querySelectorAll('[data-testid^="project-search-line-"]').length`
    )) > 0
  )
  const expand = await evaluate(
    page,
    `[...document.querySelectorAll('button')].find(el=>el.textContent.includes('展开其余'))?.textContent`
  )
  assert.ok(expand)
  await evaluate(
    page,
    `[...document.querySelectorAll('button')].find(el=>el.textContent.includes('展开其余')).click()`
  )
  assert.equal(
    await evaluate(
      page,
      `document.querySelectorAll('[data-testid^="project-search-result-"]').length`
    ),
    5
  )
  assert.equal(
    await evaluate(
      page,
      `document.querySelector('[data-testid="project-search-scope-all"]').getAttribute('aria-checked')`
    ),
    'true'
  )
  await scope('files')
  await search('body-only-keyword')
  assert.equal(await evaluate(page, `document.querySelectorAll('[data-search-result]').length`), 0)
  await scope('content')
  await waitFor(
    page,
    `document.querySelector('[data-testid="project-search-line-src/filename-only.ts-1"]') !== null`,
    '正文专有词命中',
    () => serverOutput
  )
  assert.equal(
    await evaluate(
      page,
      `[...document.querySelectorAll('[role="status"]')].some(element=>element.textContent.includes('1 个文件 · 1 个命中行'))`
    ),
    true
  )
  await search('filename-only')
  assert.equal(await evaluate(page, `document.querySelectorAll('[data-search-result]').length`), 0)
  await scope('files')
  assert.equal(await evaluate(page, `document.querySelectorAll('[data-search-result]').length`), 1)
  await progress('真实接口范围选择与更多结果展开通过')

  const all = await api({
    query: 'needleMarker',
    scope: 'all',
    caseSensitive: false,
    wholeWord: false,
    regex: false
  })
  assert.equal(all.status, 200)
  assert.equal(all.body.data.contentMatches.length, 6)
  assert.deepEqual(
    all.body.data.contentMatches.find((item) => item.path === 'src/session.ts').ranges,
    [{ start: 23, end: 35 }]
  )
  const invalid = await api({ query: '[', scope: 'content', regex: true })
  assert.equal(invalid.status, 400)
  await scope('content')
  await search('session')
  await click('[data-testid="project-search-option-wholeWord"]')
  await waitFor(
    page,
    `document.querySelector(${JSON.stringify(resultSelector)})?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('[data-search-result]').length===10`,
    '全词排除下划线标识符',
    () => serverOutput
  )
  await click('[data-testid="project-search-option-wholeWord"]')
  await search('')
  const beforeComposition = await evaluate(page, 'window.__searchRequests.length')
  await evaluate(
    page,
    `document.querySelector(${JSON.stringify(inputSelector)}).dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))`
  )
  await page.send('Input.insertText', { text: '中文' })
  await waitFor(
    page,
    `document.querySelector('[data-testid="project-search-scope-all"]')?.disabled === true`,
    '组合输入期间暂停范围操作'
  )
  assert.equal(await evaluate(page, 'window.__searchRequests.length'), beforeComposition)
  await evaluate(
    page,
    `document.querySelector(${JSON.stringify(inputSelector)}).dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}))`
  )
  await waitFor(
    page,
    `document.querySelector(${JSON.stringify(resultSelector)})?.getAttribute('aria-busy') === 'false' && window.__searchRequests.at(-1)?.input.query==='中文'`,
    '组合输入结束后查询',
    () => serverOutput
  )
  await search('session_limit')
  assert.equal(await evaluate(page, `document.querySelectorAll('[data-search-result]').length`), 5)
  await click('[data-testid="project-search-option-caseSensitive"]')
  await waitFor(
    page,
    `document.querySelector(${JSON.stringify(resultSelector)})?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('[data-search-result]').length===0`,
    '大小写选项执行',
    () => serverOutput
  )
  await click('[data-testid="project-search-option-caseSensitive"]')
  await click('[data-testid="project-search-option-regex"]')
  await search('[')
  await waitFor(
    page,
    `document.querySelector(${JSON.stringify(resultSelector)})?.querySelector('[role="alert"]') !== null`,
    '正则错误显示',
    () => serverOutput
  )
  await click('[data-testid="project-search-option-regex"]')
  await search('needleMarker')
  await click('[data-testid="project-search-line-src/session.ts-82"]')
  await waitFor(
    page,
    `document.querySelector('[data-testid="code-preview"] .view-lines')?.textContent.includes('needleMarker') === true`,
    '命中行在Monaco视口可见',
    () => serverOutput,
    60_000
  )
  await waitFor(
    page,
    `document.querySelector('[data-testid="code-preview"] [class*="bg-accent"]') !== null`,
    '命中行高亮',
    () => serverOutput
  )
  await capture('desktop-content-dark.png')
  const reads = await evaluate(
    page,
    `window.__searchEditor=document.querySelector('[data-testid="code-preview"] .monaco-editor');window.__searchRequests.filter(item=>item.input.path==='src/session.ts').length`
  )
  await click('[data-testid="project-search-line-src/session.ts-82"]')
  await waitFor(
    page,
    `window.__searchRequests.filter(item=>item.input.path==='src/session.ts').length > ${reads} && window.__searchRequests.filter(item=>item.input.path==='src/session.ts').at(-1)?.status===200 && document.querySelector('[data-testid="code-preview"] .view-lines')?.textContent.includes('needleMarker')`,
    '同文件重复定位',
    () => serverOutput
  )
  assert.equal(
    await evaluate(
      page,
      `document.querySelector('[data-testid="code-preview"] .monaco-editor')===window.__searchEditor`
    ),
    true,
    '相同正文定位不能重建编辑器'
  )
  await click('[data-testid="project-search-line-docs/guide.md-3"]')
  await waitFor(
    page,
    `document.querySelector('[data-testid="code-preview"] .view-lines')?.textContent.replaceAll('\\u00a0', ' ').includes('# 示例文档') === true`,
    'Markdown搜索进入源码',
    () => serverOutput,
    60_000
  )
  await scope('all')
  await search('session')
  await evaluate(page, `document.documentElement.classList.add('dark')`)
  await capture('desktop-all-dark.png')
  await evaluate(page, `document.documentElement.classList.remove('dark')`)
  await capture('desktop-all-light.png')
  await progress('匹配选项、错误恢复、源码定位及宽屏明暗截图通过')
  await verifySharedViews()

  await click(inputSelector)
  await press('Escape')
  assert.equal(await visible('[data-testid="project-git-changes-toggle"]'), true)
  assert.equal(
    await evaluate(
      page,
      `document.querySelector('[data-testid="project-git-changes-toggle"]').getAttribute('aria-pressed')`
    ),
    'true'
  )
  await click('[aria-label="搜索项目"]')
  assert.equal(
    await evaluate(page, `document.querySelector(${JSON.stringify(inputSelector)}).value`),
    'session'
  )
  await search('')
  await scope('content')
  assert.equal(
    await evaluate(page, `document.querySelector(${JSON.stringify(inputSelector)}).placeholder`),
    '搜索文件内容'
  )
  await click('[data-testid="project-search-scope-all"]')
  await press('ArrowRight')
  assert.equal(
    await evaluate(
      page,
      `document.querySelector('[data-testid="project-search-scope-files"]').getAttribute('aria-checked')`
    ),
    'true'
  )
  await scope('all')
  await search('session')
  await setViewport(page, 375, 812, true)
  await evaluate(page, `document.documentElement.classList.add('dark')`)
  await waitFor(
    page,
    `document.querySelector('[aria-label="显示工作会话菜单"]') !== null`,
    '窄屏预览菜单',
    () => serverOutput
  )
  await click('[aria-label="显示工作会话菜单"]')
  await waitFor(
    page,
    `(() => {const input=document.querySelector(${JSON.stringify(inputSelector)});return input&&input.getBoundingClientRect().left>=0&&input.getBoundingClientRect().right<=innerWidth})()`,
    '窄屏搜索侧栏',
    () => serverOutput
  )
  await capture('mobile-all-dark.png')
  await scope('content')
  await search('needleMarker')
  await click('[data-testid="project-search-line-src/session.ts-82"]')
  await waitFor(
    page,
    `document.querySelector('[data-testid="code-preview"] .view-lines')?.textContent.includes('needleMarker') === true`,
    '窄屏命中预览',
    () => serverOutput
  )
  await capture('mobile-preview-dark.png')
  await click('[aria-label="显示工作会话菜单"]')
  await waitFor(
    page,
    `document.querySelector(${JSON.stringify(inputSelector)})?.value === 'needleMarker'`,
    '返回保留搜索条件',
    () => serverOutput
  )
  await evaluate(page, `document.documentElement.classList.remove('dark')`)
  await capture('mobile-content-light.png')
  await search('')
  await scope('files')
  await capture('mobile-files-empty.png')
  await scope('content')
  await capture('mobile-content-empty.png')
  await setViewport(page, 300, 650, true)
  assert.equal(await evaluate(page, 'document.documentElement.scrollWidth <= innerWidth'), true)
  await capture('mobile-zoom.png')
  await progress('目录状态恢复、范围键盘、窄屏搜索与预览返回通过')
  await verifyVisualStates()
  await verifyHttpCancellation()
  const requests = await evaluate(page, 'window.__searchRequests')
  assert.ok(requests.some((item) => item.input.scope === 'files'))
  assert.ok(requests.some((item) => item.input.scope === 'content'))
  assert.ok(requests.some((item) => item.input.scope === 'all'))
  await writeFile(join(output, 'requests.json'), JSON.stringify(requests, null, 2))
  const errors = await evaluate(page, 'window.__searchErrors')
  assert.deepEqual(errors, [])
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify({ checks, errors, appPort, cdpPort, rgEvents }, null, 2)
  )
  passed = true
}

await mkdir(output, { recursive: true })
let timer
try {
  await Promise.race([
    run(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('搜索E2E超过总时限240秒')), 240_000)
    })
  ])
} catch (error) {
  console.error(error)
  await writeFile(join(output, 'failure.log'), String(error.stack ?? error))
  if (page) {
    const diagnostics = await evaluate(
      page,
      `({requests:window.__searchRequests,errors:window.__searchErrors,input:document.querySelector(${JSON.stringify(inputSelector)})?.value,active:document.activeElement?.outerHTML})`
    ).catch(() => null)
    await writeFile(join(output, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2))
    await capture('failure.png').catch(() => {})
  }
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  await writeFile(join(output, 'server.log'), serverOutput)
  page?.close()
  try {
    await stopBrowserTree(browser, cdpPort ?? 0)
  } finally {
    if (service) await stopE2eServerTree(service)
  }
  if (passed) {
    await rm(fixtureRoot, { recursive: true, force: true })
    await rm(testRoot, { recursive: true, force: true })
    await rm(join(output, 'browser'), { recursive: true, force: true })
    await rm(join(root, 'temp/build/project-search', runId), { recursive: true, force: true })
  }
  console.log(`验收附件：${output}`)
  console.log('服务与浏览器进程树已退出，端口已释放')
}
