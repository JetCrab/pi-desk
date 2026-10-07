import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
const executable = resolve(process.argv[2] ?? '')
const frontend = resolve(process.argv[3] ?? '')
const identifier = 'com.jetcrab.desktop.ui-smoke'
const setupOnly = process.argv.includes('--setup-only')
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
assert.equal(executableBytes.readUInt16LE(peOffset + 4), 0x014c, '必须验收真实的32位壳程序')
assert.ok(
  executableBytes.includes(Buffer.from(identifier)),
  '测试程序必须使用独立 identifier，禁止接管真实桌面实例'
)
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
const fixture = createServer((request, response) => {
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
    async pressEnter() {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        text: '\r',
        unmodifiedText: '\r',
        windowsVirtualKeyCode: 13
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      })
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
  return `(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error('操作不可用：' + ${JSON.stringify(text)}); button.click(); return true; })()`
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
    if (input.type === 'checkbox') {
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
    const target = [...document.querySelectorAll('article')].find(item => [...item.querySelectorAll('h2, p')].some(text => text.textContent.trim() === ${JSON.stringify(url)}));
    const summary = target?.querySelector('summary[aria-label]');
    if (summary && !summary.parentElement.open) summary.click();
    const button = [...(target?.querySelectorAll('button') ?? [])].find(item => item.textContent.trim() === ${JSON.stringify(action)});
    if (!button || button.disabled) throw new Error('网址操作不可用：' + ${JSON.stringify(action)});
    button.click();
    return true;
  })()`
}

validation: try {
  await rename(frontend, heldFrontend)
  moved = true
  child = spawn(executable, [], {
    cwd: root,
    env: {
      ...process.env,
      ...isolatedPiEnvironment(agent),
      HOME: process.env.USERPROFILE,
      PI_DESK_DESKTOP_DATA_DIR: root,
      PI_DESK_DESKTOP_DISCOVERY_PATH: '',
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
  const controlTarget = await until(
    async () =>
      (await targets()).find(
        (target) => target.type === 'page' && target.url.startsWith('http://tauri.localhost')
      ),
    '内嵌页面地址'
  )
  const control = await connect(controlTarget)
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
        download: null,
        components: [
          { name: 'node', status: 'missing', version: null, path: null, detail: null },
          { name: 'pi', status: 'missing', version: null, path: null, detail: null },
          { name: 'bash', status: 'missing', version: null, path: null, detail: null }
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
        window.desktopSetupFixture.environment.download = { received: 48318382, total: 90439680 };
        document.dispatchEvent(new Event('visibilitychange'));
        return response(null);
      }
      if (command === 'cancel_environment_command') {
        window.desktopSetupCancelled = true;
        window.desktopSetupFixture.environment.status = 'required';
        window.desktopSetupFixture.environment.download = null;
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
        `document.body.innerText.includes('取消安装') && !!document.querySelector('progress[aria-label="下载进度"]')`
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
  assert.ok(normalText.includes('正在下载 Node.js、Git Bash'))
  assert.deepEqual(
    await control.evaluate(
      `[...document.querySelectorAll('ol[aria-label="安装步骤"] li')].map(item => item.innerText.replace(/\\s+/g, ' ').trim())`
    ),
    ['Node.js 正在下载 Node.js', 'Git Bash 正在下载 Git Bash', 'Pi 等待安装', 'Pi Desk 等待启动']
  )
  for (const [name, label] of [
    ['node', 'Node.js'],
    ['bash', 'Git Bash'],
    ['pi', 'Pi']
  ]) {
    await control.evaluate(`(() => {
      const env = window.desktopSetupFixture.environment;
      env.download = null;
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
      await control.evaluate('!!document.querySelector("progress")'),
      false,
      '安装阶段不显示已完成的下载进度'
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
    window.desktopSetupFixture.environment.download = null;
    document.dispatchEvent(new Event('visibilitychange'));
  })()`)
  await until(
    () => control.evaluate(`document.body.innerText.includes('重试安装')`),
    '只有错误时显示问题信息'
  )
  await control.evaluate(`(() => {
    const summary = [...document.querySelectorAll('summary')].find(item => item.textContent.trim() === '问题详情');
    summary.focus();
  })()`)
  await control.pressEnter()
  await until(
    () => control.evaluate(`document.body.innerText.includes('下载连接超时，请检查网络后重试。')`),
    '键盘展开错误详情',
    5000
  )
  await assertSetupFits(control, '重试安装')
  await control.screenshot('environment-error.png')
  await control.evaluate(`(() => {
    window.desktopSetupFixture.environment.status = 'installing';
    window.desktopSetupFixture.environment.error = null;
    window.desktopSetupFixture.environment.download = { received: 48318382, total: 90439680 };
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
    ['npmmirror', 'https://registry.npmmirror.com'],
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
  await control.evaluate(click('添加地址'))
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

  await control.evaluate(targetAction(managedUrl, '设置'))
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
  await control.evaluate(field('启动时自动更新', true))
  await control.evaluate(field('运行时自动检查并更新', true))
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
      autoUpdateOnStart: true,
      periodicUpdateCheck: true
    }
  })
  const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')).targets[managedUrl]
  assert.equal(runtime.lastVersion, undefined, '更换包后不得沿用旧包版本')
  assert.equal(runtime.autoStart, false, '更换包不得改变明确停止状态')

  await control.evaluate(targetAction(managedUrl, '设置'))
  await until(
    () =>
      control.evaluate(
        `document.querySelector('textarea')?.value === ${JSON.stringify(startCommand)}`
      ),
    '服务设置回读'
  )
  const fields =
    await control.evaluate(`['包名', '启动时自动更新', '运行时自动检查并更新'].map(name => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.trim().startsWith(name));
    const input = label?.querySelector('input');
    return input?.type === 'checkbox' ? input.checked : input?.value;
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
  if (connections[0]) {
    await connections[0].screenshot('failure.png').catch(() => {})
    const state = await connections[0]
      .evaluate(
        `({ focused: document.hasFocus(), visibility: document.visibilityState, activeElement: document.activeElement?.outerHTML, keyboard: window.desktopSetupKeyboard, details: [...document.querySelectorAll('details')].map(item=>({ open: item.open, summary: item.querySelector('summary')?.textContent })) })`
      )
      .catch(() => null)
    await writeFile(join(root, 'failure-state.json'), JSON.stringify(state, null, 2))
  }
  console.error(`原生页面验收失败，现场：${root}`)
  throw error
} finally {
  for (const connection of connections) connection.close()
  try {
    if (child) {
      try {
        await stopE2eServerTree({ child, exit, port: debugPort, managed: false })
      } catch (error) {
        // WebView2 的端口可能晚于桌面父进程释放，观察实际释放而不是固定等待。
        if (error.code !== 'EADDRINUSE') throw error
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
    {
      passed,
      frontendDirectoryAbsent: true,
      controlAndBrowserVerified: !setupOnly,
      settingsSavedAndReloaded: !setupOnly,
      missingEnvironmentBlockedNpm: !setupOnly,
      manualSetupAndRemoteAccessVerified: !setupOnly,
      preparationFitsDefaultAndMinimumViewport: true,
      preparationCurrentStatusAndKeyboardVerified: true,
      preparationStepsOrderedAndHomeStable: true,
      inlineAddressSavedAndReloaded: true,
      preparationErrorOnlyDetailsAndCancelVerified: true,
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
console.info(`原生页面验收通过，进程与端口已释放：${root}`)
