import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPortReleased,
  isolatedPiEnvironment,
  prepareIsolatedPiDirectory,
  stopE2eServerTree
} from '../../../tests/l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const desktopVersion = JSON.parse(
  await readFile(join(projectRoot, 'apps/desktop/package.json'), 'utf8')
).version
const executable = resolve(process.argv[2] ?? '')
const frontend = resolve(process.argv[3] ?? '')
const identifier = 'com.jetcrab.desktop.ui-smoke'
const setupOnly = process.argv.includes('--setup-only')
const layoutOnly = process.argv.includes('--layout-only')
const startupOnly = process.argv.includes('--startup-only')
const sourceScenario =
  process.argv.find((value) => value.startsWith('--source-scenario='))?.split('=')[1] ?? 'china'
assert.ok(
  ['china', 'foreign', 'failure', 'timeout', 'late-selection', 'late-start'].includes(
    sourceScenario
  ),
  '未知的安装源验收场景'
)
assert.equal(process.platform, 'win32', '原生窗口验收仅支持 Windows')
assert.ok(process.argv[2] && process.argv[3], '请传入隔离构建的 exe 和前端资源目录')
const executableBytes = await readFile(executable)
const peOffset = executableBytes.readUInt32LE(0x3c)
assert.equal(executableBytes.toString('ascii', peOffset, peOffset + 4), 'PE\u0000\u0000')
if (!layoutOnly) {
  assert.equal(executableBytes.readUInt16LE(peOffset + 4), 0x014c, '必须验收真实的32位壳程序')
  assert.ok(
    executableBytes.includes(Buffer.from(identifier)),
    '测试程序必须使用独立 identifier，禁止接管真实桌面实例'
  )
}
assert.ok(
  frontend.startsWith(join(projectRoot, 'temp/build/desktop-web') + sep),
  '仅允许临时移走本项目的前端构建目录'
)
const task = `embedded-page-${process.pid}-${Date.now()}`
const root = join(projectRoot, 'temp/run/desktop-packaged-ui', task)
const agent = join(projectRoot, 'temp/pi/desktop-packaged-ui', task, 'agent')
await mkdir(root, { recursive: true })
await prepareIsolatedPiDirectory(agent)

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

let countryRequests = 0
let releaseCountry
let pendingCountry
let updateVersion = '1.0.0'
let updateFailure = false
let holdUpdate = false
let pendingUpdate
const fixture = createServer((request, response) => {
  if (layoutOnly && request.url?.startsWith('/desktop/')) {
    const file = request.url === '/desktop/' ? 'index.html' : request.url.slice('/desktop/'.length)
    const types = {
      'index.html': 'text/html',
      'l1-desktop-main.js': 'text/javascript',
      'l4-desktop-ui.css': 'text/css'
    }
    if (!Object.hasOwn(types, file)) {
      response.writeHead(404).end()
      return
    }
    void readFile(join(frontend, file)).then(
      (content) => {
        response.writeHead(200, { 'Content-Type': `${types[file]}; charset=utf-8` }).end(content)
      },
      () => response.writeHead(500).end()
    )
    return
  }
  if (request.url?.startsWith('/desktop-startup-fixture')) {
    const reply = () => {
      response.writeHead(updateFailure ? 401 : 200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          name: 'desktop-startup-fixture',
          'dist-tags': { latest: updateVersion },
          versions: { [updateVersion]: { name: 'desktop-startup-fixture', version: updateVersion } }
        })
      )
    }
    if (holdUpdate) pendingUpdate = reply
    else reply()
    return
  }
  if (request.url === '/ip-country') {
    countryRequests += 1
    const reply = () => {
      response.writeHead(sourceScenario === 'failure' ? 503 : 200, {
        'Content-Type': 'application/json'
      })
      response.end(
        JSON.stringify({ success: true, country_code: sourceScenario === 'foreign' ? 'US' : 'CN' })
      )
    }
    if (sourceScenario === 'timeout' || sourceScenario.startsWith('late-')) {
      pendingCountry = response
      releaseCountry = reply
    } else reply()
    return
  }
  response.writeHead(request.url === '/health-unavailable' ? 503 : 200, {
    'Content-Type': 'text/html; charset=utf-8'
  })
  response.end(
    '<!doctype html><html lang="zh-CN"><title>网页窗口验证</title><h1>网页窗口验证通过</h1></html>'
  )
})
const fixturePort = await listen(fixture)
const reservation = createServer()
const debugPort = await listen(reservation)
await new Promise((done) => reservation.close(done))
const targetUrl = `http://127.0.0.1:${fixturePort}/`
const managedUrl = `${targetUrl}managed`
await writeFile(
  join(root, 'config.json'),
  JSON.stringify({
    targets: [
      { url: targetUrl },
      {
        url: managedUrl,
        server: {
          startCommand: 'node old-service.cjs',
          readyPath: '/',
          package: { name: '@desktop/old-service' }
        }
      }
    ]
  })
)
await writeFile(
  join(root, 'runtime.json'),
  JSON.stringify({
    targets: {
      [managedUrl]: { lastVersion: '1.2.3', autoStart: false }
    }
  })
)
const output = createWriteStream(join(root, 'process.log'))
const heldFrontend = `${frontend}.ui-smoke-held`
let child
let exit
let moved = false
let passed = false
let validationError
let healthyPort = 0
let sourcePort = 0
const connections = []

async function until(probe, description, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error(`桌面进程提前退出：${child.exitCode}`)
    const result = await probe()
    if (result) return result
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`等待超时：${description}`)
}

let lastDebugProbe
async function targets() {
  try {
    const result = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
      signal: AbortSignal.timeout(1000)
    })
    const value = await result.json()
    lastDebugProbe = { status: result.status, value }
    return value
  } catch (error) {
    lastDebugProbe = { error: String(error), cause: String(error.cause ?? '') }
    return []
  }
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await Promise.race([
    once(socket, 'open'),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('调试连接超时')), 5000).unref()
    })
  ])
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
  const send = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, 10_000)
      pending.set(id, { resolve: resolveCall, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const page = {
    errors,
    async load(url, source) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source })
      await send('Page.navigate', { url })
    },
    async theme(value) {
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value }]
      })
    },
    async viewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      })
    },
    async clearViewport() {
      await send('Emulation.clearDeviceMetricsOverride')
    },
    async evaluate(expression) {
      const response = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails))
      return response.result.value
    },
    async screenshot(name) {
      await page.evaluate(`(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const animations = document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect && Number.isFinite(animation.effect.getComputedTiming().endTime));
        await Promise.allSettled(animations.map(animation => animation.finished));
        await new Promise(resolve => requestAnimationFrame(resolve));
      })()`)
      const result = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(root, name), Buffer.from(result.data, 'base64'))
    },
    async shutdown() {
      await send('Browser.close')
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
  connections.push(page)
  await send('Runtime.enable')
  await send('Page.enable')
  return page
}

function click(text) {
  return `(() => { const button = [...document.querySelectorAll('button')].find(item => (item.textContent.trim() === ${JSON.stringify(text)} || item.getAttribute('aria-label') === ${JSON.stringify(text)}) && item.checkVisibility() && !item.closest('[inert]'));  if (!button || button.disabled) throw new Error('操作不可用：' + ${JSON.stringify(text)}); button.click(); return true; })()`
}

async function assertSetupFits(page, action) {
  const layout = await page.evaluate(`(() => {
    const root = document.scrollingElement;
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(action)});
    const rect = button?.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, scrollHeight: root.scrollHeight, scrollWidth: root.scrollWidth, actionVisible: !!rect && rect.top >= 0 && rect.bottom <= innerHeight };
  })()`)
  assert.ok(layout.scrollWidth <= layout.width, `准备页不应横向溢出：${JSON.stringify(layout)}`)
  assert.ok(layout.actionVisible, `主要操作必须首屏可达：${JSON.stringify(layout)}`)
}

function sourceField(value) {
  return `(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.trim().startsWith('下载源'));
    const select = label?.querySelector('select');
    if (!select || select.disabled) throw new Error('下载源不可选');
    select.focus();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`
}

function sourceValue() {
  return `(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.trim().startsWith('下载源'));
    const select = label?.querySelector('select');
    return select ? { value: select.value, disabled: select.disabled } : null;
  })()`
}

function field(label, value) {
  return `(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.trim().startsWith(${JSON.stringify(label)}));
    const input = label?.querySelector('input, textarea');
    if (!input || input.disabled) throw new Error('字段不可用：' + ${JSON.stringify(label)});
    input.scrollIntoView({ block: 'center' });
    input.focus({ preventScroll: true });
    const rect = input.getBoundingClientRect();
    if (document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) !== input) throw new Error('字段被遮挡：' + ${JSON.stringify(label)});
    if (input.type === 'checkbox' || input.type === 'radio') {
      if (input.checked !== ${JSON.stringify(value)}) input.click();
    } else {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`
}

function targetAction(url, action) {
  return `(() => {
    const target = [...document.querySelectorAll('article')].find(item => item.dataset.testid === ${JSON.stringify(url)});
    const summary = target?.querySelector('summary[aria-label]');
    if (summary && !summary.parentElement.open) summary.click();
    const label = ${JSON.stringify(action)} === '编辑地址' ? '编辑地址 ' + ${JSON.stringify(url)} : ${JSON.stringify(action)} === '本机设置' ? '编辑' + target.getAttribute('aria-label') + '的设置' : ${JSON.stringify(action)};
    const button = [...(target?.querySelectorAll('button') ?? [])].find(item => item.textContent.trim() === label || item.getAttribute('aria-label') === label);
    if (!button || button.disabled) throw new Error('网址操作不可用：' + ${JSON.stringify(action)});
    button.click();
    return true;
  })()`
}

function installLayoutFixture(desktopVersion) {
  const localUrl = 'http://127.0.0.1:30333/'
  const serverConfig = {
    startCommand: 'pi-desk --port {port}',
    readyPath: '/api/health',
    package: {
      name: '@jetcrab/pi-desk',
      registry: null,
      startupUpdate: 'update',
      periodicUpdate: 'update',
      channel: 'stable'
    }
  }
  window.desktopLayoutCommands = []
  window.desktopLayoutState = {
    hideOnStartup: null,
    hideOnOpen: true,
    showOnClose: true,
    targets: [
      {
        url: localUrl,
        server: {
          status: 'running',
          detail: '',
          version: '1.0.0',
          autoStart: true,
          needsSetup: false,
          update: { status: 'idle', version: null, error: null }
        },
        tunnel: {
          status: 'listening',
          detail: '公网端口已连接',
          publicAddr: 'connect.example.test:19443',
          publicPort: 19443
        }
      },
      { url: 'https://workstation.example.test/', server: null, tunnel: null }
    ],
    environment: {
      status: 'ready',
      step: '',
      error: null,
      components: ['node', 'bash', 'pi'].map((name) => ({
        name,
        status: 'ready',
        version: '1.0.0',
        path: `C:/desktop-fixture/${name}`,
        detail: null,
        download: null
      }))
    }
  }
  let connection = { controlServerUrl: 'https://connect.example.test/', controlKey: 'fixture-key' }
  let firstRead = true
  let callbackId = 0
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
  window.__TAURI_INTERNALS__ = {
    transformCallback() {
      return ++callbackId
    },
    unregisterCallback() {},
    async invoke(command, args = {}) {
      window.desktopLayoutCommands.push({ command, args })
      const state = window.desktopLayoutState
      if (command === 'plugin:app|version') return desktopVersion
      if (command === 'plugin:event|listen') return 1
      if (command === 'plugin:event|unlisten') return
      if (command === 'get_control_state') {
        if (firstRead) {
          firstRead = false
          await new Promise((resolve) => {
            window.desktopLayoutReady = resolve
          })
        }
        return structuredClone(state)
      }
      if (command === 'set_startup_preference_command') {
        if (window.desktopLayoutPreferenceError) throw new Error('无法保存显示习惯')
        Object.assign(state, args)
        return
      }
      if (command === 'get_environment_download_source') return 'official'
      if (command === 'get_target_settings')
        return {
          target: args.url
            ? {
                url: args.url,
                server: args.url === localUrl ? serverConfig : null,
                tunnel: state.targets.find((item) => item.url === args.url)?.tunnel
                  ? {
                      enabled: true,
                      publicPort: state.targets.find((item) => item.url === args.url).tunnel
                        .publicPort
                    }
                  : null
              }
            : null,
          defaultServer: serverConfig
        }
      if (command === 'get_tunnel_connection') return structuredClone(connection)
      if (command === 'apply_tunnel_connection_command') {
        connection = args.value
        return
      }
      if (command === 'apply_target_command') {
        if (window.desktopLayoutSaveError) throw new Error('这个访问端口已被占用')
        const index = state.targets.findIndex((item) => item.url === args.originalUrl)
        const target = {
          url: args.value.url,
          server: state.targets[index]?.server ?? null,
          tunnel: args.value.tunnel
            ? {
                status: 'stopped',
                detail: '',
                publicAddr: `connect.example.test:${args.value.tunnel.publicPort}`,
                publicPort: args.value.tunnel.publicPort
              }
            : null
        }
        if (index < 0) state.targets.push(target)
        else state.targets[index] = target
        return
      }
      if (command === 'open_target_command') return
      if (command === 'prepare_environment_command') {
        state.environment.status = 'installing'
        state.environment.step = '正在下载 Node.js'
        state.environment.components[0].detail = '正在下载 Node.js'
        state.environment.components[0].download = { received: 42_000_000, total: 80_000_000 }
        return
      }
      if (command === 'cancel_environment_command') {
        state.environment.status = 'required'
        state.environment.components.forEach((item) => {
          item.download = null
          item.detail = null
        })
        return
      }
      if (command === 'check_environment_command') return
      if (command === 'stop_tunnel_command' || command === 'start_tunnel_command') {
        state.targets.find((item) => item.url === args.url).tunnel.status =
          command === 'start_tunnel_command' ? 'listening' : 'stopped'
        return
      }
      throw new Error(`布局测试未声明命令：${command}`)
    }
  }
  window.confirm = () => true
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      async writeText(value) {
        window.desktopLayoutCopied = value
      }
    }
  })
}

async function validateLayout(page) {
  const localUrl = 'http://127.0.0.1:30333/'
  const hasText = (value) =>
    page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`)
  const publish = async (expression) => {
    await page.evaluate(
      `(() => { ${expression}; document.dispatchEvent(new Event('visibilitychange')); })()`
    )
  }
  await until(
    () =>
      page.evaluate(
        `!!window.desktopLayoutReady && !!document.querySelector('[aria-label="正在准备 Pi Desk"]')`
      ),
    '完整页面加载状态'
  )
  await until(
    () => hasText(`Pi Desk v${desktopVersion}`),
    '页头显示桌面自身版本，不使用托管服务版本'
  )
  await page.screenshot('control-loading.png')
  await page.evaluate('window.desktopLayoutReady()')
  await until(() => page.evaluate(`!!document.querySelector('dialog[open]')`), '首次启动询问可见')
  await page.screenshot('startup-preference.png')
  await page.theme('dark')
  await page.screenshot('startup-preference-dark.png')
  await page.theme('light')
  await page.evaluate(`window.desktopLayoutPreferenceError = true`)
  await page.evaluate(click('下次隐藏'))
  await until(() => hasText('无法保存显示习惯'), '保存失败保留首次询问')
  await page.evaluate(`window.desktopLayoutPreferenceError = false`)
  await page.evaluate(
    `document.querySelector('dialog[open]').dispatchEvent(new Event('cancel', {cancelable:true}))`
  )
  await until(
    () =>
      page.evaluate(
        `!document.querySelector('dialog[open]') && window.desktopLayoutState.hideOnStartup === false`
      ),
    '取消询问保存每次显示'
  )
  await until(() => hasText('打开 Pi Desk'), '本机启动入口')
  for (const name of [
    '打开 Pi Desk',
    '重启',
    '停止',
    '设置',
    '远程访问',
    '编辑这台电脑的设置',
    '删除地址 https://workstation.example.test/'
  ]) {
    assert.equal(
      await page.evaluate(
        `(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(name)} || item.getAttribute('aria-label') === ${JSON.stringify(name)}); return !!button?.checkVisibility(); })()`
      ),
      true,
      `${name} 直接可见`
    )
  }
  await assertSetupFits(page, '打开 Pi Desk')
  for (const text of [
    'Node.js',
    'Git Bash',
    '公网端口已连接',
    'connect.example.test:19443',
    '正在读取'
  ]) {
    assert.equal(await hasText(text), false, `正常首页不展开技术信息：${text}`)
  }
  assert.equal(
    await page.evaluate(`!!document.querySelector('summary[aria-label="桌面设置"]')`),
    false,
    '不再提供重复的全局设置菜单'
  )
  await page.screenshot('control-ready.png')
  await page.theme('dark')
  await page.screenshot('control-ready-dark.png')
  await page.viewport(720, 560)
  await assertSetupFits(page, '打开 Pi Desk')
  await page.screenshot('control-ready-compact.png')
  await page.viewport(400, 640)
  await assertSetupFits(page, '打开 Pi Desk')
  await page.viewport(960, 720)
  await page.theme('light')

  await publish(`
    window.desktopLayoutState.targets[0].server.version = null;
    window.desktopLayoutState.targets[0].server.status = 'starting';
    window.desktopLayoutState.targets[0].server.update = { status: 'installing', version: '1.0.0', error: null };
  `)
  await until(() => hasText('取消安装'), '已有 Pi 时首次服务安装直接显示步骤')
  assert.equal(
    await page.evaluate(`!!document.querySelector('progress[aria-label="Pi Desk安装进度"]')`),
    true
  )
  assert.equal(await hasText('Node.js'), true)
  await publish(`
    window.desktopLayoutState.targets[0].server.version = '1.0.0';
    window.desktopLayoutState.targets[0].server.status = 'running';
    window.desktopLayoutState.targets[0].server.update.status = 'idle';
  `)
  await until(() => hasText('打开 Pi Desk'), '服务就绪后返回正常首页')

  await page.evaluate(click('远程访问'))
  await until(() => hasText('连接这台电脑'), '进入远程访问页面')
  await page.evaluate(click('复制地址'))
  assert.equal(
    await page.evaluate('window.desktopLayoutCopied'),
    'http://connect.example.test:19443/'
  )
  await page.screenshot('control-access.png')
  await page.evaluate(click('返回'))
  await until(() => hasText('打开 Pi Desk'), '从访问页返回')
  await publish(
    `window.desktopLayoutState.targets[0].url = 'http://127.0.0.1:30333/workspace?view=files#readme'`
  )
  await until(() => hasText('打开 Pi Desk'), '切换连接后重新定位访问入口')
  await page.evaluate(click('远程访问'))
  await until(() => hasText('连接这台电脑'), '进入带路径连接的访问页面')
  await page.evaluate(click('复制地址'))
  assert.equal(
    await page.evaluate('window.desktopLayoutCopied'),
    'http://connect.example.test:19443/workspace?view=files#readme',
    '外部地址保留原页面路径和参数'
  )
  await page.evaluate(click('返回'))
  await publish(`window.desktopLayoutState.targets[0].url = ${JSON.stringify(localUrl)}`)
  await until(() => hasText('打开 Pi Desk'), '恢复本机连接')
  await publish(
    `window.desktopLayoutState.targets[0].server.status = 'failed'; window.desktopLayoutState.targets[0].server.detail = 'fixture-start-failed'`
  )
  await until(() => hasText('未能启动'), '启动失败仍保留打开操作')
  await page.evaluate(click('安装与版本'))
  await until(() => hasText('Node.js'), '安装详情可访问')
  assert.equal(
    await page.evaluate(
      `([...document.querySelectorAll('button')].filter(item => ['打开 Pi Desk', '重试并打开'].includes(item.textContent.trim()) && item.checkVisibility() && !item.closest('[inert]'))).length`
    ),
    1,
    '查看版本不重复主操作'
  )
  await publish(
    `window.desktopLayoutState.targets[0].server.status = 'running'; window.desktopLayoutState.targets[0].server.detail = ''`
  )
  await until(() => hasText('打开 Pi Desk'), '恢复运行状态')
  await page.screenshot('control-install-options.png')
  await page.evaluate(click('安装与版本'))

  await publish(
    `window.desktopLayoutState.targets[0].tunnel.status = 'failed'; window.desktopLayoutState.targets[0].tunnel.detail = 'fixture-tunnel-failed'`
  )
  await until(() => hasText('连接失败'), '访问入口呈现连接异常')
  assert.equal(await hasText('fixture-tunnel-failed'), false)
  assert.equal(await hasText('操作未完成'), false, '外部访问故障不干扰本机启动')
  await page.evaluate(click('远程访问'))
  await until(() => hasText('重新连接'), '连接失败后可重试')
  assert.equal(await hasText('fixture-tunnel-failed'), true, '连接失败原因直接展示')
  await page.evaluate(click('重新连接'))
  await until(() => hasText('关闭访问'), '重新开启访问')
  await page.evaluate(click('关闭访问'))
  await until(() => hasText('开启访问'), '关闭访问不停止本机服务')
  await page.evaluate(click('修改配置'))
  await until(() => hasText('中转服务地址'), '访问配置位于同一页面')
  await page.evaluate(field('访问端口', '19444'))
  await page.screenshot('access-settings.png')
  await page.evaluate(`window.desktopLayoutSaveError = true`)
  await page.evaluate(click('保存并开启'))
  await until(() => hasText('这个访问端口已被占用'), '保存失败就近说明原因')
  assert.equal(
    await page.evaluate(`document.querySelector('input[type="number"]').value`),
    '19444',
    '保存失败保留草稿'
  )
  assert.equal(
    await page.evaluate(`window.desktopLayoutState.targets[0].tunnel.status`),
    'stopped',
    '保存失败不得开启连接'
  )
  await page.evaluate(`window.desktopLayoutSaveError = false`)
  await page.evaluate(click('保存并开启'))
  await until(() => hasText('connect.example.test:19444'), '保存后直接连接并显示地址')
  assert.equal(
    await page.evaluate(
      `window.desktopLayoutCommands.some(item => item.command === 'apply_target_command' && item.args.value.server?.package.name === '@jetcrab/pi-desk')`
    ),
    true,
    '访问配置不得覆盖本机服务'
  )
  await page.evaluate(click('返回'))

  await publish(`window.desktopLayoutState.targets[0].server.update.status = 'checking'`)
  await until(
    () =>
      page.evaluate(
        `window.desktopLayoutCommands.filter(item => item.command === 'get_control_state').length > 1`
      ),
    '更新状态读取'
  )
  await page.evaluate(click('打开 Pi Desk'))
  assert.equal(
    await page.evaluate(
      `window.desktopLayoutCommands.some(item => item.command === 'open_target_command' && item.args.url === ${JSON.stringify(localUrl)})`
    ),
    true,
    '后台检查更新不阻塞打开'
  )

  await page.evaluate(click('添加连接'))
  await page.evaluate(field('网页地址', 'https://new-computer.example.test/'))
  await publish(`window.desktopLayoutState.environment.status = 'checking'`)
  await until(() => hasText('正在检查组件…'), '读取新的准备状态')
  assert.equal(
    await page.evaluate(`document.querySelector('form[aria-label="添加地址"] input').value`),
    'https://new-computer.example.test/',
    '刷新不得清空地址草稿'
  )
  await publish(
    `window.desktopLayoutState.environment.status = 'ready'; window.desktopLayoutState.targets[0].server.update.status = 'idle'`
  )
  await page.evaluate(click('添加并打开'))
  await until(() => hasText('new-computer.example.test'), '新增连接显示在列表')
  assert.equal(
    await page.evaluate(
      `window.desktopLayoutCommands.some(item => item.command === 'open_target_command' && item.args.url === 'https://new-computer.example.test/')`
    ),
    true
  )

  await page.evaluate(click('设置'))
  await until(() => hasText('启动时自动隐藏配置页'), '全局显示习惯可见')
  await page.evaluate(field('启动时自动隐藏配置页', true))
  await until(
    () => page.evaluate(`window.desktopLayoutState.hideOnStartup === true`),
    '显示习惯立即保存'
  )
  await page.screenshot('startup-settings.png')
  await page.theme('dark')
  await page.screenshot('startup-settings-dark.png')
  await page.viewport(720, 560)
  await page.evaluate(`document.documentElement.style.fontSize = '20px'`)
  assert.equal(
    await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`),
    true,
    '设置页大字不横向溢出'
  )
  await page.screenshot('startup-settings-compact.png')
  await page.evaluate(`document.documentElement.style.fontSize = ''`)
  await page.viewport(960, 720)
  await page.theme('light')
  await until(() => hasText('服务更新'), '从单一设置入口进入本机配置')
  assert.equal(await hasText('通过公网端口访问'), false, '访问配置不再混入本机设置')
  await page.evaluate(click('返回'))
  await until(() => hasText('打开 Pi Desk'), '返回启动页')

  await publish(`
    window.desktopLayoutState.targets[0].server.needsSetup = true;
    window.desktopLayoutState.targets[0].server.status = 'stopped';
    window.desktopLayoutState.targets[0].server.version = null;
    window.desktopLayoutState.targets[0].tunnel = null;
    window.desktopLayoutState.environment.status = 'required';
    window.desktopLayoutState.environment.components.forEach(item => { item.status = 'missing'; item.version = null; item.path = null });
  `)
  await until(() => hasText('安装并打开'), '首次准备入口')
  await assertSetupFits(page, '安装并打开')
  assert.equal(await hasText('Node.js'), true, '首次准备直接列出需要安装的组件')
  await page.screenshot('environment-required.png')
  await page.evaluate(click('安装并打开'))
  await until(() => hasText('取消安装'), '准备中的取消入口')
  await assertSetupFits(page, '取消安装')
  assert.equal(
    await page.evaluate(`document.querySelector('progress[aria-label="Node.js下载进度"]').value`),
    53
  )
  await page.screenshot('environment-preparing.png')
  await publish(`
    window.desktopLayoutState.environment.components.forEach(item => { item.download = null; item.status = item.name === 'pi' ? 'missing' : 'ready'; item.detail = item.name === 'pi' ? '正在安装 Pi 1.1.0' : null });
    window.desktopLayoutState.targets[0].server.update = { status: 'installing', version: '1.0.0', error: null };
  `)
  await until(() => hasText('正在安装 Pi 1.1.0'), 'Pi 与 Pi Desk 同时安装')
  assert.equal(
    await page.evaluate(
      `!!document.querySelector('progress[aria-label="Pi安装进度"]') && !!document.querySelector('progress[aria-label="Pi Desk安装进度"]')`
    ),
    true
  )
  await page.screenshot('environment-parallel.png')
  await page.evaluate(`document.documentElement.style.fontSize = '20px'`)
  await assertSetupFits(page, '取消安装')
  await page.screenshot('environment-parallel-large-text.png')
  await page.evaluate(`document.documentElement.style.fontSize = ''`)
  await page.theme('dark')
  await page.screenshot('environment-parallel-dark.png')
  await page.theme('light')
  await page.viewport(720, 560)
  await assertSetupFits(page, '取消安装')
  await page.screenshot('environment-parallel-compact.png')
  await page.evaluate(click('取消安装'))
  await publish(`window.desktopLayoutState.targets[0].server.update.status = 'idle'`)
  await until(() => hasText('安装并打开'), '取消后可重新准备')
  await publish(
    `window.desktopLayoutState.environment.status = 'failed'; window.desktopLayoutState.environment.error = 'fixture-download-failed'`
  )
  await until(() => hasText('重试安装'), '失败后的恢复入口')
  assert.equal(await hasText('fixture-download-failed'), true, '失败原因无需展开即可看到')
  await page.viewport(960, 720)
  await page.screenshot('environment-error.png')
  await publish(
    `window.desktopLayoutState.targets = window.desktopLayoutState.targets.filter(item => !item.server)`
  )
  await until(async () => !(await hasText('这台电脑')), '仅远程连接的页面')
  await page.evaluate(click('打开'))
  assert.equal(
    await page.evaluate(
      `window.desktopLayoutCommands.some(item => item.command === 'open_target_command' && item.args.url === 'https://workstation.example.test/')`
    ),
    true
  )
  await publish(`window.desktopLayoutState.targets = []`)
  await until(() => hasText('连接你的 Pi Desk'), '空连接列表的可用入口')
  await page.evaluate(click('连接其他电脑'))
  assert.equal(
    await page.evaluate(`!!document.querySelector('form[aria-label="添加地址"] input')`),
    true
  )
}

async function prepareStartupFixture() {
  const reservation = createServer()
  healthyPort = await listen(reservation)
  await new Promise((done) => reservation.close(done))
  const url = `http://127.0.0.1:${healthyPort}/`
  const packageRoot = join(
    root,
    `packages/${healthyPort}/versions/desktop-startup-fixture/1.0.0/node_modules/desktop-startup-fixture`
  )
  await mkdir(packageRoot, { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'desktop-startup-fixture', version: '1.0.0' })
  )
  await writeFile(
    join(packageRoot, 'service.cjs'),
    `require('node:http').createServer((req,res)=>res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'}).end('<h1>本机聊天窗口</h1>')).listen(Number(process.argv[2]),'127.0.0.1')`
  )
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      targets: [
        {
          url,
          server: {
            startCommand: `"${process.execPath}" node_modules/desktop-startup-fixture/service.cjs {port}`,
            readyPath: '/',
            package: {
              name: 'desktop-startup-fixture',
              registry: targetUrl,
              startupUpdate: 'check',
              periodicUpdate: 'none',
              channel: 'stable'
            }
          }
        },
        { url: targetUrl }
      ]
    })
  )
  await writeFile(
    join(root, 'runtime.json'),
    JSON.stringify({ targets: { [url]: { lastVersion: '1.0.0', autoStart: true } } })
  )
  holdUpdate = true
}

async function closeWorkspaceWindow() {
  // 只向本轮 EXE 所属的聊天窗口发送正常关闭消息，不关闭真实桌面实例。
  const script = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DesktopWindowTest {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static void Close(uint pid) {
    EnumWindows((h,p) => { uint owner; GetWindowThreadProcessId(h,out owner); var title = new StringBuilder(512); GetWindowText(h,title,512);
      if(owner == pid && IsWindowVisible(h) && title.ToString().StartsWith("Pi Desk ·")) PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
  }
}
'@
[DesktopWindowTest]::Close(${child.pid})`
  await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { timeout: 15000, windowsHide: true }
  )
}

async function validateStartupFlow(control) {
  const url = `http://127.0.0.1:${healthyPort}/`
  const invoke = (command, args = {}) =>
    control.evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`
    )
  const visible = () => invoke('plugin:window|is_visible', { label: 'control' })
  await until(() => control.evaluate(`!!document.querySelector('dialog[open]')`), '首次启动询问')
  await control.screenshot('startup-preference.png')
  await control.evaluate(click('下次隐藏'))
  await until(
    async () => (await invoke('get_control_state')).hideOnStartup === true,
    '选择写入原生偏好'
  )
  assert.equal(await visible(), true, '首次选择不立即隐藏配置页')
  await until(
    async () =>
      (await invoke('get_control_state')).targets[0].server.status === 'running' &&
      Boolean(pendingUpdate),
    '网络查询等待期间服务已就绪'
  )
  await until(
    () =>
      control.evaluate(
        `([...document.querySelectorAll('button')].find(item => item.textContent.trim() === '打开 Pi Desk'))?.disabled === false`
      ),
    '就绪后打开按钮可用'
  )
  await control.evaluate(click('打开 Pi Desk'))
  await until(
    async () => (await targets()).some((item) => item.url === url),
    '查询尚未返回即可进入本机聊天'
  )
  assert.equal(await visible(), false, '打开本机聊天后隐藏配置页')
  holdUpdate = false
  pendingUpdate()
  pendingUpdate = undefined
  await until(
    async () => (await invoke('get_control_state')).targets[0].server.update.status === 'idle',
    '无更新完成'
  )
  assert.equal(await visible(), false, '无更新不展示配置页')
  await closeWorkspaceWindow()
  await until(visible, '关闭本机聊天默认恢复配置页')
  await control.evaluate(targetAction(targetUrl, '打开'))
  await until(
    async () => (await targets()).some((item) => item.url === targetUrl),
    '远程聊天已打开'
  )
  assert.equal(await visible(), false, '打开远程聊天后隐藏配置页')
  await closeWorkspaceWindow()
  await until(visible, '关闭远程聊天恢复配置页')
  await control.evaluate(click('设置'))
  await until(() => control.evaluate(`!!document.querySelector('[role="switch"]')`), '显示习惯设置')
  await control.screenshot('startup-settings.png')
  await control.evaluate(field('打开聊天后隐藏配置页', false))
  await until(async () => !(await invoke('get_control_state')).hideOnOpen, '打开偏好保存')
  await control.evaluate(field('关闭聊天后显示配置页', false))
  await until(async () => !(await invoke('get_control_state')).showOnClose, '关闭偏好保存')
  await control.evaluate(click('返回'))
  await invoke('open_target_command', { url: targetUrl })
  assert.equal(await visible(), true, '关闭自动隐藏开关后保留配置页')
  await invoke('set_startup_preference_command', { hideOnOpen: true })
  await invoke('open_target_command', { url: targetUrl })
  await closeWorkspaceWindow()
  assert.equal(await visible(), false, '关闭自动返回开关后仍留在托盘')

  await invoke('stop_server_command', { url })
  await until(
    async () => (await invoke('get_control_state')).targets[0].server.status === 'stopped',
    '本机服务停止'
  )
  holdUpdate = true
  await invoke('check_package_update_command', { url })
  await until(() => Boolean(pendingUpdate), '停止状态检查正在等待网络')
  pendingUpdate = undefined
  await invoke('open_target_command', { url })
  await until(
    async () =>
      (await invoke('get_control_state')).targets[0].server.status === 'running' &&
      Boolean(pendingUpdate),
    '检查未返回也优先启动本机服务'
  )
  holdUpdate = false
  pendingUpdate()
  pendingUpdate = undefined
  await until(
    async () => (await invoke('get_control_state')).targets[0].server.update.status === 'idle',
    '优先启动后的检查完成'
  )

  updateVersion = '2.0.0'
  await invoke('check_package_update_command', { url })
  await until(
    async () =>
      (await invoke('get_control_state')).targets[0].server.update.status === 'available' &&
      (await visible()),
    '发现更新唤出配置页'
  )
  await until(
    () => control.evaluate(`document.body.innerText.includes('有可用更新')`),
    '更新操作可见'
  )
  await control.screenshot('startup-update-available.png')
  await invoke('open_target_command', { url: targetUrl })
  await invoke('check_package_update_command', { url })
  await until(
    async () => (await invoke('get_control_state')).targets[0].server.update.status === 'available',
    '同版本再次检查完成'
  )
  assert.equal(await visible(), false, '同一版本不重复唤出')
  updateFailure = true
  await invoke('check_package_update_command', { url })
  await until(
    async () => (await invoke('get_control_state')).targets[0].server.update.status === 'failed',
    '查询失败已记录'
  )
  assert.equal(await visible(), false, '查询失败不打断聊天')
  updateFailure = false
  updateVersion = '1.0.0'
  await invoke('set_startup_preference_command', { showOnClose: true })
  const saved = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
  assert.equal(saved.lastOpenedUrl, targetUrl)
  assert.equal(saved.hideOnStartup, true)

  await restartNativeProcess()
  await until(
    async () => (await targets()).some((item) => item.url === targetUrl),
    '重新启动直接恢复上次远程聊天'
  )
  assert.equal(
    (await targets()).some((item) => item.url.startsWith('http://tauri.localhost')),
    false,
    '无更新启动不创建配置窗口'
  )
  await closeWorkspaceWindow()
  const restored = await until(
    async () => (await targets()).find((item) => item.url.startsWith('http://tauri.localhost')),
    '关闭聊天恢复配置页'
  )
  const restoredControl = await connect(restored)
  await until(
    () => restoredControl.evaluate(`document.body.innerText.includes('打开 Pi Desk')`),
    '恢复配置页可用'
  )
  assert.equal(
    await restoredControl.evaluate(`!!document.querySelector('dialog[open]')`),
    false,
    '首次选择不重复询问'
  )
  await restoredControl.evaluate(
    `window.__TAURI_INTERNALS__.invoke('open_target_command', {url:${JSON.stringify(url)}})`
  )
  await until(
    async () =>
      JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')).lastOpenedUrl === url,
    '本地地址成为上次使用地址'
  )
  assert.deepEqual(restoredControl.errors, [])
  await restartNativeProcess()
  await until(
    async () => (await targets()).some((item) => item.url === url),
    '冷启动直接进入本地聊天'
  )
  assert.equal(
    (await targets()).some((item) => item.url.startsWith('http://tauri.localhost')),
    false,
    '本地冷启动不闪现配置页'
  )
  await closeWorkspaceWindow()
  const localControlTarget = await until(
    async () => (await targets()).find((item) => item.url.startsWith('http://tauri.localhost')),
    '本地冷启动关闭后恢复配置页'
  )
  const localControl = await connect(localControlTarget)
  await until(
    () => localControl.evaluate(`document.body.innerText.includes('打开 Pi Desk')`),
    '本地配置页恢复完成'
  )
  assert.deepEqual(localControl.errors, [])
}

async function restartNativeProcess() {
  const stop = spawn(executable, ['--exit-for-update'], { stdio: 'ignore', windowsHide: true })
  await once(stop, 'exit')
  await Promise.race([
    exit,
    new Promise((_, reject) => setTimeout(() => reject(new Error('隔离桌面退出超时')), 15000))
  ])
  await assertPortReleased(healthyPort)
  child = undefined
  await until(
    () =>
      assertPortReleased(debugPort).then(
        () => true,
        () => false
      ),
    '退出后调试端口释放',
    5000
  )
  startNativeProcess()
}

function startNativeProcess() {
  child = spawn(executable, [], {
    cwd: root,
    env: {
      ...process.env,
      ...isolatedPiEnvironment(agent),
      HOME: process.env.USERPROFILE,
      PI_DESK_DESKTOP_DATA_DIR: root,
      PI_DESK_DESKTOP_DISCOVERY_PATH: startupOnly ? dirname(process.execPath) : '',
      PI_DESK_DESKTOP_IP_LOOKUP_URL: `${targetUrl}ip-country`,
      WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout.pipe(output, { end: false })
  child.stderr.pipe(output, { end: false })
  exit = once(child, 'exit')
}

validation: try {
  if (layoutOnly) {
    child = spawn(
      executable,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-sync',
        `--user-data-dir=${join(root, 'browser')}`,
        `--remote-debugging-port=${debugPort}`,
        'about:blank'
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    child.stdout.pipe(output, { end: false })
    child.stderr.pipe(output, { end: false })
    exit = once(child, 'exit')
    const target = await until(
      async () => (await targets()).find((item) => item.type === 'page'),
      '隔离布局浏览器'
    )
    const control = await connect(target)
    await control.viewport(960, 720)
    await control.theme('light')
    await control.load(
      `${targetUrl}desktop/`,
      `(${installLayoutFixture.toString()})(${JSON.stringify(desktopVersion)})`
    )
    await validateLayout(control)
    assert.deepEqual(control.errors, [], '布局交互不应出现 JavaScript 异常')
    passed = true
    break validation
  }
  if (startupOnly) await prepareStartupFixture()
  await rename(frontend, heldFrontend)
  moved = true
  startNativeProcess()
  const controlTarget = await until(
    async () =>
      (await targets()).find(
        (target) => target.type === 'page' && target.url.startsWith('http://tauri.localhost')
      ),
    '内嵌页面地址'
  )
  const control = await connect(controlTarget)
  if (startupOnly) {
    await validateStartupFlow(control)
    passed = true
    break validation
  }
  await until(() => control.evaluate(`!!document.querySelector('dialog[open]')`), '首次启动选择')
  await control.evaluate(click('每次显示'))
  // 原有安装验收持续操作配置页，不覆盖本轮新增的窗口切换场景。
  await control.evaluate(
    `window.__TAURI_INTERNALS__.invoke('set_startup_preference_command', {hideOnOpen:false})`
  )
  await control.theme('light')
  await until(
    () =>
      control.evaluate(
        `document.body?.innerText.includes('Pi Desk') && document.body.innerText.includes(${JSON.stringify(targetUrl)})`
      ),
    '控制中心显示配置网址'
  )
  assert.deepEqual(
    await control.evaluate('({ width: innerWidth, height: innerHeight })'),
    { width: 960, height: 720 },
    '实际控制窗口默认应扩大至960×720'
  )
  assert.equal(await control.evaluate('location.protocol'), 'http:')
  assert.equal(await control.evaluate('location.hostname'), 'tauri.localhost')
  assert.equal(
    await control.evaluate('document.body.innerText.includes("暂时无法读取状态")'),
    false
  )
  assert.equal(await control.evaluate('document.body.innerText.includes("查看日志")'), false)
  await until(
    () =>
      control.evaluate(
        `window.__TAURI_INTERNALS__.invoke('get_control_state').then(value => value.environment.status === 'required' && value.targets.find(target => target.url === ${JSON.stringify(managedUrl)}).server.needsSetup)`
      ),
    '缺少 Node/npm 时进入环境门禁'
  )
  const invalidSource = await control.evaluate(
    `window.__TAURI_INTERNALS__.invoke('prepare_environment_command', { url: ${JSON.stringify(managedUrl)}, downloadSource: 'invalid' }).then(() => null, error => String(error))`
  )
  assert.ok(invalidSource, '原生安装入口必须拒绝未支持的源')
  await control.evaluate(`(async () => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const state = await original('get_control_state');
    window.desktopSetupFixture = {
      ...state,
      environment: {
        status: 'required',
        step: '需要准备运行环境',
        error: null,
        components: [
          { name: 'node', status: 'missing', version: null, path: null, detail: null, download: null },
          { name: 'pi', status: 'missing', version: null, path: null, detail: null, download: null },
          { name: 'bash', status: 'missing', version: null, path: null, detail: null, download: null }
        ]
      }
    };
    const originalFetch = window.fetch;
    window.desktopSetupOriginalFetch = originalFetch;
    window.fetch = (input, options) => {
      const url = new URL(String(input));
      const command = url.hostname === 'ipc.localhost' ? decodeURIComponent(url.pathname.slice(1)) : '';
      const response = (value) => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } }));
      if (command === 'get_control_state') return response(window.desktopSetupFixture);
      if (command === 'prepare_environment_command') {
        window.desktopSetupPreparedArgs = JSON.parse(options.body);
        window.desktopSetupFixture.environment.status = 'installing';
        window.desktopSetupFixture.environment.step = '正在下载 Node.js、Git Bash';
        for (const item of window.desktopSetupFixture.environment.components) item.detail = item.name === 'node' ? '正在下载 Node.js' : item.name === 'bash' ? '正在下载 Git Bash' : null;
        window.desktopSetupFixture.environment.components[0].download = { received: 48318382, total: 90439680 };
        window.desktopSetupFixture.environment.components[2].download = { received: 15000000, total: 64000000 };
        document.dispatchEvent(new Event('visibilitychange'));
        return response(null);
      }
      if (command === 'cancel_environment_command') {
        window.desktopSetupCancelled = true;
        window.desktopSetupFixture.environment.status = 'required';
        window.desktopSetupFixture.environment.components.forEach(item => { item.download = null; item.detail = null; });
        return response(null);
      }
      return originalFetch(input, options);
    };
    const checked = await original('get_control_state');
    if (checked.environment.status !== 'required') throw new Error('准备状态夹具未应用到真实 IPC 响应');
    document.dispatchEvent(new Event('visibilitychange'));
  })()`)
  await until(
    () => control.evaluate(`document.body.innerText.includes('安装并打开')`),
    '本机区域显示安装入口'
  )
  assert.equal(await control.evaluate('location.hash'), '', '检查结果不得驱动页面跳转')
  assert.equal(
    await control.evaluate(
      `!!document.querySelector('article[aria-label=${JSON.stringify(targetUrl)}]')`
    ),
    true,
    '缺少环境时仍然显示其他地址'
  )
  await control.screenshot('environment-required.png')
  await control.evaluate(
    `(() => { const summary = [...document.querySelectorAll('summary')].find(item => item.textContent.trim() === '安装选项'); summary.click(); })()`
  )
  await until(() => control.evaluate(sourceValue()), '安装选项可选择下载源')
  let expectedSource = sourceScenario === 'china' ? 'npmmirror' : 'official'
  if (sourceScenario.startsWith('late-')) {
    await until(() => countryRequests === 1, '异步 IP 查询正在等待结果', 5000)
    assert.deepEqual(await control.evaluate(sourceValue()), { value: 'official', disabled: false })
    if (sourceScenario === 'late-selection') {
      await control.evaluate(sourceField('npmmirror'))
      await control.evaluate(sourceField('official'))
      releaseCountry()
      assert.equal(
        await control.evaluate(
          `window.__TAURI_INTERNALS__.invoke('get_environment_download_source')`
        ),
        'npmmirror'
      )
      await control.evaluate(
        `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
      )
      assert.deepEqual(
        await control.evaluate(sourceValue()),
        { value: 'official', disabled: false },
        '晚到的推荐不能覆盖手动选择'
      )
    }
  } else {
    assert.equal(
      await control.evaluate(
        `window.__TAURI_INTERNALS__.invoke('get_environment_download_source')`
      ),
      expectedSource
    )
    await until(
      async () => (await control.evaluate(sourceValue()))?.value === expectedSource,
      '按国家代码设置默认源',
      5000
    )
  }
  await assertSetupFits(control, '安装并打开')
  await control.evaluate(click('安装并打开'))
  await until(() => control.evaluate('!!window.desktopSetupPreparedArgs'), '提交当前下载源')
  assert.deepEqual(await control.evaluate('window.desktopSetupPreparedArgs'), {
    url: managedUrl,
    downloadSource: expectedSource
  })
  if (sourceScenario === 'late-start') {
    releaseCountry()
    assert.equal(
      await control.evaluate(
        `window.__TAURI_INTERNALS__.invoke('get_environment_download_source')`
      ),
      'npmmirror'
    )
    await control.evaluate(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    )
  }
  await until(
    () =>
      control.evaluate(
        `document.body.innerText.includes('取消安装') && !!document.querySelector('progress[aria-label="Node.js下载进度"]')`
      ),
    '并行准备界面'
  )
  await assertSetupFits(control, '取消安装')
  assert.equal(await control.evaluate(sourceValue()), null, '安装开始后隐藏修改源的入口')
  assert.equal(countryRequests, 1, 'IP 推荐每次进程只查询一次')
  assert.equal(
    await control.evaluate(`document.body.innerText.includes('连接已有 Pi Desk')`),
    false
  )
  await control.screenshot('environment-preparing.png')
  await control.theme('dark')
  await assertSetupFits(control, '取消安装')
  await control.screenshot('environment-preparing-dark.png')
  await control.theme('light')
  await control.viewport(720, 560)
  await assertSetupFits(control, '取消安装')
  await control.screenshot('environment-preparing-compact.png')
  const normalText = await control.evaluate('document.body.innerText')
  for (const text of ['正在检测', '未找到可用的', '运行环境目录', '返回地址列表']) {
    assert.equal(normalText.includes(text), false, `不应展示内部检查或页面跳转入口：${text}`)
  }
  assert.ok(normalText.includes('正在下载 Node.js'))
  assert.ok(normalText.includes('正在下载 Git Bash'))
  assert.equal(
    await control.evaluate(
      `[...document.querySelectorAll('summary')].some(item => item.textContent.trim() === '安装详情')`
    ),
    false,
    '必要进度不再折叠'
  )
  assert.equal(
    await control.evaluate(
      `document.querySelector('progress[aria-label="Node.js下载进度"]').value`
    ),
    53
  )
  assert.equal(
    await control.evaluate(
      `document.querySelector('progress[aria-label="Git Bash下载进度"]').value`
    ),
    23
  )
  for (const [name, label] of [
    ['node', 'Node.js'],
    ['bash', 'Git Bash'],
    ['pi', 'Pi']
  ]) {
    await control.evaluate(`(() => {
      const env = window.desktopSetupFixture.environment;
      env.components.forEach(item => { item.download = null; });
      env.step = ${JSON.stringify(`正在安装 ${label}`)};
      const order = ['node', 'bash', 'pi'];
      env.components.forEach(item => {
        const before = order.indexOf(item.name) < order.indexOf(${JSON.stringify(name)});
        item.status = before ? 'ready' : 'missing';
        item.detail = item.name === ${JSON.stringify(name)} ? env.step : null;
      });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`)
    await until(
      () =>
        control.evaluate(
          `document.body.innerText.includes(${JSON.stringify(`正在安装 ${label}`)})`
        ),
      `${label} 顺序安装状态`
    )
    assert.equal(
      await control.evaluate(
        `document.querySelector('progress[aria-label="${label}安装进度"]')?.hasAttribute('value')`
      ),
      false,
      '无法量化的安装阶段不伪造百分比'
    )
    assert.equal(await control.evaluate('location.hash'), '', '安装状态不得切换页面')
    assert.equal(
      await control.evaluate(
        `[...document.querySelectorAll('ol[aria-label="安装步骤"] li')].filter(item => item.innerText.includes('正在安装')).length`
      ),
      1,
      '只有当前组件显示安装中'
    )
    if (name === 'pi') await control.screenshot('environment-installing-pi.png')
  }
  await control.clearViewport()
  await control.evaluate(`(() => {
    window.desktopSetupFixture.environment.status = 'failed';
    window.desktopSetupFixture.environment.error = '下载连接超时，请检查网络后重试。\\n' + '连接安装源时超时，未完成的下载已停止。\\n'.repeat(60);
    window.desktopSetupFixture.environment.components.forEach(item => { item.download = null; item.detail = null; });
    document.dispatchEvent(new Event('visibilitychange'));
  })()`)
  await until(
    () => control.evaluate(`document.body.innerText.includes('重试安装')`),
    '只有错误时显示问题信息'
  )
  await until(
    () => control.evaluate(`document.body.innerText.includes('下载连接超时，请检查网络后重试。')`),
    '安装失败原因直接展示',
    5000
  )
  await assertSetupFits(control, '重试安装')
  await control.screenshot('environment-error.png')
  await control.evaluate(`(() => {
    window.desktopSetupFixture.environment.status = 'installing';
    window.desktopSetupFixture.environment.error = null;
    window.desktopSetupFixture.environment.components[0].detail = '正在下载 Node.js';
    window.desktopSetupFixture.environment.components[0].download = { received: 48318382, total: 90439680 };
    document.dispatchEvent(new Event('visibilitychange'));
  })()`)
  await until(
    () => control.evaluate(`document.body.innerText.includes('取消安装')`),
    '错误恢复后只显示必要进度'
  )
  await control.evaluate(click('取消安装'))
  await until(
    () =>
      control.evaluate(
        `window.desktopSetupCancelled && document.body.innerText.includes('安装并打开')`
      ),
    '取消准备返回可继续操作状态'
  )
  await control.evaluate(targetAction(targetUrl, '编辑地址'))
  const draftUrl = `${targetUrl}draft`
  await control.evaluate(field('网页地址', draftUrl))
  for (const status of ['checking', 'ready', 'required']) {
    await control.evaluate(`(() => {
      const state = window.desktopSetupFixture;
      state.environment.status = ${JSON.stringify(status)};
      state.environment.error = null;
      state.environment.step = '';
      state.environment.components.forEach(item => { item.status = ${JSON.stringify(status === 'ready' ? 'ready' : 'missing')}; item.detail = null; });
      const target = state.targets.find(item => item.url === ${JSON.stringify(managedUrl)});
      target.server.needsSetup = ${status !== 'ready'};
      target.server.status = ${JSON.stringify(status === 'ready' ? 'running' : 'stopped')};
      document.dispatchEvent(new Event('visibilitychange'));
    })()`)
    const text =
      status === 'checking' ? '请稍候…' : status === 'ready' ? '打开 Pi Desk' : '安装并打开'
    await until(
      () => control.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`),
      `${status} 状态在原区域显示`
    )
    assert.equal(await control.evaluate('location.hash'), '', '环境检查和结果不得跳页')
    assert.equal(
      await control.evaluate('document.querySelector("input")?.value'),
      draftUrl,
      '后台状态变化保留地址编辑草稿'
    )
    if (status === 'ready') await control.screenshot('control-ready-inline-edit.png')
  }
  await control.evaluate(`document.querySelector('button[aria-label="取消编辑地址"]').click()`)
  await control.evaluate(`(() => {
    window.fetch = window.desktopSetupOriginalFetch;
    delete window.desktopSetupOriginalFetch;
    delete window.desktopSetupFixture;
    delete window.desktopSetupCancelled;
    delete window.desktopSetupPreparedArgs;
    delete window.desktopSetupKeyboard;
    document.dispatchEvent(new Event('visibilitychange'));
    window.scrollTo(0, 0);
  })()`)
  await control.clearViewport()
  await until(
    () => control.evaluate(`document.body.innerText.includes('安装并打开')`),
    '还原真实检测状态'
  )
  await control.evaluate(
    `(() => { const summary = [...document.querySelectorAll('summary')].find(item => item.textContent.trim() === '安装选项'); if (!summary.parentElement.open) summary.click(); })()`
  )
  await until(() => control.evaluate(sourceValue()), '安装选项展开')
  await control.evaluate(`(() => {
    const summary = [...document.querySelectorAll('summary')].find(item => item.textContent.includes('Pi') && !item.textContent.includes('Git Bash'));
    if (!summary.parentElement.open) summary.click();
    const clipboard = navigator.clipboard;
    window.desktopOriginalClipboardWrite = clipboard.writeText;
    clipboard.writeText = async text => { window.desktopCopiedInstallCommand = text; };
  })()`)
  for (const [source, registry] of [
    ['npmmirror', 'https://mirrors.cloud.tencent.com/npm'],
    ['official', 'https://registry.npmjs.org']
  ]) {
    await control.evaluate(sourceField(source))
    const command = `npm install -g --ignore-scripts --registry ${registry} @earendil-works/pi-coding-agent`
    await until(
      () => control.evaluate(`document.body.innerText.includes(${JSON.stringify(command)})`),
      '手动安装显示所选源'
    )
    await control.evaluate(click('复制安装命令'))
    await until(
      () => control.evaluate(`document.body.innerText.includes('已复制')`),
      '所选源命令已复制'
    )
    assert.equal(await control.evaluate('window.desktopCopiedInstallCommand'), command)
  }
  await control.evaluate(`(() => {
    navigator.clipboard.writeText = window.desktopOriginalClipboardWrite;
    delete window.desktopOriginalClipboardWrite;
    delete window.desktopCopiedInstallCommand;
  })()`)
  assert.equal(
    await control.evaluate(`document.body.innerText.includes('未找到可用的')`),
    false,
    '手动安装不重复展示缺失状态提示'
  )
  assert.equal(
    await control.evaluate(
      `[...document.querySelectorAll('details[name="environment-component"]')].filter(item => item.open).length`
    ),
    1,
    '手动安装一次只展开当前组件'
  )
  await assertSetupFits(control, '安装并打开')
  await control.screenshot('environment-manual.png')
  await control.viewport(720, 560)
  await assertSetupFits(control, '安装并打开')
  await control.clearViewport()

  const sourceReservation = createServer()
  sourcePort = await listen(sourceReservation)
  await new Promise((done) => sourceReservation.close(done))
  const sourceUrl = `http://127.0.0.1:${sourcePort}/`
  const sourceEntry = join(root, 'source-preparation-service.cjs')
  await writeFile(
    sourceEntry,
    `require('node:http').createServer((req,res)=>res.writeHead(200).end('下载源保存验收')).listen(Number(process.argv[2]),'127.0.0.1')`
  )
  await control.evaluate(
    `window.__TAURI_INTERNALS__.invoke('apply_target_command', ${JSON.stringify({ originalUrl: null, value: { url: sourceUrl, server: { startCommand: `"${process.execPath}" "${sourceEntry}" {port}`, readyPath: '/', package: null }, tunnel: null } })})`
  )
  await control.evaluate(
    `window.__TAURI_INTERNALS__.invoke('prepare_environment_command', ${JSON.stringify({ url: sourceUrl, downloadSource: expectedSource })})`
  )
  await until(
    () =>
      control.evaluate(
        `window.__TAURI_INTERNALS__.invoke('get_control_state').then(state => state.targets.some(target => target.url === ${JSON.stringify(sourceUrl)} && target.server.status === 'running') && state.environment.status !== 'installing')`
      ),
    '原生准备入口完成并保存选定源'
  )
  const savedSource = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'))
  assert.deepEqual(
    savedSource,
    { downloadSource: expectedSource },
    '只保存开始时接受的下载源，不记录IP或推荐状态'
  )
  assert.equal(
    await control.evaluate(`window.__TAURI_INTERNALS__.invoke('get_environment_download_source')`),
    expectedSource
  )
  assert.equal(countryRequests, 1, '保存选择后不应再次查询IP')
  await control.evaluate(
    `window.__TAURI_INTERNALS__.invoke('stop_server_command', ${JSON.stringify({ url: sourceUrl })})`
  )
  await until(
    () =>
      assertPortReleased(sourcePort).then(
        () => true,
        () => false
      ),
    '来源验收服务已停止',
    5000
  )
  await control.evaluate(
    `(() => { for (const summary of document.querySelectorAll('summary')) { if (summary.textContent.trim() === '安装选项' && summary.parentElement.open) summary.click(); } })()`
  )
  assert.equal(
    await control.evaluate(
      '[...document.styleSheets].some(sheet => sheet.href?.endsWith("l4-desktop-ui.css"))'
    ),
    true
  )
  await control.screenshot('control-ready.png')
  await control.evaluate(click('添加连接'))
  await until(
    () =>
      control.evaluate(
        `!location.hash && !!document.querySelector('form[aria-label="添加地址"] input')`
      ),
    '设置页交互'
  )
  const addedUrl = `${targetUrl}added`
  await control.evaluate(field('网页地址', addedUrl))
  await control.evaluate(click('添加并打开'))
  await until(
    () =>
      control.evaluate(
        `!location.hash && document.body.innerText.includes(${JSON.stringify(addedUrl)})`
      ),
    '新增网址保存'
  )
  assert.ok(
    JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).targets.some(
      (target) => target.url === addedUrl && !target.server
    )
  )

  await control.evaluate(targetAction(addedUrl, '编辑地址'))
  await until(
    () =>
      control.evaluate(
        `document.querySelector('form[aria-label="编辑地址"] input')?.value === ${JSON.stringify(addedUrl)}`
      ),
    '原行回显地址'
  )
  await control.evaluate(field('网页地址', 'ftp://example.com'))
  await control.evaluate(click('保存'))
  await until(
    () => control.evaluate(`document.body.innerText.includes('请输入 http:// 或 https:// 地址')`),
    '行内地址错误保留输入'
  )
  assert.equal(await control.evaluate('document.querySelector("input").value'), 'ftp://example.com')
  const editedUrl = `${targetUrl}edited`
  await control.evaluate(field('网页地址', editedUrl))
  await control.screenshot('address-edit.png')
  await control.evaluate(click('保存'))
  await until(
    () =>
      control.evaluate(
        `!document.querySelector('form[aria-label="编辑地址"]') && document.body.innerText.includes(${JSON.stringify(editedUrl)})`
      ),
    '原行地址保存完成'
  )
  const editedTargets = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).targets
  assert.ok(editedTargets.some((target) => target.url === editedUrl && !target.server))
  assert.ok(!editedTargets.some((target) => target.url === addedUrl))
  assert.equal(await control.evaluate('location.hash'), '', '地址添加编辑不进入设置页')
  if (setupOnly) {
    assert.deepEqual(control.errors, [], '安装和行内编辑不应出现 JavaScript 异常')
    passed = true
    break validation
  }

  await control.evaluate(targetAction(managedUrl, '本机设置'))
  await until(
    () => control.evaluate(`document.querySelector('textarea')?.value === 'node old-service.cjs'`),
    '已有服务设置读取'
  )
  await control.evaluate(
    `(() => { const summary = [...document.querySelectorAll('summary')].find(item => item.textContent.trim() === '高级设置'); summary.click(); })()`
  )
  await control.evaluate(field('管理服务安装包', false))
  await control.evaluate(field('管理服务安装包', true))
  const startCommand = 'npm --prefix node_modules/@desktop/new-service start'
  await control.evaluate(field('启动命令', startCommand))
  await control.evaluate(field('就绪路径', '/health-unavailable'))
  await control.evaluate(field('包名', '@desktop/new-service'))
  await control.evaluate(field('下载源', targetUrl))
  await control.evaluate(field('启动自动更新', true))
  await control.evaluate(`window.updateWarning = null; window.previousConfirm = window.confirm;
    window.confirm = (message) => { window.updateWarning = message; return true; }`)
  try {
    await control.evaluate(field('定时自动更新', true))
    assert.match(await control.evaluate('window.updateWarning'), /运行中的任务被打断.*谨慎/)
  } finally {
    await control.evaluate(
      'window.confirm = window.previousConfirm; delete window.previousConfirm; delete window.updateWarning'
    )
  }
  await control.screenshot('settings-generic.png')
  await control.evaluate(click('保存设置'))
  await until(() => control.evaluate('location.hash === "#/"'), '服务设置保存')
  const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).targets.find(
    (target) => target.url === managedUrl
  )
  assert.deepEqual(saved.server, {
    startCommand,
    readyPath: '/health-unavailable',
    package: {
      name: '@desktop/new-service',
      registry: targetUrl.slice(0, -1),
      startupUpdate: 'update',
      periodicUpdate: 'update',
      channel: 'stable'
    }
  })
  const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')).targets[managedUrl]
  assert.equal(runtime.lastVersion, undefined, '更换包后不得沿用旧包版本')
  assert.equal(runtime.autoStart, false, '更换包不得改变明确停止状态')

  await control.evaluate(targetAction(managedUrl, '本机设置'))
  await until(
    () =>
      control.evaluate(
        `document.querySelector('textarea')?.value === ${JSON.stringify(startCommand)}`
      ),
    '服务设置回读'
  )
  const fields = await control.evaluate(`['包名', '启动自动更新', '定时自动更新'].map(name => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.trim().startsWith(name));
    const input = label?.querySelector('input');
    return ['checkbox', 'radio'].includes(input?.type) ? input.checked : input?.value;
  })`)
  assert.deepEqual(fields, ['@desktop/new-service', true, true])
  await control.evaluate(click('取消'))
  await until(() => control.evaluate('location.hash === "#/"'), '取消设置返回')
  const missingState = await control.evaluate(
    `window.__TAURI_INTERNALS__.invoke('get_control_state')`
  )
  assert.equal(
    missingState.targets.find((target) => target.url === managedUrl).server.needsSetup,
    true
  )
  assert.equal(
    (await targets()).some((target) => target.url === managedUrl),
    false,
    '未准备的本机服务不得打开不可访问网页'
  )
  assert.equal(
    /\bview\s+["']?@desktop\//u.test(await readFile(join(root, 'logs/desktop.log'), 'utf8')),
    false,
    '缺少 Node/npm 时不执行包查询'
  )
  await control.evaluate(targetAction(targetUrl, '打开'))
  const browserTarget = await until(
    async () => (await targets()).find((target) => target.url === targetUrl),
    '实际网址窗口'
  )
  const browser = await connect(browserTarget)
  await until(
    () => browser.evaluate('document.querySelector("h1")?.textContent === "网页窗口验证通过"'),
    '网址页面显示'
  )
  assert.equal(
    await browser.evaluate(
      '(async () => { if (!window.__TAURI_INTERNALS__) return true; try { await window.__TAURI_INTERNALS__.invoke("get_control_state"); return false; } catch { return true; } })()'
    ),
    true,
    '外部网页不得调用宿主控制命令'
  )
  const healthyReservation = createServer()
  healthyPort = await listen(healthyReservation)
  await new Promise((done) => healthyReservation.close(done))
  const healthyUrl = `http://127.0.0.1:${healthyPort}/`
  const healthyEntry = join(root, 'healthy-service.cjs')
  await writeFile(
    healthyEntry,
    `require('node:http').createServer((req,res)=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({architecture:process.arch}))).listen(Number(process.argv[2]),'127.0.0.1')`
  )
  const healthyTarget = {
    url: healthyUrl,
    server: {
      startCommand: `"${process.execPath}" "${healthyEntry}" {port}`,
      readyPath: '/health',
      package: null
    },
    tunnel: null
  }
  await control.evaluate(
    `window.__TAURI_INTERNALS__.invoke('apply_target_command', ${JSON.stringify({ originalUrl: null, value: healthyTarget })})`
  )
  await control.evaluate(
    `window.__TAURI_INTERNALS__.invoke('stop_server_command', ${JSON.stringify({ url: healthyUrl })})`
  )
  await control.evaluate(
    `window.__TAURI_INTERNALS__.invoke('open_target_command', ${JSON.stringify({ url: healthyUrl })})`
  )
  await until(
    () =>
      control.evaluate(
        `window.__TAURI_INTERNALS__.invoke('get_control_state').then(value=>value.targets.some(target=>target.url===${JSON.stringify(healthyUrl)}&&target.server.status==='running'))`
      ),
    '自带运行时的本机服务启动成功'
  )
  assert.equal(
    await control.evaluate(
      `window.__TAURI_INTERNALS__.invoke('get_control_state').then(value=>value.targets.find(target=>target.url===${JSON.stringify(healthyUrl)}).server.autoStart)`
    ),
    true,
    '手动重新启动应恢复自动启动'
  )
  const protectedError = await control.evaluate(
    `window.__TAURI_INTERNALS__.invoke('select_environment_command', {component:'node',archive:false}).then(()=>null,error=>String(error))`
  )
  assert.ok(protectedError?.includes('先停止本机服务'), '运行中不得更换共享环境')
  const healthyResponse = await fetch(healthyUrl)
  assert.equal(healthyResponse.status, 200, '环境修改拒绝不得中断运行中的服务')
  assert.deepEqual(
    await healthyResponse.json(),
    { architecture: process.arch },
    '32位壳必须保持子进程自身架构'
  )
  await control.evaluate(
    `window.__TAURI_INTERNALS__.invoke('stop_server_command', ${JSON.stringify({ url: healthyUrl })})`
  )
  await assertPortReleased(healthyPort)
  assert.deepEqual(connections[0].errors, [], '控制页面不应出现 JavaScript 异常')
  passed = true
} catch (error) {
  validationError = error
  console.error('验收首个失败：', error)
  await writeFile(join(root, 'failure.txt'), error.stack ?? String(error))
  await writeFile(join(root, 'debug-probe.json'), JSON.stringify(lastDebugProbe ?? null, null, 2))
  if (connections[0]) {
    await connections[0].screenshot('failure.png').catch(() => {})
    const state = await connections[0]
      .evaluate(
        `({ focused: document.hasFocus(), visibility: document.visibilityState, activeElement: document.activeElement?.outerHTML, keyboard: window.desktopSetupKeyboard, details: [...document.querySelectorAll('details')].map(item=>({ open: item.open, summary: item.querySelector('summary')?.textContent })) })`
      )
      .catch(() => null)
    await writeFile(join(root, 'failure-state.json'), JSON.stringify(state, null, 2))
  }
  console.error(`${layoutOnly ? '前端布局' : '原生页面'}验收失败，现场：${root}`)
  throw error
} finally {
  if (layoutOnly && connections[0]) {
    await connections[0].shutdown().catch(() => {})
    await Promise.race([exit, new Promise((done) => setTimeout(done, 5000))])
  }
  for (const connection of connections) connection.close()
  try {
    if (child) {
      try {
        await stopE2eServerTree({ child, exit, port: debugPort, managed: false })
      } catch (error) {
        // taskkill 可能因子进程已自行退出报错；只在父进程已退出时核对端口。
        if (error.code !== 'EADDRINUSE') {
          try {
            await Promise.race([
              exit,
              new Promise((_, reject) => {
                setTimeout(() => reject(error), 5000).unref()
              })
            ])
          } catch (cleanupError) {
            let exited = false
            try {
              process.kill(child.pid, 0)
            } catch (probeError) {
              exited = probeError.code === 'ESRCH'
            }
            await writeFile(
              join(root, 'cleanup-state.json'),
              JSON.stringify(
                {
                  pid: child.pid,
                  exitCode: child.exitCode,
                  signalCode: child.signalCode,
                  exited,
                  error: String(cleanupError)
                },
                null,
                2
              )
            )
            if (!exited) {
              if (validationError) console.error('验收进程清理另有错误：', cleanupError)
              throw validationError ?? cleanupError
            }
            child.stdout?.destroy()
            child.stderr?.destroy()
          }
        }
        const deadline = Date.now() + 5000
        while (true) {
          try {
            await assertPortReleased(debugPort)
            break
          } catch (cause) {
            if (cause.code !== 'EADDRINUSE' || Date.now() >= deadline) throw cause
            await new Promise((done) => setTimeout(done, 100))
          }
        }
      }
    } else await assertPortReleased(debugPort)
    child?.stdout?.destroy()
    child?.stderr?.destroy()
    child?.unref()
  } finally {
    fixture.closeAllConnections()
    await new Promise((done) => fixture.close(done))
    await assertPortReleased(fixturePort)
    if (healthyPort) await assertPortReleased(healthyPort)
    if (sourcePort) await assertPortReleased(sourcePort)
    pendingCountry?.destroy()
    output.end()
    await once(output, 'close')
    if (moved) await rename(heldFrontend, frontend)
    if (passed) await rm(dirname(agent), { recursive: true, force: true })
  }
}
await writeFile(
  join(root, 'result.json'),
  JSON.stringify(
    layoutOnly
      ? {
          passed,
          scope: 'desktop-web-layout',
          mockedNativeIpc: true,
          controlViewport: { width: 960, height: 720 },
          minimumViewport: { width: 720, height: 560 },
          portsReleased: true
        }
      : startupOnly
        ? {
            passed,
            scope: 'desktop-startup-window-flow',
            portsReleased: true,
            startupCheckNonBlocking: true,
            preferencesPersisted: true,
            remoteAndLocalWindowSwitching: true,
            updateWakeAndQuietFailure: true
          }
        : {
            passed,
            frontendDirectoryAbsent: true,
            controlAndBrowserVerified: !setupOnly,
            settingsSavedAndReloaded: !setupOnly,
            missingEnvironmentBlockedNpm: !setupOnly,
            manualSetupAndRemoteAccessVerified: !setupOnly,
            preparationFitsDefaultAndMinimumViewport: true,
            preparationCurrentStatusVisible: true,
            perComponentProgressAndHomeStable: true,
            inlineAddressSavedAndReloaded: true,
            preparationErrorVisibleAndCancelVerified: true,
            controlViewport: { width: 960, height: 720 },
            minimumViewport: { width: 720, height: 560 },
            preparationUiUsesIsolatedFixture: true,
            sourceScenario,
            countryRecommendationVerified: true,
            sourceSelectableBeforeStartAndFixedAfterStart: true,
            selectedSourceSavedThroughNativeCommand: true,
            manualInstallCommandMatchesSource: true,
            activeRuntimeProtected: !setupOnly,
            shellArchitecture: 'ia32',
            childArchitecture: process.arch,
            portsReleased: true
          },
    null,
    2
  )
)
console.info(`${layoutOnly ? '前端布局' : '原生页面'}验收通过，进程与端口已释放：${root}`)
