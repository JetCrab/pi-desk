import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPortReleased,
  isolatedPiEnvironment,
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from '../../../tests/l4-e2e-server-runtime.mjs'

import { screenshot } from '../../../tests/l4-browser-cdp-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const executable = resolve(process.argv[2] ?? '')
const previewOnly = process.env.DESKTOP_EXTERNAL_LINKS_SCOPE === 'preview'
const identifier = previewOnly
  ? 'com.jetcrab.desktop.project-preview-check'
  : 'com.jetcrab.desktop.external-links-test'
const openTargetOnly = process.env.DESKTOP_EXTERNAL_LINKS_SCOPE === 'open-target'
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
  response.setHeader('Access-Control-Allow-Origin', '*')
  requests.push({ url: request.url, userAgent: request.headers['user-agent'] })
  if (request.method === 'POST' && request.url === '/report') {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const report = JSON.parse(body)
      reports.set(report.name, { ...report, count: (reports.get(report.name)?.count ?? 0) + 1 })
      response.writeHead(204).end()
    })
    return
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (previewOnly && request.url.startsWith('/project-preview')) {
    response.end('<!doctype html><html><title>Pi Desk</title><h1>项目预览窗口</h1></html>')
    return
  }
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
  <button id="open-preview" onclick="window.open('${targetUrl}project-preview?cwd=C%3A%2Fexample', '_blank', 'noopener,noreferrer')">独立预览</button>
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
const servicePorts = []
let child
let sourceService
let exit
let output = ''
let passed = false

async function until(probe, description, observeProcess = true, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
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

async function verifyControlOpening(control) {
  const managedReservation = createServer()
  const managedPort = await listen(managedReservation)
  servicePorts.push(managedPort)
  await new Promise((done) => managedReservation.close(done))
  const managedUrl = `http://127.0.0.1:${managedPort}/opened/control-local`
  const remoteUrl = `${targetUrl}opened/control-remote`
  const readyFile = join(root, 'service-ready')
  const probeFile = join(root, 'health-probed')
  const serviceFile = join(root, 'managed-service.cjs')
  const reportHtml = `<!doctype html><html><title>${task}</title><script>
    fetch('${targetUrl}report', { method: 'POST', body: JSON.stringify({
      name: 'control-local', native: Boolean(window.__TAURI_INTERNALS__), userAgent: navigator.userAgent
    }) }).finally(() => window.close());
  </script></html>`
  await writeFile(
    serviceFile,
    `
    const fs = require('node:fs');
    require('node:http').createServer((request, response) => {
      if (request.url === '/health') {
        fs.writeFileSync(${JSON.stringify(probeFile)}, 'probed');
        response.writeHead(fs.existsSync(${JSON.stringify(readyFile)}) ? 200 : 503).end();
      } else {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(${JSON.stringify(reportHtml)});
      }
    }).listen(Number(process.argv[2]), '127.0.0.1');
  `
  )
  const invoke = (command, args = {}) =>
    control.evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`
    )
  const clickTarget = (url, label) =>
    control.evaluate(`(() => {
    const article = [...document.querySelectorAll('article')].find(item => item.dataset.testid === ${JSON.stringify(url)});
    const button = [...(article?.querySelectorAll('button') ?? [])].find(item => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) throw new Error('操作不可用：' + ${JSON.stringify(label)});
    button.click();
  })()`)
  await until(
    async () => (await invoke('get_control_state')).environment.status !== 'checking',
    '环境检查结束'
  )
  for (const value of [
    { url: remoteUrl, server: null, tunnel: null },
    {
      url: managedUrl,
      server: {
        startCommand: `"${process.execPath}" "${serviceFile}" {port}`,
        readyPath: '/health',
        package: null
      },
      tunnel: null
    }
  ])
    await invoke('apply_target_command', { originalUrl: null, value })
  await invoke('set_startup_preference_command', { hideOnStartup: false, hideOnOpen: true })
  await until(
    () =>
      control.evaluate(
        `[...document.querySelectorAll('button')].filter(item => item.textContent.trim() === '浏览器打开').length === 3`
      ),
    '本机和远程地址显示浏览器入口'
  )
  console.info('验收控制中心的远程浏览器打开入口')
  await clickTarget(remoteUrl, '浏览器打开')
  const remoteReport = await until(() => reports.get('control-remote'), '远程地址由系统浏览器访问')
  assert.equal(remoteReport.native, false)
  assert.ok(!(await targets()).some((item) => item.url === remoteUrl), '不得创建远程内置窗口')
  console.info('验收本机服务就绪后才打开系统浏览器')
  await clickTarget(managedUrl, '浏览器打开')
  await until(
    () =>
      readFile(probeFile).then(
        () => true,
        () => false
      ),
    '本机服务已启动并等待健康检查'
  )
  assert.ok(!reports.has('control-local'), '健康检查通过前不得打开浏览器')
  await writeFile(readyFile, 'ready')
  const localReport = await until(() => reports.get('control-local'), '本机就绪后由系统浏览器访问')
  assert.equal(localReport.native, false)
  await until(
    async () =>
      (await invoke('get_control_state')).targets.find((item) => item.url === managedUrl)?.server
        .status === 'running',
    '本机服务保持运行'
  )
  assert.ok(!(await targets()).some((item) => item.url === managedUrl), '不得创建本机内置窗口')
  const log = await readFile(logPath, 'utf8')
  assert.ok(log.includes(`[browser-external-open] source=control url=${managedUrl}`))
  await clickTarget(managedUrl, '浏览器打开')
  await until(() => reports.get('control-local')?.count > 1, '运行中服务可再次用浏览器打开')
  assert.equal(
    (await readFile(logPath, 'utf8')).split('[server-spawn]').length,
    log.split('[server-spawn]').length,
    '再次打开不得重启服务'
  )
  assert.ok(await invoke('plugin:window|is_visible', { label: 'control' }), '外部打开保留控制页')
  for (const theme of ['light', 'dark']) {
    await control.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: theme }]
    })
    for (const [width, height] of [
      [960, 720],
      [720, 560]
    ]) {
      await control.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      })
      const fits = await control.evaluate(`(() => {
        const buttons = [...document.querySelectorAll('button')].filter(item => item.textContent.trim() === '浏览器打开');
        return document.scrollingElement.scrollWidth <= innerWidth && buttons.every(button => {
          const rect = button.getBoundingClientRect();
          return rect.width >= button.scrollWidth && rect.left >= 0 && rect.right <= innerWidth;
        });
      })()`)
      assert.ok(fits, `${theme} ${width} 浏览器按钮不得被裁切或横向溢出`)
      await control.evaluate(
        `(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(resolve)); })()`
      )
      const shot = await control.send('Page.captureScreenshot', { format: 'png' })
      await writeFile(
        join(root, `browser-open-${theme}-${width}.png`),
        Buffer.from(shot.data, 'base64')
      )
    }
  }
  console.info('验收默认内置打开与地址校验仍然有效')
  await clickTarget(targetUrl, '打开')
  const browser = await connect(
    await until(
      async () => (await targets()).find((item) => item.url === targetUrl),
      '原打开按钮仍创建内置窗口'
    )
  )
  await until(
    () => browser.evaluate(`document.querySelector('h1')?.textContent === '外链验收'`),
    '默认内置网页就绪'
  )
  assert.equal(await browser.evaluate('Boolean(window.__TAURI_INTERNALS__)'), true)
  for (const url of ['file:///C:/test', `${targetUrl}not-configured`]) {
    const rejected = await control.evaluate(`(async () => {
      try { await window.__TAURI_INTERNALS__.invoke('open_target_command', { url: ${JSON.stringify(url)}, external: true }); return false; }
      catch { return true; }
    })()`)
    assert.equal(rejected, true, '非HTTP(S)或未配置地址必须拒绝')
  }
  await invoke('stop_server_command', { url: managedUrl })
  await until(
    async () =>
      (await invoke('get_control_state')).targets.find((item) => item.url === managedUrl)?.server
        .status === 'stopped',
    '测试服务正常停止'
  )
  await assertPortReleased(managedPort)
}

async function verifyPreviewOpening(control) {
  const invoke = (command, args = {}) =>
    control.evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`
    )
  const previewPages = async () =>
    (await targets()).filter((item) => new URL(item.url).pathname === '/project-preview')
  const nativeHandles = new Map()
  const nativeWindow = async (handle = null, readTitle = false) => {
    const script = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PreviewWindowTest {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  public static void Run(uint pid, long close, bool readTitle) {
    EnumWindows((h,p) => { uint owner; GetWindowThreadProcessId(h,out owner);
      if(owner == pid) {
        if(readTitle) {
          if(h.ToInt64() == close) {
            var text = new StringBuilder(4096);
            GetWindowText(h, text, text.Capacity);
            Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(text.ToString())));
          }
        } else if(close == 0) Console.WriteLine(h.ToInt64());
        else if(h.ToInt64() == close && !PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero)) throw new Exception("关闭消息发送失败");
      }
      return true;
    }, IntPtr.Zero);
  }
}
'@
[PreviewWindowTest]::Run(${child.pid}, ${handle ?? 0}, $${readTitle})`
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      { timeout: 15_000, windowsHide: true }
    )
    return readTitle
      ? Buffer.from(stdout.trim(), 'base64').toString('utf8')
      : stdout.trim().split(/\s+/).filter(Boolean)
  }
  const expectTitle = async (target, title) => {
    let actual = ''
    await until(async () => {
      actual = await nativeWindow(nativeHandles.get(target.id), true)
      return actual === title
    }, `原生窗口标题：${title}`).catch(async (cause) => {
      const current = (await targets()).find((item) => item.id === target.id)
      throw new Error(`标题不同步：expected=${title} native=${actual} page=${current?.title}`, {
        cause
      })
    })
  }
  let knownHandles = new Set(await nativeWindow())
  const registerWindow = async (target) => {
    const handles = await nativeWindow()
    const added = handles.filter((handle) => !knownHandles.has(handle))
    assert.equal(added.length, 1, '新WebView必须对应唯一原生窗口')
    nativeHandles.set(target.id, added[0])
    knownHandles = new Set(handles)
  }
  const closeWindow = async (target) => {
    assert.ok(nativeHandles.has(target.id), '关闭前必须登记原生窗口')
    await nativeWindow(nativeHandles.get(target.id))
    await until(
      async () => !(await targets()).some((item) => item.id === target.id),
      '预览WebView销毁'
    )
  }
  await until(
    async () => (await invoke('get_control_state')).environment.status !== 'checking',
    '环境检查结束'
  )
  await invoke('set_startup_preference_command', { hideOnStartup: false, hideOnOpen: false })
  await until(
    () =>
      control.evaluate(
        `[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='项目预览')`
      ),
    '控制中心预览入口'
  )
  await control.evaluate(
    `[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='项目预览').click()`
  )
  const first = await until(async () => (await previewPages())[0], '直接预览窗口')
  assert.equal(
    (await targets()).some((item) => item.url === targetUrl),
    false,
    '预览不能先开工作台'
  )
  await registerWindow(first)
  await expectTitle(first, 'Pi Desk')
  const firstPage = await connect(first)
  const exampleTitle = 'example – C:\\example'
  await firstPage.evaluate(`document.title = ${JSON.stringify(exampleTitle)}`)
  await expectTitle(first, exampleTitle)
  await invoke('open_target_command', { url: targetUrl, preview: true })
  await until(async () => (await previewPages()).length === 2, '第二个独立预览窗口')
  const second = (await previewPages()).find((item) => item.id !== first.id)
  await registerWindow(second)
  await expectTitle(second, 'Pi Desk')
  await expectTitle(first, exampleTitle)
  await closeWindow(first)
  assert.equal((await previewPages()).length, 1)
  await invoke('open_target_command', { url: targetUrl, preview: false })
  const workspaceTarget = await until(
    async () => (await targets()).find((item) => item.url === targetUrl),
    '原工作台'
  )
  await registerWindow(workspaceTarget)
  const workspace = await connect(workspaceTarget)
  await until(
    () => workspace.evaluate(`Boolean(document.getElementById('open-preview'))`),
    '工作台页面加载'
  )
  await expectTitle(workspaceTarget, 'Pi Desk')
  await workspace.evaluate(`document.title = '工作台内容标题'`)
  await expectTitle(workspaceTarget, 'Pi Desk')
  await workspace.click('open-preview')
  const deep = await until(
    async () => (await previewPages()).find((item) => item.url.includes('cwd=')),
    '网页同源预览新窗口'
  )
  await registerWindow(deep)
  assert.equal(new URL(deep.url).searchParams.get('cwd'), 'C:/example')
  assert.equal(await workspace.evaluate('location.href'), targetUrl)
  const deepPage = await connect(deep)
  assert.equal(
    await deepPage.evaluate(
      `(async()=>{try{await window.__TAURI_INTERNALS__.invoke('get_control_state');return false}catch{return true}})()`
    ),
    true,
    '预览不得获得控制权限'
  )
  const oldLabel = await workspace.evaluate(
    'window.__TAURI_INTERNALS__.metadata.currentWindow.label'
  )
  await nativeWindow(nativeHandles.get(workspaceTarget.id))
  await until(
    async () => !(await invoke('plugin:window|is_visible', { label: oldLabel })),
    '工作台仍关闭为隐藏'
  )
  assert.ok((await targets()).some((item) => item.id === workspaceTarget.id))
  await invoke('open_target_command', { url: targetUrl })
  assert.equal((await targets()).find((item) => item.url === targetUrl)?.id, workspaceTarget.id)
  await workspace.click('anchor-same-origin')
  await until(() => reports.get('anchor-same-origin'), '同源普通新窗口仍交系统浏览器')
  assert.equal(reports.get('anchor-same-origin').native, false)

  const reservation = createServer()
  const managedPort = await listen(reservation)
  await new Promise((done) => reservation.close(done))
  servicePorts.push(managedPort)
  const managedUrl = `http://127.0.0.1:${managedPort}/workspace`
  const readyFile = join(root, 'preview-service-ready')
  const probeFile = join(root, 'preview-service-probed')
  const managedFile = join(root, 'preview-managed.cjs')
  await writeFile(
    managedFile,
    `const fs=require('node:fs');require('node:http').createServer((req,res)=>{if(req.url==='/health'){fs.writeFileSync(${JSON.stringify(probeFile)},'1');res.writeHead(fs.existsSync(${JSON.stringify(readyFile)})?200:503).end()}else{res.setHeader('Content-Type','text/html');res.end('<h1>启动后独立预览</h1>')}}).listen(Number(process.argv[2]),'127.0.0.1')`
  )
  await invoke('apply_target_command', {
    originalUrl: null,
    value: {
      url: managedUrl,
      server: {
        startCommand: `"${process.execPath}" "${managedFile}" {port}`,
        readyPath: '/health',
        package: null
      },
      tunnel: null
    }
  })
  await invoke('open_target_command', { url: managedUrl, preview: true })
  await until(
    () =>
      readFile(probeFile).then(
        () => true,
        () => false
      ),
    '预览等待服务就绪'
  )
  assert.equal(
    (await targets()).some((item) => item.url.startsWith(`http://127.0.0.1:${managedPort}/`)),
    false
  )
  await writeFile(readyFile, 'ready')
  await until(
    async () =>
      (await targets()).some(
        (item) => item.url === `http://127.0.0.1:${managedPort}/project-preview`
      ),
    '服务就绪直接进入预览'
  )
  assert.equal(
    (await targets()).some((item) => item.url === managedUrl),
    false
  )
  await invoke('delete_target_command', { url: managedUrl })
  await until(
    async () =>
      !(await targets()).some((item) => item.url.startsWith(`http://127.0.0.1:${managedPort}/`)),
    '删除服务清理预览窗口'
  )
  await assertPortReleased(managedPort)

  const sourceReservation = createServer()
  const sourcePort = await listen(sourceReservation)
  await new Promise((done) => sourceReservation.close(done))
  const sourceUrl = `http://127.0.0.1:${sourcePort}/`
  const project = join(root, 'preview-project')
  await mkdir(project)
  await writeFile(join(project, 'README.md'), '# 独立项目预览\n\n桌面窗口中的真实文件内容。\n')
  await writeFile(
    join(agent, 'pi-desk-settings.json'),
    JSON.stringify({ region: { locale: 'zh-CN', timeZone: 'UTC' } })
  )
  sourceService = spawnE2eServer({
    projectRoot,
    agentDir: agent,
    port: sourcePort,
    development: true,
    nextDirectory: join(projectRoot, 'temp/build/desktop-preview', task, 'next'),
    environment: { NODE_OPTIONS: '' },
    onOutput: (chunk) => {
      output += chunk
    }
  })
  await until(
    async () => {
      try {
        return (await fetch(`${sourceUrl}api/health`)).ok
      } catch {
        return false
      }
    },
    '真实Pi Desk就绪',
    true,
    120_000
  )
  await invoke('apply_target_command', {
    originalUrl: null,
    value: { url: sourceUrl, server: null, tunnel: null }
  })
  await invoke('open_target_command', { url: sourceUrl, preview: true })
  const liveTarget = await until(
    async () => (await targets()).find((item) => item.url === `${sourceUrl}project-preview`),
    '真实独立预览页'
  )
  await registerWindow(liveTarget)
  const live = await connect(liveTarget)
  await until(
    () => live.evaluate(`Boolean(document.querySelector('[data-testid="project-picker"]'))`),
    '真实目录选择页',
    true,
    120_000
  )
  await expectTitle(liveTarget, 'Pi Desk')
  await live.send('Page.navigate', {
    url: `${sourceUrl}project-preview?cwd=${encodeURIComponent(project)}`
  })
  await until(
    () =>
      live.evaluate(`Boolean(document.querySelector('[data-testid="project-file-README.md"]'))`),
    '真实文件树',
    true,
    60_000
  )
  await live.evaluate(`document.querySelector('[data-testid="project-file-README.md"]').click()`)
  await until(
    () =>
      live.evaluate(
        `document.querySelector('[data-testid="markdown-preview"]')?.textContent.includes('桌面窗口中的真实文件内容')`
      ),
    '真实Markdown展示',
    true,
    60_000
  )
  const projectTitle = `preview-project – ${project}`
  await expectTitle(liveTarget, projectTitle)
  await live.evaluate(
    `[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='切换项目').click()`
  )
  await expectTitle(liveTarget, 'Pi Desk')
  await live.evaluate('history.back()')
  await expectTitle(liveTarget, projectTitle)
  await live.evaluate('history.forward()')
  await expectTitle(liveTarget, 'Pi Desk')
  await live.evaluate('history.back()')
  await expectTitle(liveTarget, projectTitle)
  for (const theme of ['light', 'dark']) {
    await live.evaluate(`document.documentElement.classList.toggle('dark',${theme === 'dark'})`)
    await live.evaluate(
      `document.querySelectorAll('nextjs-portal').forEach(element=>element.style.setProperty('display','none','important'))`
    )
    await writeFile(join(root, `project-preview-${theme}.png`), await screenshot(live))
  }
  await closeWindow(liveTarget)
  assert.equal((await fetch(`${sourceUrl}api/health`)).ok, true, '关闭预览不停止共享服务')
  for (const item of await previewPages()) await closeWindow(item)
  assert.equal((await previewPages()).length, 0)
  await invoke('delete_target_command', { url: sourceUrl })
  console.info('原生预览入口、动态标题与导航、启动就绪、窗口销毁、权限与真实文件预览通过')
}

try {
  child = spawn(executable, [], {
    cwd: root,
    env: {
      ...process.env,
      ...isolatedPiEnvironment(agent),
      PI_DESK_DESKTOP_DATA_DIR: root,
      WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
      ...(openTargetOnly || previewOnly ? { PI_DESK_DESKTOP_DISCOVERY_PATH: '' } : {})
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
    () => control.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`),
    '控制页 Tauri 桥就绪'
  )
  if (previewOnly) {
    await verifyPreviewOpening(control)
  } else if (openTargetOnly) {
    await verifyControlOpening(control)
  } else {
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
  }
  assert.deepEqual(control.errors, [], '控制中心不得出现 JavaScript 异常')
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
  if (sourceService) await stopE2eServerTree(sourceService)
  for (const port of servicePorts) await assertPortReleased(port)
  if (passed) await rm(agentRoot, { recursive: true, force: true })
}
console.info(`桌面外链验收通过，进程树与端口已释放：${root}`)
