import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const taskId = `session-search-${process.pid}`
const testRoot = join(projectRoot, 'temp/pi/workbench-session-search-e2e', taskId)
const runRoot = join(projectRoot, 'temp/run/workbench-session-search', taskId)
const buildRoot = join(projectRoot, 'temp/build/workbench-session-search', taskId)
const agentDir = join(testRoot, 'agent')
const cwd = join(testRoot, 'account-project')
const password = 'Search.test-2026'
const clientId = '3ea08959-283e-47c7-88c4-f0c68e887d78'
const sourceId = 'search-current'
const fixedId = 'search-fixed'
const otherId = 'search-other'
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
let client
let browser
let runtime
let cdpPort
let appPort
let output = ''
let fixture
let succeeded = false
const checks = []

function assistant(text, timestamp) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'test',
    model: 'fixture',
    usage,
    stopReason: 'stop',
    timestamp
  }
}

async function prepare() {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(runRoot, { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], extensions: [] }))
  await writeFile(
    join(agentDir, 'pi-desk-settings.json'),
    JSON.stringify({ region: { locale: 'zh-CN', timeZone: 'UTC' } })
  )
  await writeFile(join(agentDir, 'pi-desk/auth-session-key'), Buffer.alloc(32, 8).toString('hex'))
  const salt = Buffer.alloc(16, 6)
  const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  await writeFile(
    join(agentDir, 'pi-desk/auth.json'),
    JSON.stringify({ passwordHash: `scrypt:${salt.toString('hex')}:${hash.toString('hex')}` })
  )
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const now = Date.now()
  const source = SessionManager.create(cwd)
  source.appendThinkingLevelChange('off')
  source.appendMessage({ role: 'user', content: '共同需求', timestamp: now })
  const root = source.appendMessage(assistant('共同检查点', now + 1))
  source.appendMessage({ role: 'user', content: '旧分支柠檬只存在于先前路径', timestamp: now + 2 })
  const oldLeaf = source.appendMessage(assistant('旧分支已回复', now + 3))
  source.branch(root)
  source.appendMessage({
    role: 'user',
    content: '登录校验：增加验证码过期后的提示，避免重复提交。',
    timestamp: now + 4
  })
  const mainLeaf = source.appendMessage(
    assistant('专用助手术语：登录错误统一显示在输入区域附近。', now + 5)
  )
  source.appendSessionInfo('审阅登录校验与错误提示')
  const rows = [{ workId: sourceId, cwd, sessionId: source.getSessionId() }]
  let hiddenSessionId
  for (const [workId, title, text] of [
    [fixedId, '登录回归测试', '登录校验需要覆盖旧账号和验证码过期场景。'],
    [otherId, '文件预览布局', '调整文档预览区域的宽度。'],
    [null, '尚未打开的历史讨论', '未打开历史关键词']
  ]) {
    const manager = SessionManager.create(cwd)
    manager.appendMessage({ role: 'user', content: text, timestamp: now })
    manager.appendMessage(assistant('收到，开始检查。', now + 1))
    manager.appendSessionInfo(title)
    if (workId) rows.push({ workId, cwd, sessionId: manager.getSessionId() })
    else hiddenSessionId = manager.getSessionId()
  }
  await writeFile(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({ workSessions: [rows[1], rows[0], rows[2]], pinnedCount: 1 })
  )
  return {
    sourceSessionId: source.getSessionId(),
    sourceFile: source.getSessionFile(),
    oldLeaf,
    mainLeaf,
    hiddenSessionId
  }
}

async function api(path, body, options = {}) {
  return evaluate(
    client,
    `fetch(${JSON.stringify(path)}, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', ${options.noClient ? '' : `'X-Pi-Desk-Client-Id': ${JSON.stringify(clientId)}`} },
    body: ${JSON.stringify(options.raw ?? JSON.stringify(body))}
  }).then(async response => ({ status: response.status, body: await response.json() }))`
  )
}

async function search(query, searchIn) {
  const response = await api('/api/work-sessions/search', {
    query,
    ...(searchIn ? { searchIn } : {})
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.code, 0)
  return response.body.data.sessions
}

async function click(selector) {
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
    `找到操作 ${selector}`,
    () => output
  )
  assert.equal(
    await evaluate(
      client,
      `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.click(); return true;
  })()`
    ),
    true
  )
}

async function input(selector, value) {
  assert.equal(
    await evaluate(
      client,
      `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement)) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true })); return true;
  })()`
    ),
    true,
    `未找到输入框 ${selector}`
  )
}

const searchInput = '[data-testid="work-session-search-input"]'
async function expectRows(ids) {
  if (ids.length === 0) {
    await waitFor(
      client,
      `document.querySelector('[data-testid="work-session-search-status"]')?.textContent.includes('没有匹配的工作会话')`,
      '搜索完成且没有匹配'
    )
  }
  await waitFor(
    client,
    `JSON.stringify([...document.querySelectorAll('[data-testid^="work-session-row-"]')].map(row => row.dataset.testid.slice('work-session-row-'.length))) === ${JSON.stringify(JSON.stringify(ids))}`,
    `会话结果 ${ids.join(',')}`,
    () => output
  )
}

async function saveImage(name) {
  if (name !== 'failure.png') {
    await waitFor(
      client,
      `(() => {
      const badge = document.querySelector('nextjs-portal')?.shadowRoot?.querySelector('[data-next-badge]');
      return !badge || badge.getAttribute('data-status') === 'none';
    })()`,
      '开发编译完成',
      () => output
    )
    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach(portal => {
      if (portal.shadowRoot?.querySelector('[data-next-mark]')) portal.style.display = 'none';
    })`
    )
  }
  await writeFile(join(runRoot, name), await screenshot(client))
}

async function setTheme(theme) {
  await evaluate(
    client,
    `localStorage.setItem('pi-super-theme', ${JSON.stringify(theme)});
    window.dispatchEvent(new StorageEvent('storage', { key: 'pi-super-theme', newValue: ${JSON.stringify(theme)} })); true`
  )
  await waitFor(
    client,
    `document.documentElement.classList.contains('dark') === ${theme === 'dark'}`,
    `${theme}主题已生效`
  )
}

async function verifyApi() {
  assert.deepEqual(
    (await search('登录')).map((row) => row.workId),
    [fixedId, sourceId]
  )
  assert.deepEqual(await search('未打开历史关键词'), [])
  assert.deepEqual(await search('旧分支柠檬'), [])
  assert.deepEqual(await search('专用助手术语'), [])
  assert.deepEqual(
    (await search('专用助手术语', ['assistant'])).map((row) => row.workId),
    [sourceId]
  )
  assert.deepEqual(
    (await search(fixture.sourceSessionId, ['sessionId'])).map((row) => row.workId),
    [sourceId]
  )
  const before = await readFile(fixture.sourceFile, 'utf8')
  const changed = await api('/api/work-sessions/branch', {
    action: 'tree',
    workId: sourceId,
    sessionId: fixture.sourceSessionId,
    entryId: fixture.oldLeaf
  })
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  assert.deepEqual(
    (await search('旧分支柠檬')).map((row) => row.workId),
    [sourceId]
  )
  assert.deepEqual(await search('专用助手术语', ['assistant']), [])
  assert.equal(await readFile(fixture.sourceFile, 'utf8'), before, '切分支不持久化也应搜索内存分支')
  const restored = await api('/api/work-sessions/branch', {
    action: 'tree',
    workId: sourceId,
    sessionId: fixture.sourceSessionId,
    entryId: fixture.mainLeaf
  })
  assert.equal(restored.status, 200, JSON.stringify(restored.body))
  for (const invalid of [
    { query: '' },
    { query: 'x', searchIn: [] },
    { query: 'x', searchIn: ['tool'] }
  ]) {
    assert.equal((await api('/api/work-sessions/search', invalid)).status, 400)
  }
  assert.equal((await api('/api/work-sessions/search', {}, { raw: '{broken' })).status, 400)
  assert.equal(
    (await api('/api/work-sessions/search', { query: '登录' }, { noClient: true })).status,
    400
  )
  const history = await api('/api/pi/sessions/list', { cwd, query: '未打开历史关键词' })
  assert.equal(history.status, 200)
  assert.deepEqual(
    history.body.data.sessions.map((row) => row.sessionId),
    [fixture.hiddenSessionId]
  )
  checks.push('真实HTTP：工作会话范围、标题/正文/ID、当前内存分支、参数错误、历史接口兼容')
}

async function verifyUi() {
  await evaluate(
    client,
    `localStorage.setItem('pi-super:workbench-layout', JSON.stringify({primaryWorkId: ${JSON.stringify(sourceId)}}))`
  )
  await navigate(client, `http://127.0.0.1:${appPort}/`)
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(searchInput)}) !== null`,
    '侧栏搜索可用',
    () => output,
    60_000
  )
  await expectRows([sourceId, otherId, fixedId])
  await input(searchInput, '登录')
  await expectRows([sourceId, fixedId])
  await waitFor(
    client,
    `document.querySelector('[data-testid="work-session-row-${sourceId}"]').textContent.includes('验证码')`,
    '正文命中摘要'
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelector('[data-testid="work-session-drag-${sourceId}"]').disabled`
    ),
    true
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelector('[data-testid="work-session-pin-${sourceId}"]').disabled`
    ),
    false
  )
  await client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  await setTheme('light')
  await saveImage('desktop-light.png')
  await setTheme('dark')
  await saveImage('desktop-dark.png')
  await click('[data-testid="work-session-search-clear"]')
  await expectRows([sourceId, otherId, fixedId])
  assert.equal(
    await evaluate(
      client,
      `document.querySelector('[data-testid="work-session-drag-${sourceId}"]').disabled`
    ),
    false
  )
  await input(searchInput, '不存在的内容')
  await expectRows([])
  await input(searchInput, '专用助手术语')
  await expectRows([])
  await click('[data-testid="work-session-search-scopes"]')
  await waitFor(
    client,
    `[...document.querySelectorAll('[role="menuitemcheckbox"]')].some(node => node.textContent.trim() === 'AI 回复')`,
    '搜索范围菜单'
  )
  const assistantScope = await evaluate(
    client,
    `(() => {
      const target = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(node => node.textContent.trim() === 'AI 回复');
      if (!target) return false; target.click(); return true;
    })()`
  )
  assert.equal(assistantScope, true, 'AI 回复条件可选择')
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
  await expectRows([sourceId])
  await input(searchInput, '登录')
  await expectRows([sourceId, fixedId])

  // 真实响应延后交付，模拟HTTP请求已返回但页面切换时回调尚未执行。
  await evaluate(
    client,
    `(() => {
    window.__searchRequests = []; window.__searchNativeFetch = window.fetch;
    window.fetch = async (url, init) => {
      if (!String(url).includes('/api/work-sessions/search')) return window.__searchNativeFetch(url, init);
      const log = { query: JSON.parse(init.body).query, aborted: false, held: false, released: false };
      window.__searchRequests.push(log);
      init.signal?.addEventListener('abort', () => { log.aborted = true; }, { once: true });
      const response = await window.__searchNativeFetch(url, init);
      if (log.query === '校验') {
        log.held = true;
        await new Promise(resolve => { window.__releaseSearch = () => { log.released = true; resolve(); }; });
      }
      return response;
    }; return true;
  })()`
  )
  await input(searchInput, '校验')
  await waitFor(client, `window.__searchRequests.some(item => item.held)`, '延迟查询取得真实响应')
  await click('[data-testid="sidebar-mode-files"]')
  await waitFor(
    client,
    `!document.querySelector(${JSON.stringify(searchInput)}) || document.querySelector(${JSON.stringify(searchInput)}).getClientRects().length === 0`,
    '文件Tab隐藏搜索'
  )
  await waitFor(
    client,
    `window.__searchRequests.some(item => item.held && item.aborted)`,
    '隐藏时取消查询'
  )
  await evaluate(client, `window.__releaseSearch(); true`)
  await click('[data-testid="sidebar-mode-sessions"]')
  await waitFor(
    client,
    `window.__searchRequests.filter(item => item.query === '校验').length === 2`,
    '切回按需重新查询'
  )
  await waitFor(
    client,
    `window.__searchRequests.filter(item => item.held).length === 2`,
    '重新查询已返回'
  )
  await input(searchInput, '不存在的内容')
  await expectRows([])
  await evaluate(client, `window.__releaseSearch(); true`)
  await evaluate(
    client,
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
  )
  await expectRows([])
  await evaluate(client, `window.fetch = window.__searchNativeFetch; true`)
  checks.push('侧栏：条件切换、摘要、清空、无结果、拖拽边界、Tab隐藏及迟到响应隔离')

  await click('[data-testid="work-session-search-clear"]')
  await expectRows([sourceId, otherId, fixedId])
  await click('[data-testid="sidebar-replace-work-session"]')
  const historyInput = '[data-testid="workbench-history-search-input"]'
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(historyInput)}) !== null`,
    '替换弹窗搜索'
  )
  await input(historyInput, '未打开历史关键词')
  const replacement = `[data-testid="workbench-picker-replace-${fixture.hiddenSessionId}"]`
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(replacement)}) !== null`,
    '历史搜索命中未打开会话'
  )
  await click(`[data-testid="workbench-picker-user-messages-${fixture.hiddenSessionId}"]`)
  await waitFor(
    client,
    `document.querySelector('[data-testid="workbench-picker-user-message-panel-${fixture.hiddenSessionId}"]')?.textContent.includes('未打开历史关键词')`,
    '展开完整用户消息'
  )
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
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(historyInput)}) === null`,
    '关闭替换弹窗'
  )
  await evaluate(
    client,
    `window.__historyCalls = 0; window.__historyNativeFetch = window.fetch; window.fetch = (url, init) => { if(String(url).includes('/api/pi/sessions/list')) window.__historyCalls++; return window.__historyNativeFetch(url, init); }; true`
  )
  await click('[data-testid="sidebar-replace-work-session"]')
  await waitFor(
    client,
    `window.__historyCalls >= 1 && document.querySelector(${JSON.stringify(replacement)}) !== null`,
    '重开重新请求历史列表'
  )
  assert.equal(
    await evaluate(client, `document.querySelector(${JSON.stringify(historyInput)}).value`),
    ''
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelector('[data-testid="workbench-picker-user-message-panel-${fixture.hiddenSessionId}"]') === null`
    ),
    true
  )
  await input(historyInput, '未打开历史关键词')
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(replacement)}) !== null`,
    '重新搜索历史'
  )
  await click(replacement)
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(historyInput)}) === null`,
    '替换成功关闭弹窗',
    () => output
  )
  await input(searchInput, '未打开历史关键词')
  await expectRows([sourceId])
  checks.push('替换会话：正文展开、关闭清理、重开重新请求、替换成功后工作搜索范围更新')

  await click('[data-testid="work-session-search-clear"]')
  await setViewport(client, 390, 844, true)
  await waitFor(
    client,
    `document.querySelector('[aria-label="显示工作会话菜单"]') !== null`,
    '移动布局'
  )
  await click('[aria-label="显示工作会话菜单"]')
  await input(searchInput, '登录')
  await expectRows([fixedId])
  await saveImage('mobile-dark.png')
  assert.equal(
    await evaluate(client, `document.documentElement.scrollWidth <= innerWidth`),
    true,
    '手机不应横向溢出'
  )
  await click(`[data-testid="work-session-row-${fixedId}"]`)
  await waitFor(
    client,
    `document.querySelector('[aria-label="关闭工作会话菜单"]')?.getAttribute('aria-hidden') === 'true'`,
    '点击结果关闭移动抽屉'
  )
  checks.push('手机：窄屏搜索、无横向溢出、点击结果切换并关闭抽屉')
}

try {
  fixture = await prepare()
  appPort = await reservePort()
  cdpPort = await reservePort()
  runtime = spawnE2eServer({
    projectRoot,
    agentDir,
    port: appPort,
    development: true,
    nextDirectory: buildRoot,
    onOutput: (text) => {
      output += text
    }
  })
  await waitForHttp(`http://127.0.0.1:${appPort}/api/health`, 60_000, 'Pi Desk', () => output)
  browser = spawnEdge(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    cdpPort,
    join(runRoot, 'browser-profile'),
    '1440,900'
  )
  await waitForBrowserReady(browser, cdpPort)
  client = await createCdpPage(cdpPort)
  await setViewport(client, 1440, 900, false)
  await navigate(client, `http://127.0.0.1:${appPort}/login`)
  const login = await api('/api/auth/login', { password })
  assert.equal(login.status, 200, JSON.stringify(login.body))
  await verifyApi()
  await verifyUi()
  succeeded = true
} catch (error) {
  await mkdir(runRoot, { recursive: true })
  if (client)
    await Promise.race([
      saveImage('failure.png').catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ])
  console.error(error)
  process.exitCode = 1
} finally {
  client?.close()
  try {
    if (browser) await stopBrowserTree(browser, cdpPort)
  } finally {
    if (runtime) await stopE2eServerTree(runtime)
  }
  await mkdir(runRoot, { recursive: true })
  await writeFile(join(runRoot, 'server.log'), output)
  await writeFile(
    join(runRoot, 'result.json'),
    JSON.stringify({ succeeded, checks, portsReleased: true, appPort, cdpPort }, null, 2)
  )
  console.log(JSON.stringify({ succeeded, checks, runRoot, portsReleased: true }, null, 2))
  if (succeeded) {
    await rm(testRoot, { recursive: true, force: true })
    await rm(buildRoot, { recursive: true, force: true })
    await rm(join(runRoot, 'browser-profile'), { recursive: true, force: true })
  }
}
