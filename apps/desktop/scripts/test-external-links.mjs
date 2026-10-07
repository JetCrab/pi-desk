import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPortReleased,
  isolatedPiEnvironment,
  prepareIsolatedPiDirectory,
  stopE2eServerTree
} from '../../../tests/l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const executable = resolve(process.argv[2] ?? '')
const identifier = 'com.jetcrab.desktop.external-links-test'
assert.equal(process.platform, 'win32', '外部浏览器验收仅支持 Windows')
assert.ok(process.argv[2], '请传入隔离构建的桌面 exe')
assert.ok(
  (await readFile(executable)).includes(Buffer.from(identifier)),
  '测试程序必须使用独立 identifier，禁止接管真实桌面实例'
)
const task = `external-links-${process.pid}-${Date.now()}`
const root = join(projectRoot, 'temp/run/desktop-external-links', task)
const agentRoot = join(projectRoot, 'temp/pi/desktop-external-links', task)
const agent = join(agentRoot, 'agent')
await mkdir(root, { recursive: true })
await prepareIsolatedPiDirectory(agent)

const reports = new Map()
const requests = []
let pageHtml = ''
function handle(request, response) {
  requests.push({ url: request.url, userAgent: request.headers['user-agent'] })
  if (request.method === 'POST' && request.url === '/report') {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const report = JSON.parse(body)
      reports.set(report.name, report)
      response.writeHead(204).end()
    })
    return
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (request.url.startsWith('/opened/')) {
    const name = request.url.slice('/opened/'.length)
    response.end(`<!doctype html><html><title>${task}</title><script>
      fetch('/report', { method: 'POST', body: JSON.stringify({
        name: ${JSON.stringify(name)},
        native: Boolean(window.__TAURI_INTERNALS__),
        userAgent: navigator.userAgent
      }) }).finally(() => window.close());
    </script></html>`)
    return
  }
  response.end(pageHtml)
}
async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
const fixture = createServer(handle)
const fixturePort = await listen(fixture)
const externalFixture = createServer(handle)
const externalPort = await listen(externalFixture)
const reservation = createServer()
const debugPort = await listen(reservation)
await new Promise((done) => reservation.close(done))
const targetUrl = `http://127.0.0.1:${fixturePort}/`
const externalUrl = `http://127.0.0.1:${externalPort}/`
pageHtml = `<!doctype html><html lang="zh-CN"><title>外链验收</title><h1>外链验收</h1>
  <button id="open-secure" onclick="window.open('${externalUrl}opened/open-secure', '_blank', 'noopener,noreferrer')">安全新窗口</button>
  <a id="anchor-secure" href="${externalUrl}opened/anchor-secure" target="_blank" rel="noopener noreferrer"><span>安全新窗口链接</span></a>
  <button id="open-plain" onclick="window.open('${externalUrl}opened/open-plain', '_blank')">普通新窗口</button>
  <a id="anchor-same-origin" href="${targetUrl}opened/anchor-same-origin" target="_blank">同源新窗口链接</a>
  <a id="anchor-cross-origin" href="${externalUrl}opened/anchor-cross-origin">跨域链接</a>
  <a id="anchor-internal" href="${targetUrl}internal">站内链接</a>
  <a id="anchor-blocked" href="about:blank" target="_blank">禁止的地址</a>
</html>`
await writeFile(join(root, 'config.json'), JSON.stringify({ targets: [{ url: targetUrl }] }))
const logPath = join(root, 'logs/desktop.log')
const pages = []
let child
let exit
let output = ''
let passed = false

async function until(probe, description, observeProcess = true) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (observeProcess && child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`桌面进程提前退出：${child.exitCode}`)
    }
    const result = await probe()
    if (result) return result
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`等待超时：${description}`)
}
async function targets() {
  try {
    const result = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
      signal: AbortSignal.timeout(1000)
    })
    return await result.json()
  } catch {
    return []
  }
}
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  let sequence = 0
  const pending = new Map()
  const errors = []
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  })
  function send(method, params = {}) {
    return new Promise((resolveCall, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, 10_000)
      pending.set(id, { resolve: resolveCall, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  const page = {
    errors,
    send,
    async evaluate(expression) {
      const response = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails))
      return response.result.value
    },
    async click(id) {
      const point = await this.evaluate(`(() => {
        const element = document.getElementById(${JSON.stringify(id)});
        if (!element) throw new Error('未找到操作');
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`)
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        ...point
      })
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        ...point
      })
    },
    close() {
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error('调试连接已关闭'))
      }
      pending.clear()
      socket.close()
    }
  }
  pages.push(page)
  await send('Runtime.enable')
  await send('Page.enable')
  return page
}

try {
  child = spawn(executable, [], {
    cwd: root,
    env: {
      ...process.env,
      ...isolatedPiEnvironment(agent),
      PI_DESK_DESKTOP_DATA_DIR: root,
      WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout.on('data', (data) => (output += data))
  child.stderr.on('data', (data) => (output += data))
  exit = once(child, 'exit')
  const control = await connect(
    await until(
      async () => (await targets()).find((item) => item.url.startsWith('http://tauri.localhost')),
      '控制中心'
    )
  )
  await until(
    () =>
      control.evaluate(
        `[...document.querySelectorAll('button')].some(item => item.textContent === '打开')`
      ),
    '打开入口'
  )
  await control.evaluate(
    `[...document.querySelectorAll('button')].find(item => item.textContent === '打开').click()`
  )
  let browser = await connect(
    await until(async () => (await targets()).find((item) => item.url === targetUrl), '目标网页')
  )
  await until(
    () => browser.evaluate(`document.querySelector('h1')?.textContent === '外链验收'`),
    '目标网页就绪'
  )
  if (process.env.DESKTOP_EXTERNAL_LINKS_SCOPE === 'recovery') {
    console.info('验收网页进程退出后重新打开窗口')
    const previousLoads = requests.filter((request) => request.url === '/').length
    await browser.send('Page.crash').catch(() => undefined)
    browser.close()
    await control.evaluate(
      `[...document.querySelectorAll('button')].find(item => item.textContent === '打开').click()`
    )
    await until(
      () => requests.filter((request) => request.url === '/').length > previousLoads,
      '失效网页在重新打开后恢复访问'
    )
    browser = await connect(
      await until(
        async () => (await targets()).find((item) => item.url === targetUrl),
        '恢复后的网页'
      )
    )
    await until(
      () => browser.evaluate(`document.querySelector('h1')?.textContent === '外链验收'`),
      '恢复后的网页就绪'
    )
  }
  for (const name of [
    'open-secure',
    'anchor-secure',
    'open-plain',
    'anchor-same-origin',
    'anchor-cross-origin'
  ]) {
    console.info(`验收外部浏览器：${name}`)
    await browser.click(name)
    const report = await until(() => reports.get(name), `${name} 在真实浏览器访问`)
    assert.equal(report.native, false, '外链必须由系统浏览器访问，不能留在桌面 WebView')
    assert.equal(await browser.evaluate('location.href'), targetUrl, '外链不得替换当前工作台')
    const log = await readFile(logPath, 'utf8')
    assert.ok(
      log.includes(
        `[browser-external-open] source=${name === 'anchor-cross-origin' ? 'navigation' : 'new-window'} url=${name === 'anchor-same-origin' ? targetUrl : externalUrl}opened/${name}`
      ),
      '壳必须记录外部打开的真实结果'
    )
  }
  await browser.click('anchor-blocked')
  await until(async () => {
    const log = await readFile(logPath, 'utf8')
    return log.includes('url=about:blank supported=false')
  }, '拒绝非 HTTP(S) 新窗口并记录原因')
  assert.equal(await browser.evaluate('location.href'), targetUrl)
  const previousLoads = requests.filter((request) => request.url === '/').length
  const previousCommands = (await readFile(logPath, 'utf8')).split(
    '[command-end] command=open-target'
  ).length
  await control.evaluate(
    `[...document.querySelectorAll('button')].find(item => item.textContent === '打开').click()`
  )
  await until(async () => {
    const log = await readFile(logPath, 'utf8')
    return log.split('[command-end] command=open-target').length > previousCommands
  }, '正常窗口再次打开完成')
  assert.equal(
    requests.filter((request) => request.url === '/').length,
    previousLoads,
    '正常窗口再次打开不得重载网页'
  )
  await browser.click('anchor-internal')
  await until(() => browser.evaluate('location.pathname === "/internal"'), '站内链接保留当前窗口')
  assert.equal(await browser.evaluate('Boolean(window.__TAURI_INTERNALS__)'), true)
  assert.equal(
    await browser.evaluate(`(async () => {
    try { await window.__TAURI_INTERNALS__.invoke('get_control_state'); return false; }
    catch { return true; }
  })()`),
    true,
    '外部网页不能调用控制命令'
  )
  assert.deepEqual(browser.errors, [], '网页不得出现 JavaScript 异常')
  passed = true
} catch (error) {
  console.error(`外部浏览器验收失败，现场：${root}`)
  throw error
} finally {
  await writeFile(
    join(root, 'observations.json'),
    JSON.stringify({ passed, reports: [...reports.values()], requests }, null, 2)
  )
  await writeFile(join(root, 'process.log'), output)
  for (const page of pages) page.close()
  if (child) {
    try {
      await stopE2eServerTree({ child, exit, port: debugPort, managed: false })
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      await until(
        async () => {
          try {
            await assertPortReleased(debugPort)
            return true
          } catch (cause) {
            if (cause.code !== 'EADDRINUSE') throw cause
            return false
          }
        },
        'WebView2 调试端口释放',
        false
      )
    }
  }
  for (const [server, port] of [
    [fixture, fixturePort],
    [externalFixture, externalPort]
  ]) {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    await assertPortReleased(port)
  }
  if (passed) await rm(agentRoot, { recursive: true, force: true })
}
console.info(`桌面外链验收通过，进程树与端口已释放：${root}`)
