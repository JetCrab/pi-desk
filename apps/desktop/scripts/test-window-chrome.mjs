import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import {
  assertPortReleased,
  isolatedPiEnvironment,
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from '../../../tests/l4-e2e-server-runtime.mjs'
import {
  createCdpPage,
  evaluate,
  reservePort,
  screenshot,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForBrowserReady,
  waitForHttp
} from '../../../tests/l4-browser-cdp-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const executable = resolve(process.argv[2] ?? '')
const protocolOnly = process.argv.includes('--protocol-only')
const identifier = 'com.jetcrab.desktop.window-chrome-test'
assert.equal(process.platform, 'win32')
assert.ok(process.argv[2], '传入独立 identifier 的桌面 exe')
assert.ok((await readFile(executable)).includes(Buffer.from(identifier)), '禁止接管真实桌面实例')
const task = `window-chrome-${process.pid}-${Date.now()}`
const root = join(projectRoot, 'temp/run/desktop-window-chrome', task)
const agentRoot = join(projectRoot, 'temp/pi/desktop-window-chrome', task)
const agent = join(agentRoot, 'agent')
await mkdir(root, { recursive: true })
await prepareIsolatedPiDirectory(agent)
await writeFile(
  join(agent, 'pi-desk-settings.json'),
  JSON.stringify({ region: { locale: 'zh-CN', timeZone: 'UTC' } })
)
const project = join(root, 'titlebar-project')
await mkdir(project)
await writeFile(join(project, 'README.md'), '# 桌面窗口预览\n\n窗口标题栏与正文共享明暗主题。\n')
const debugPort = await reservePort()
const sourcePort = await reservePort()
const sourceUrl = `http://127.0.0.1:${sourcePort}/`
const fixture = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (request.url === '/frame') {
    response.end(`<!doctype html><script>
      fetch('http://pi-desk-window.localhost/', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'minimize'})})
        .then(response=>response.status,()=> 'rejected')
        .then(result=>parent.postMessage({frameReady:true,bridge:Boolean(window.__PI_DESK_WINDOW__),result},'*'));
    </script>`)
    return
  }
  response.end(
    '<!doctype html><html lang="zh-CN"><title>兼容页面</title><h1>未接入标题栏的页面</h1></html>'
  )
})
fixture.listen(0, '127.0.0.1')
await once(fixture, 'listening')
const fixturePort = fixture.address().port
const legacyUrl = `http://127.0.0.1:${fixturePort}/`
await writeFile(
  join(root, 'config.json'),
  JSON.stringify({ targets: [{ url: sourceUrl }, { url: legacyUrl }] })
)
const pages = []
const results = []
let output = ''
let child
let source
let browser
let browserPort = 0
let passed = false
const until = async (probe, label, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`等待超时：${label}`)
}
const targets = async () => {
  try {
    return await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })
    ).json()
  } catch {
    return []
  }
}
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  const pending = new Map()
  const errors = []
  let sequence = 0
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString())
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map((value) => value.value ?? value.description))
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  })
  const page = {
    errors,
    send(method, params = {}) {
      return new Promise((resolveCall, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} 超时`))
        }, 15_000)
        pending.set(id, { resolve: resolveCall, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
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
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  return page
}
const clickWindowButton = (page, label) =>
  evaluate(
    page,
    `(() => {
  const button = document.querySelector('[data-testid="desktop-titlebar"] button[aria-label="${label}"]');
  if (!button) throw new Error('窗口按钮不存在：${label}'); button.click();
})()`
  )
const ready = (page) =>
  waitFor(
    page,
    `Boolean(document.querySelector('[data-testid="desktop-titlebar"]:not([hidden])'))`,
    '标题栏就绪',
    () => output,
    120_000
  )
const invoke = (page, command, args = {}) =>
  evaluate(
    page,
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`
  )
const bridge = (page, action) =>
  evaluate(page, `window.__PI_DESK_WINDOW__.invoke(${JSON.stringify(action)})`)

// Win32 结果独立于网页状态，验证系统装饰、原生窗口尺寸和关闭结果。
async function native(action = 'list', handle = 0, x = 0, y = 0) {
  const script = `Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class ChromeWindowTest {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point point);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetricsForDpi(int index, uint dpi);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x,int y,int w,int height,uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
  public static void Run(uint pid,string action,long value,int x,int y) {
    var h = new IntPtr(value);
    if(action == "list") {
      EnumWindows((w,p) => { uint owner; GetWindowThreadProcessId(w,out owner);
        if(owner == pid && (GetWindowLong(w,-16) & 0x00080000) != 0) {
          Rect r; GetWindowRect(w,out r); Point origin = new Point(); ClientToScreen(w,ref origin);
          Console.WriteLine("{\\"handle\\":"+w.ToInt64()+",\\"visible\\":"+IsWindowVisible(w).ToString().ToLower()+",\\"minimized\\":"+IsIconic(w).ToString().ToLower()+",\\"maximized\\":"+IsZoomed(w).ToString().ToLower()+",\\"decorated\\":"+(origin.y-r.top>=GetSystemMetricsForDpi(4,GetDpiForWindow(w))).ToString().ToLower()+",\\"x\\":"+r.left+",\\"y\\":"+r.top+",\\"width\\":"+(r.right-r.left)+",\\"height\\":"+(r.bottom-r.top)+"}");
        } return true;
      },IntPtr.Zero); return;
    }
    uint windowOwner; GetWindowThreadProcessId(h,out windowOwner);
    if(windowOwner != pid) throw new Exception("窗口不属于测试进程");
    if(action == "maximize") PostMessage(h,0x112,new IntPtr(0xf030),IntPtr.Zero);
    if(action == "restore") PostMessage(h,0x112,new IntPtr(0xf120),IntPtr.Zero);
    if(action == "close") PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);
    if(action == "resize") SetWindowPos(h,IntPtr.Zero,60,60,x,y,0x0044);
    if(action == "hit-test") {
      Rect r; GetWindowRect(h,out r);
      Console.WriteLine(SendMessage(h,0x84,IntPtr.Zero,new IntPtr(((r.bottom-2)<<16)|((r.right-2)&0xffff))).ToInt64());
    }
    if(action == "click" || action == "drag" || action == "snap") {
      SetForegroundWindow(h);
      if(GetForegroundWindow()!=h) throw new Exception("无法聚焦测试窗口");
      if(action == "snap") {
        keybd_event(0x5b,0,0,UIntPtr.Zero); keybd_event(0x25,0,0,UIntPtr.Zero);
        keybd_event(0x25,0,2,UIntPtr.Zero); keybd_event(0x5b,0,2,UIntPtr.Zero);
      } else {
        Rect r; GetWindowRect(h,out r); SetCursorPos(r.left+x,r.top+y);
        mouse_event(2,0,0,0,UIntPtr.Zero);
        // 鼠标输入需要分帧送达 WebView 和原生拖动循环。
        Thread.Sleep(100); if(action == "drag") SetCursorPos(r.left+x+80,r.top+y+60);
        Thread.Sleep(100); mouse_event(4,0,0,0,UIntPtr.Zero);
      }
    }
  }
}
'@
[ChromeWindowTest]::Run(${child.pid},'${action}',${handle},${x},${y})`
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { timeout: 20_000, windowsHide: true }
  )
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
const record = (name) => {
  results.push(name)
  console.info(`通过：${name}`)
}
const save = async (page, name) => {
  await evaluate(
    page,
    `document.querySelectorAll('nextjs-portal').forEach(element=>element.style.setProperty('display','none','important'))`
  )
  await writeFile(join(root, `${name}.png`), await screenshot(page))
}

try {
  source = spawnE2eServer({
    projectRoot,
    agentDir: agent,
    port: sourcePort,
    development: true,
    nextDirectory: join(projectRoot, 'temp/build/desktop-window-chrome', task, 'next'),
    environment: { NODE_OPTIONS: '' },
    onOutput: (chunk) => {
      output += chunk
    }
  })
  await waitForHttp(`${sourceUrl}api/health`, 120_000, 'Pi Desk', () => output)
  child = spawn(executable, [], {
    cwd: root,
    env: {
      ...process.env,
      ...isolatedPiEnvironment(agent),
      PI_DESK_DESKTOP_DATA_DIR: root,
      PI_DESK_DESKTOP_DISCOVERY_PATH: '',
      WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout.on('data', (data) => {
    output += data
  })
  child.stderr.on('data', (data) => {
    output += data
  })
  const control = await connect(
    await until(
      async () => (await targets()).find((item) => item.url.startsWith('http://tauri.localhost')),
      '控制中心'
    )
  )
  await ready(control)
  await invoke(control, 'set_startup_preference_command', {
    hideOnStartup: false,
    hideOnOpen: false,
    showOnClose: true
  })
  const controlHandle = (await native()).find((item) => item.visible)?.handle
  assert.ok(controlHandle)
  const state = async (handle) => (await native()).find((item) => item.handle === handle)
  assert.equal((await state(controlHandle)).decorated, false)
  for (const theme of ['light', 'dark']) {
    await control.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: theme }]
    })
    await save(control, `control-${theme}`)
  }
  await clickWindowButton(control, '最大化')
  await until(async () => (await state(controlHandle)).maximized, '原生最大化')
  await waitFor(
    control,
    `Boolean(document.querySelector('[data-testid="desktop-titlebar"] [aria-label="还原"]'))`,
    '还原按钮'
  )
  await clickWindowButton(control, '还原')
  await until(async () => !(await state(controlHandle)).maximized, '还原')
  await native('maximize', controlHandle)
  await waitFor(
    control,
    `Boolean(document.querySelector('[data-testid="desktop-titlebar"] [aria-label="还原"]'))`,
    '系统最大化状态同步'
  )
  await native('restore', controlHandle)
  await clickWindowButton(control, '最小化')
  await until(async () => (await state(controlHandle)).minimized, '最小化')
  await native('restore', controlHandle)
  record('真实原生装饰、最大化/还原/最小化与系统状态同步')
  await native('resize', controlHandle, 960, 720)
  const beforeDrag = await state(controlHandle)
  const dragPoint = await evaluate(
    control,
    `(() => {const r=document.querySelector('[data-testid="desktop-titlebar"]').getBoundingClientRect();return {x:Math.round(r.width/2),y:Math.round(r.height/2)}})()`
  )
  await evaluate(
    control,
    `(() => {
    const title=document.querySelector('[data-testid="desktop-titlebar"] span');
    window.titleColors=[];
    window.titleColorFrame=0;
    const capture=()=>{window.titleColors.push(getComputedStyle(title).color);window.titleColorFrame=requestAnimationFrame(capture)};
    capture();
  })()`
  )
  if (!protocolOnly) {
    await native('click', controlHandle, dragPoint.x, dragPoint.y)
    await native('drag', controlHandle, dragPoint.x, dragPoint.y)
  } else {
    for (const type of ['blur', 'focus']) {
      await evaluate(
        control,
        `new Promise(resolve=>{window.dispatchEvent(new Event('${type}'));requestAnimationFrame(()=>requestAnimationFrame(resolve))})`
      )
    }
  }
  const titleColors = await evaluate(
    control,
    `(() => {cancelAnimationFrame(window.titleColorFrame);return window.titleColors})()`
  )
  assert.ok(titleColors.length > 0, '需采集标题颜色')
  assert.equal(new Set(titleColors).size, 1, '标题文字颜色保持不变')
  if (!protocolOnly) {
    assert.ok(titleColors.length > 1, '点击和拖动需采集多帧标题颜色')
    await until(async () => {
      const s = await state(controlHandle)
      return s.x !== beforeDrag.x && s.y !== beforeDrag.y
    }, '标题栏拖动')
  }
  assert.equal((await native('hit-test', controlHandle))[0], 17, '右下角提供系统缩放命中区')
  await control.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 2,
    ...dragPoint
  })
  await control.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 2,
    ...dragPoint
  })
  await until(async () => (await state(controlHandle)).maximized, '双击最大化')
  await native('restore', controlHandle)
  if (!protocolOnly) {
    await native('snap', controlHandle)
    await until(async () => {
      const s = await state(controlHandle)
      return s.width !== beforeDrag.width && s.height !== beforeDrag.height
    }, 'Win+Left贴边')
    await native('restore', controlHandle)
  }
  record(
    protocolOnly
      ? 'CDP双击、原生边缘命中区与模拟focus/blur颜色；未覆盖真实鼠标拖动和系统贴边'
      : '标题栏拖动、双击、边缘缩放命中区和系统贴边'
  )

  let known = new Set((await native()).map((item) => item.handle))
  const open = async (url, preview = false) => {
    await invoke(control, 'open_target_command', { url, preview })
    const target = await until(
      async () =>
        (await targets()).find((item) =>
          preview ? item.url.startsWith(`${url}project-preview`) : item.url === url
        ),
      '网页窗口'
    )
    const page = await connect(target)
    const added = await until(
      async () => (await native()).find((item) => !known.has(item.handle)),
      '新增原生窗口'
    )
    known.add(added.handle)
    return { page, target, handle: added.handle }
  }
  const legacy = await open(legacyUrl)
  await waitFor(
    legacy.page,
    `document.querySelector('h1')?.textContent==='未接入标题栏的页面'`,
    '旧页面加载'
  )
  assert.equal((await state(legacy.handle)).decorated, true)
  const rejected = await evaluate(
    legacy.page,
    `(async()=>{
    const call=window.__TAURI_INTERNALS__.invoke;
    return Promise.all([
      call('get_control_state'),
      call('plugin:window|close',{label:'control'}),
      window.__PI_DESK_WINDOW__.invoke('destroy')
    ].map(p=>p.then(()=>false,()=>true)))
  })()`
  )
  assert.deepEqual(rejected, [true, true, true])
  const invalidTargetStatus = await evaluate(
    legacy.page,
    `fetch('http://pi-desk-window.localhost/', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'minimize',label:'control'})}).then(response=>response.status)`
  )
  assert.equal(invalidTargetStatus, 400, '拒绝指定其他窗口目标的请求')
  await bridge(legacy.page, 'state')
  assert.equal((await state(legacy.handle)).minimized, false, '附加其他窗口目标的消息必须拒绝')
  assert.equal((await state(controlHandle)).minimized, false)
  await bridge(legacy.page, 'minimize')
  await until(async () => (await state(legacy.handle)).minimized, '网页仅可最小化当前窗口')
  assert.equal((await state(controlHandle)).minimized, false)
  await native('restore', legacy.handle)
  const frameResult = await evaluate(
    control,
    `new Promise(resolve => {
    const listener=event=>{if(event.origin!==${JSON.stringify(legacyUrl.slice(0, -1))} || !event.data?.frameReady)return;window.removeEventListener('message',listener);resolve(event.data)};
    window.addEventListener('message',listener);
    const frame=document.createElement('iframe');frame.src=${JSON.stringify(`${legacyUrl}frame`)};frame.hidden=true;document.body.append(frame);
  })`
  )
  assert.equal(frameResult.bridge, false, '子框架不注入桌面窗口能力')
  assert.equal(frameResult.result, 'rejected', '跨源子框架请求被来源校验拒绝')
  await bridge(control, 'state')
  assert.equal((await state(controlHandle)).minimized, false, '跨源子框架不能操作宿主窗口')
  await bridge(legacy.page, 'attach')
  assert.equal((await state(legacy.handle)).decorated, false)
  await legacy.page.send('Page.navigate', { url: `${legacyUrl}other` })
  await until(async () => (await state(legacy.handle)).decorated, '导航旧页面恢复装饰')
  await bridge(legacy.page, 'attach')
  await legacy.page.send('Page.reload')
  await until(async () => (await state(legacy.handle)).decorated, '刷新旧页面恢复装饰')
  record('旧页面回退、刷新/导航恢复、命令白名单与跨窗口拒绝')
  await bridge(legacy.page, 'attach')
  await legacy.page.send('Page.crash').catch(() => undefined)
  await until(async () => (await state(legacy.handle)).decorated, '渲染崩溃恢复系统标题栏')
  record('网页渲染进程失效恢复系统标题栏')

  const workspace = await open(sourceUrl)
  await ready(workspace.page)
  await waitFor(
    workspace.page,
    `Boolean(document.querySelector('.pi-desk-workbench'))`,
    '真实工作台',
    () => output,
    120_000
  )
  assert.equal((await state(workspace.handle)).decorated, false)
  const assertLayout = async (page, selector) => {
    const result = await evaluate(
      page,
      `(() => {
      const title=document.querySelector('[data-testid="desktop-titlebar"]').getBoundingClientRect();
      const main=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {top:main.top,titleBottom:title.bottom,bottom:main.bottom,height:innerHeight,scroll:document.documentElement.scrollWidth,width:innerWidth};
    })()`
    )
    assert.ok(result.top >= result.titleBottom - 1, JSON.stringify(result))
    assert.ok(result.bottom <= result.height + 1, JSON.stringify(result))
    assert.ok(result.scroll <= result.width, JSON.stringify(result))
  }
  await assertLayout(workspace.page, '.pi-desk-workbench')
  for (const theme of ['light', 'dark']) {
    await evaluate(
      workspace.page,
      `document.documentElement.classList.toggle('dark',${theme === 'dark'})`
    )
    await save(workspace.page, `workspace-${theme}`)
  }
  await native('resize', workspace.handle, 720, 480)
  await evaluate(workspace.page, `document.documentElement.dataset.piDeskDisplaySize='large'`)
  await assertLayout(workspace.page, '.pi-desk-workbench')
  await save(workspace.page, 'workspace-small-large-text')
  await evaluate(workspace.page, `document.documentElement.dataset.piDeskDisplaySize='compact'`)
  await native('resize', workspace.handle, 1280, 820)
  await evaluate(workspace.page, `document.querySelector('button[title="设置"]').click()`)
  await waitFor(
    workspace.page,
    `Boolean(document.querySelector('[data-slot="app-dialog-content"]'))`,
    '设置弹窗'
  )
  await native('resize', workspace.handle, 720, 480)
  await save(workspace.page, 'workspace-settings-small')
  const modalBounds = await evaluate(
    workspace.page,
    `(() => {
    const title=document.querySelector('[data-testid="desktop-titlebar"]').getBoundingClientRect();
    const dialog=document.querySelector('[data-slot="app-dialog-content"]').getBoundingClientRect();
    const button=document.querySelector('[data-testid="desktop-titlebar"] [aria-label="最大化"]');
    const r=button.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return {top:dialog.top,titleBottom:title.bottom,bottom:dialog.bottom,height:innerHeight,buttonAvailable:button===hit||button.contains(hit)};
  })()`
  )
  assert.ok(modalBounds.top >= modalBounds.titleBottom - 1, JSON.stringify(modalBounds))
  assert.ok(modalBounds.bottom <= modalBounds.height + 1, JSON.stringify(modalBounds))
  assert.equal(modalBounds.buttonAvailable, true, '弹窗不遮挡窗口按钮')
  await clickWindowButton(workspace.page, '最大化')
  await until(async () => (await state(workspace.handle)).maximized, '弹窗打开时仍可控制窗口')
  await evaluate(
    workspace.page,
    `document.querySelector('[data-slot="app-dialog-close-button"]').click()`
  )
  await native('restore', workspace.handle)
  await workspace.page.send('Page.reload')
  await ready(workspace.page)
  await until(async () => !(await state(workspace.handle)).decorated, '刷新后重新接入')
  await clickWindowButton(workspace.page, '关闭')
  await until(async () => !(await state(workspace.handle)).visible, '工作台关闭为隐藏')
  assert.ok((await targets()).some((item) => item.id === workspace.target.id))
  await invoke(control, 'open_target_command', { url: sourceUrl })
  await until(async () => (await state(workspace.handle)).visible, '原窗口恢复')
  record('真实工作台高度、刷新重新接入、关闭隐藏与原窗口恢复')

  const preview = await open(sourceUrl, true)
  await ready(preview.page)
  await preview.page.send('Page.navigate', {
    url: `${sourceUrl}project-preview?cwd=${encodeURIComponent(project)}`
  })
  await ready(preview.page)
  await waitFor(
    preview.page,
    `Boolean(document.querySelector('[data-testid="project-file-README.md"]'))`,
    '项目文件树',
    () => output,
    120_000
  )
  await evaluate(
    preview.page,
    `document.querySelector('[data-testid="project-file-README.md"]').click()`
  )
  await waitFor(
    preview.page,
    `document.querySelector('[data-testid="markdown-preview"]')?.textContent.includes('桌面窗口预览')`,
    '文件预览'
  )
  await waitFor(
    preview.page,
    `document.querySelector('.pi-desk-titlebar-title')?.textContent===document.title && document.title.includes('titlebar-project')`,
    '动态标题'
  )
  await assertLayout(preview.page, '[data-testid="project-preview-page"]')
  for (const theme of ['light', 'dark']) {
    await evaluate(
      preview.page,
      `document.documentElement.classList.toggle('dark',${theme === 'dark'})`
    )
    await save(preview.page, `preview-${theme}`)
  }
  await clickWindowButton(preview.page, '关闭')
  await until(
    async () => !(await targets()).some((item) => item.id === preview.target.id),
    '预览销毁'
  )
  assert.equal((await fetch(`${sourceUrl}api/health`)).ok, true)
  record('真实项目预览标题、文件内容、关闭销毁且服务继续')

  await clickWindowButton(control, '关闭')
  await until(async () => !(await state(controlHandle)).visible, '控制中心关闭隐藏')
  assert.ok(child.exitCode === null)
  record('控制中心关闭为隐藏')

  browserPort = await reservePort()
  const edgePath =
    process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  browser = spawnEdge(edgePath, browserPort, join(root, 'edge'))
  await waitForBrowserReady(browser, browserPort)
  const plain = await createCdpPage(browserPort, sourceUrl)
  pages.push(plain)
  await waitFor(
    plain,
    `Boolean(document.querySelector('.pi-desk-workbench'))`,
    '普通浏览器工作台',
    () => output,
    120_000
  )
  assert.equal(
    await evaluate(
      plain,
      `Boolean(window.__PI_DESK_WINDOW__) || document.documentElement.hasAttribute('data-pi-desk-window')`
    ),
    false
  )
  assert.equal(
    await evaluate(
      plain,
      `Boolean(document.querySelector('[data-testid="desktop-titlebar"]:not([hidden])'))`
    ),
    false
  )
  assert.equal(
    await evaluate(
      plain,
      `Math.round(document.querySelector('.pi-desk-workbench').getBoundingClientRect().height)===innerHeight`
    ),
    true
  )
  await save(plain, 'browser-workspace')
  record('普通浏览器保持原布局且无桌面窗口能力')

  const authResponse = await fetch(`${sourceUrl}api/auth-settings/replace`, {
    method: 'POST',
    headers: {
      Origin: sourceUrl.replace(/\/$/, ''),
      'X-Pi-Desk-Client-Id': randomUUID(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ password: 'WindowChrome-Test-123' })
  })
  const authResult = await authResponse.json()
  assert.equal(authResponse.status, 200, JSON.stringify(authResult))
  assert.equal(authResult.code, 0, JSON.stringify(authResult))
  await workspace.page.send('Page.navigate', { url: `${sourceUrl}login` })
  await waitFor(
    workspace.page,
    `location.pathname === '/login' && Boolean(document.querySelector('#login-title')) && Boolean(document.querySelector('#password'))`,
    '已启用登录保护的真实登录页',
    () => output,
    120_000
  )
  await ready(workspace.page)
  await until(async () => !(await state(workspace.handle)).decorated, '登录页接入自定义标题栏')
  await assertLayout(workspace.page, 'main')
  await evaluate(workspace.page, `document.documentElement.classList.add('dark')`)
  await save(workspace.page, 'login-dark')
  record('启用隔离登录保护后的真实登录页、标题栏接入与正文高度')
  assert.deepEqual(control.errors, [])
  assert.deepEqual(workspace.page.errors, [])
  assert.deepEqual(preview.page.errors, [])
  passed = true
} catch (error) {
  const diagnostics = await Promise.all(
    pages.map(async (page) => ({
      errors: page.errors,
      state: await evaluate(
        page,
        `({url:location.href,chrome:Boolean(window.chrome?.webview),bridge:Boolean(window.__PI_DESK_WINDOW__),top:window===window.top,body:document.body?.innerText.slice(0,1500)})`
      ).catch((cause) => String(cause))
    }))
  )
  await writeFile(join(root, 'page-diagnostics.json'), JSON.stringify(diagnostics, null, 2))
  console.error(`窗口验收失败，现场：${root}`)
  throw error
} finally {
  await writeFile(
    join(root, 'results.json'),
    JSON.stringify({ passed, scope: protocolOnly ? 'protocol-only' : 'full', results }, null, 2)
  )
  await writeFile(join(root, 'process.log'), output)
  for (const page of pages) page.close()
  const cleanupErrors = []
  if (child) {
    try {
      await stopE2eServerTree({
        child,
        exit: child.exitCode === null ? once(child, 'exit') : Promise.resolve(),
        port: debugPort,
        managed: false
      })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (browser) {
    try {
      await stopBrowserTree(browser, browserPort)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (source) {
    try {
      await stopE2eServerTree(source)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  fixture.closeAllConnections()
  await new Promise((done) => fixture.close(done))
  await assertPortReleased(fixturePort)
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '测试进程清理失败')
  if (passed) await rm(agentRoot, { recursive: true, force: true })
}
console.info(`窗口${protocolOnly ? '非原生输入范围' : '完整'}验收通过，进程与端口已释放：${root}`)
