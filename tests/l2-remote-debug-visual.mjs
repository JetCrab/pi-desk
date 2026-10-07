import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  clickAriaLabel,
  clickText,
  createCdpPage,
  evaluate,
  navigate,
  publishScreenshots,
  reservePort,
  screenshot,
  setViewport,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'
import { assertPortReleased, spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const taskId = `settings-launch-${process.pid}`
const testRoot = join(projectRoot, 'temp', 'run', 'remote-debug-visual', taskId)
const agentRoot = join(projectRoot, 'temp', 'pi', 'remote-debug-visual', taskId)
const agentDir = join(agentRoot, 'agent')
const desktopAppDataDir = join(testRoot, 'appdata')
const projectDir = join(testRoot, '远程调试视觉项目')
const packageDir = resolve(
  process.env.REMOTE_DEBUG_VISUAL_PACKAGE_DIR ??
    join(projectRoot, 'plugins', 'pi-desk-remote-debug')
)
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const workId = 'remote-debug-visual-work-session'
let entryPort = 0
const outputs = {
  idle: join(testRoot, 'launch-idle.png'),
  running: join(testRoot, 'launch-running.png'),
  details: join(testRoot, 'launch-details.png'),
  failed: join(testRoot, 'launch-failed.png'),
  mobile: join(testRoot, 'launch-mobile.png'),
  ranges: join(testRoot, 'settings-allocation.png'),
  connection: join(testRoot, 'settings-connection.png'),
  ports: join(testRoot, 'settings-ports.png'),
  portsMobile: join(testRoot, 'settings-ports-mobile.png')
}
const password = 'Qq.445566'
let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''
const originalAppData = process.env.APPDATA
const desktopEnvironmentKeys = ['PI_DESK_DESKTOP_EXECUTABLE', 'PI_DESK_DESKTOP_CONFIG']
const originalDesktopEnvironment = desktopEnvironmentKeys.map((key) => process.env[key])
let passed = false
const registryOnly = process.env.REMOTE_DEBUG_VISUAL_SCOPE === 'registry'
const settingsOnly = registryOnly || process.env.REMOTE_DEBUG_VISUAL_SCOPE === 'settings'
const launchOnly = process.env.REMOTE_DEBUG_VISUAL_SCOPE === 'launch'
const captures = []

async function buildPackages() {
  console.log('[remote-debug] 构建 SDK 与远程调试包')
  const command =
    'pnpm --filter @jetcrab/pi-desk-sdk build && pnpm --filter @jetcrab/pi-desk-remote-debug build'
  await execFileAsync('cmd.exe', ['/d', '/s', '/c', command], {
    cwd: projectRoot,
    windowsHide: true
  })
  console.log('[remote-debug] 包构建完成')
}

async function compileFakeTunnelClient() {
  const sourcePath = join(testRoot, 'fake-tunnel-client.rs')
  const binaryPath = join(testRoot, 'fake-tunnel-client.exe')
  await writeFile(
    sourcePath,
    `use std::env;
use std::io::{self, Read, Write};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|value| value == "--tunnel-info") {
        println!("{{\\\"controlServerUrl\\\":\\\"http://tunnel.example.test:7001\\\"}}");
        return;
    }
    let port = args.windows(2)
        .find(|pair| pair[0] == "--public-port")
        .map(|pair| pair[1].clone())
        .unwrap_or_else(|| "0".to_string());
    println!("{{\\\"type\\\":\\\"opening\\\"}}");
    println!("{{\\\"type\\\":\\\"connecting\\\",\\\"publicAddr\\\":\\\"tunnel.example.test:{}\\\"}}", port);
    println!("{{\\\"type\\\":\\\"listening\\\",\\\"publicAddr\\\":\\\"tunnel.example.test:{}\\\"}}", port);
    io::stdout().flush().unwrap();
    let mut input = Vec::new();
    let _ = io::stdin().read_to_end(&mut input);
    println!("{{\\\"type\\\":\\\"stopped\\\"}}");
}
`,
    'utf8'
  )
  await execFileAsync('rustc.exe', [sourcePath, '-O', '-o', binaryPath], {
    cwd: projectRoot,
    windowsHide: true
  })
  return binaryPath
}

async function createFixture() {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(dirname(workSessionStorePath), { recursive: true })
  await mkdir(join(projectDir, '.pi'), { recursive: true })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ packages: [packageDir] }),
    'utf8'
  )
  await writeFile(
    join(agentDir, 'trust.json'),
    JSON.stringify({ [await realpath(projectDir)]: true }),
    'utf8'
  )
  await mkdir(join(desktopAppDataDir, 'com.jetcrab.desktop'), { recursive: true })
  await writeFile(
    join(desktopAppDataDir, 'com.jetcrab.desktop', 'config.json'),
    JSON.stringify({
      targets: [],
      tunnel: {
        controlServerUrl: 'http://tunnel.example.test:7001',
        controlKey: 'ab'.repeat(32),
        deviceId: 'aabbccddeeff00112233445566778899'
      }
    }),
    'utf8'
  )
  const fixtureServerPath = join(projectDir, 'fixture-server.mjs')
  await writeFile(
    fixtureServerPath,
    `import { createServer } from 'node:http'
const port = Number(process.argv[2])
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.end('remote-debug:' + request.url)
})
server.listen(port, '127.0.0.1', () => console.log('fixture server ready port=' + port))
`,
    'utf8'
  )
  await writeFile(
    join(projectDir, '.pi', 'remote_debug.yaml'),
    `version: 1
profiles:
  Web开发:
    description: 网站与接口联调
    command: node ${JSON.stringify(fixtureServerPath)} ${entryPort}
    entryPort: ${entryPort}
    publicPort: 43333
    routes:
      /api: ${entryPort}
  启动失败:
    description: 启动异常示例
    command: node -e "process.stderr.write('fixture remote debug failed\\n'); process.exit(3)"
    entryPort: 30392
    publicPort: 43334
`,
    'utf8'
  )

  const archivedProject = join(testRoot, '已登记归档项目')
  await mkdir(archivedProject, { recursive: true })
  await writeFile(
    join(agentDir, 'pi-desk-remote-debug-ports.json'),
    JSON.stringify({
      localRange: { start: 43000, end: 43999 },
      publicRange: { start: 11001, end: 11099 },
      registrations: [
        {
          cwd: archivedProject,
          profile: 'archive',
          entryPort: 43101,
          routePorts: [43100],
          publicPort: 11006,
          tunnelServer: 'http://tunnel.example.test:7001'
        }
      ]
    })
  )

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  process.env.APPDATA = desktopAppDataDir
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  const timestamp = Date.now()
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '验证远程调试插件。' }],
    timestamp
  })
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '远程调试使用单入口 Gateway。' }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 120,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 160,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: timestamp + 1
  })
  manager.appendSessionInfo('远程调试视觉基线')
  await writeFile(
    workSessionStorePath,
    `${JSON.stringify(
      {
        workSessions: [{ workId, cwd: projectDir, sessionId: manager.getSessionId() }],
        pinnedCount: 0
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

async function clickProfileAction(profile, label) {
  const clicked = await evaluate(
    client,
    `(() => {
      const card = document.querySelector(${JSON.stringify(`[data-remote-debug-profile="${profile}"]`)});
      const button = card && [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)} || item.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!button) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(clicked, true, `未找到 ${profile} 的 ${label} 操作`)
}

let client

async function main() {
  try {
    if (process.env.REMOTE_DEBUG_VISUAL_REUSE_BUILD !== '1') await buildPackages()
    await mkdir(testRoot, { recursive: true })
    const fakeTunnelClient = await compileFakeTunnelClient()
    entryPort = await reservePort()
    await createFixture()
    const originalProjectConfig = await readFile(
      join(projectDir, '.pi', 'remote_debug.yaml'),
      'utf8'
    )
    process.env.PI_DESK_DESKTOP_EXECUTABLE = fakeTunnelClient
    process.env.PI_DESK_DESKTOP_CONFIG = join(
      desktopAppDataDir,
      'com.jetcrab.desktop',
      'config.json'
    )

    appPort = await reservePort()
    cdpPort = await reservePort()
    console.log(`[remote-debug] 启动隔离宿主 ${appPort} 与浏览器 ${cdpPort}`)
    serverRuntime = spawnE2eServer({
      projectRoot,
      agentDir,
      port: appPort,
      development: true,
      onOutput: (output) => {
        serverOutput += output
      }
    })
    await waitForHttp(
      `http://127.0.0.1:${appPort}/api/health`,
      30_000,
      'Pi Desk',
      () => serverOutput
    )
    browserProcess = spawnEdge(edgePath, cdpPort, join(testRoot, 'edge-profile'))
    await waitForHttp(
      `http://127.0.0.1:${cdpPort}/json/version`,
      20_000,
      'Edge CDP',
      () => serverOutput
    )
    client = await createCdpPage(cdpPort)
    await navigate(client, `http://127.0.0.1:${appPort}/login`)
    const login = await evaluate(
      client,
      `fetch('/api/auth/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '6f4df8c6-282c-469e-a48d-9086782c4814' },
        body: JSON.stringify({ password: ${JSON.stringify(password)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(login.ok, true, login.body?.msg)

    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await setViewport(client, 1440, 900, false)
    await waitFor(
      client,
      `[...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '远程调试')`,
      '远程调试入口',
      () => serverOutput
    )
    if (process.env.REMOTE_DEBUG_VISUAL_THEME === 'light') {
      await clickText(client, '设置')
      await waitFor(
        client,
        `[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '浅色')`,
        '外观设置',
        () => serverOutput
      )
      await clickText(client, '浅色')
      await waitFor(
        client,
        `!document.documentElement.classList.contains('dark')`,
        '浅色主题应用',
        () => serverOutput
      )
      await clickAriaLabel(client, '关闭弹窗')
    }
    if (!settingsOnly) {
      await clickText(client, '远程调试视觉项目')
      await evaluate(
        client,
        `document.querySelectorAll('nextjs-portal').forEach((element) => { element.style.display = 'none' })`
      )
      await clickText(client, '远程调试')
      await waitFor(
        client,
        `Boolean(document.querySelector('[data-remote-debug-application]') && document.querySelector('[data-remote-debug-profile="Web开发"]'))`,
        '远程调试 Application',
        () => serverOutput
      )
      await waitFor(
        client,
        `Math.abs(document.querySelector('[data-remote-debug-application]').getBoundingClientRect().height - 480) < 1`,
        '默认内容高度',
        () => serverOutput
      )
      const idleMetrics = await evaluate(
        client,
        `(() => {
        const application = document.querySelector('[data-remote-debug-application]');
        const root = application.getBoundingClientRect();
        const dialog = application.closest('[role="dialog"]').getBoundingClientRect();
        return { width: root.width, height: root.height, dialogHeight: dialog.height, dialogTop: dialog.top, viewportWidth: innerWidth, viewportHeight: innerHeight };
      })()`
      )
      assert.ok(idleMetrics.width >= 880 && idleMetrics.width <= 980)
      assert.equal(idleMetrics.height, 480)
      async function assertStableHeight(message) {
        const dimensions = await evaluate(
          client,
          `(() => {
          const application = document.querySelector('[data-remote-debug-application]');
          const dialog = application.closest('[role="dialog"]').getBoundingClientRect();
          return { height: application.getBoundingClientRect().height, dialogHeight: dialog.height, dialogTop: dialog.top };
        })()`
        )
        assert.equal(dimensions.height, idleMetrics.height, message)
        assert.ok(Math.abs(dimensions.dialogHeight - idleMetrics.dialogHeight) < 1, message)
        assert.ok(Math.abs(dimensions.dialogTop - idleMetrics.dialogTop) < 1, message)
      }
      assert.equal(
        await evaluate(
          client,
          `document.querySelector('[data-remote-debug-profile="Web开发"]').innerText.includes('网站与接口联调')`
        ),
        true
      )
      assert.equal(
        await evaluate(
          client,
          `document.querySelector('[data-remote-debug-profile="Web开发"]').innerText.includes('fixture-server.mjs')`
        ),
        false
      )
      assert.equal(
        await evaluate(
          client,
          `document.querySelector('[data-remote-debug-profile="Web开发"]').querySelectorAll('a').length`
        ),
        0
      )
      assert.ok(
        await evaluate(
          client,
          `document.querySelector('[data-remote-debug-profile="Web开发"]').getBoundingClientRect().height <= 80`
        ),
        '未启动项应保持单行高度'
      )
      captures.push([outputs.idle, await screenshot(client)])

      console.log('[remote-debug] 验收启停、访问地址与按需详情')
      await clickProfileAction('Web开发', '启动')
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-profile="Web开发"] [role="status"]')?.textContent === '运行中' && Boolean(document.querySelector('a[href="http://tunnel.example.test:43333"]'))`,
        '远程调试运行中',
        () => serverOutput
      )
      assert.equal(
        await evaluate(
          client,
          `Boolean(document.querySelector('[data-remote-debug-profile="Web开发"] a[href="http://127.0.0.1:${entryPort}"]'))`
        ),
        true
      )
      assert.equal(
        await evaluate(
          client,
          `document.querySelectorAll('[data-remote-debug-profile="Web开发"] [data-pi-desk-plugin-log-viewer]').length`
        ),
        0
      )
      assert.equal(
        await evaluate(
          client,
          `document.querySelector('[data-remote-debug-profile="Web开发"]').innerText.includes('公网访问已就绪')`
        ),
        false
      )
      await assertStableHeight('启动后弹窗高度和位置保持不变')
      captures.push([outputs.running, await screenshot(client)])
      await clickProfileAction('Web开发', '查看详情')
      await clickProfileAction('Web开发', '查看日志')
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-profile="Web开发"] [data-pi-desk-plugin-log-viewer]')?.innerText.includes('fixture server ready')`,
        '远程调试实时日志',
        () => serverOutput
      )
      assert.equal(
        await evaluate(
          client,
          `document.querySelector('[data-remote-debug-profile="Web开发"]').innerText.includes('fixture-server.mjs')`
        ),
        true
      )

      await assertStableHeight('展开详情和日志后弹窗高度和位置保持不变')
      const scrollMetrics = await evaluate(
        client,
        `(() => {
        const viewport = document.querySelector('[aria-label="调试配置"] [data-slot="plugin-scroll-viewport"]');
        const before = viewport.scrollTop;
        viewport.scrollTop = viewport.scrollHeight;
        return { overflow: viewport.scrollHeight > viewport.clientHeight, moved: viewport.scrollTop > before };
      })()`
      )
      assert.equal(scrollMetrics.overflow, true, '详情超出默认高度时内部列表应可滚动')
      assert.equal(scrollMetrics.moved, true)
      captures.push([outputs.details, await screenshot(client)])
      await clickAriaLabel(client, '关闭 远程调试')
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-application]') === null`,
        '关闭远程调试 Application',
        () => serverOutput
      )
      await clickText(client, '远程调试')
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-profile="Web开发"] [role="status"]')?.textContent === '运行中'`,
        '重开 Application 保留 Run',
        () => serverOutput
      )

      await clickProfileAction('Web开发', '停止')
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-profile="Web开发"]')?.innerText.includes('已停止')`,
        '远程调试停止',
        () => serverOutput
      )
      await assertStableHeight('停止后弹窗高度和位置保持不变')
      await clickProfileAction('启动失败', '启动')
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-profile="启动失败"] [role="status"]')?.textContent === '失败'`,
        '远程调试失败',
        () => serverOutput
      )
      assert.equal(
        await evaluate(
          client,
          `document.querySelectorAll('[data-remote-debug-profile="启动失败"] [data-pi-desk-plugin-log-viewer]').length`
        ),
        0
      )
      assert.equal(
        await evaluate(
          client,
          `document.querySelector('[data-remote-debug-profile="启动失败"]').innerText.includes('项目命令退出码')`
        ),
        false
      )
      await assertStableHeight('失败后弹窗高度和位置保持不变')
      captures.push([outputs.failed, await screenshot(client)])
      await clickProfileAction('启动失败', '查看详情')
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-profile="启动失败"]').innerText.includes('项目命令退出码')`,
        '错误原因只在详情中展示',
        () => serverOutput
      )
      await clickProfileAction('启动失败', '查看日志')
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-profile="启动失败"] [data-pi-desk-plugin-log-viewer]')?.innerText.includes('fixture remote debug failed')`,
        '按需查看失败日志',
        () => serverOutput
      )
      await clickProfileAction('启动失败', '收起详情')

      await clickProfileAction('Web开发', '重新启动')
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-profile="Web开发"] [role="status"]')?.textContent === '运行中'`,
        '移动端运行基线',
        () => serverOutput
      )
      await setViewport(client, 390, 844, true)
      await waitFor(
        client,
        `Boolean(document.querySelector('[data-remote-debug-profile="Web开发"] a[href="http://tunnel.example.test:43333"]'))`,
        '移动端地址和启动操作',
        () => serverOutput
      )
      const mobileMetrics = await evaluate(
        client,
        `(() => {
        const root = document.querySelector('[data-remote-debug-application]');
        const rect = root.getBoundingClientRect();
        return {
          width: rect.width,
          viewportWidth: innerWidth,
          overflow: root.scrollWidth > root.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth
        };
      })()`
      )
      assert.ok(mobileMetrics.width <= mobileMetrics.viewportWidth - 16)
      assert.equal(mobileMetrics.overflow, false)
      const addressRows = await evaluate(
        client,
        `['本地地址', '远程地址'].map(label => {
        const group = document.querySelector('[data-remote-debug-profile="Web开发"] [aria-label="' + label + '"]');
        const boxes = [...group.querySelectorAll('a, button')].map(element => element.getBoundingClientRect());
        const centers = boxes.map(box => box.y + box.height / 2);
        return Math.max(...centers) - Math.min(...centers);
      })`
      )
      assert.ok(
        addressRows.every((difference) => difference < 2),
        '窄屏地址、复制和打开应保持同一行'
      )
      captures.push([outputs.mobile, await screenshot(client)])

      await clickProfileAction('Web开发', '停止')
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-profile="Web开发"]')?.innerText.includes('已停止')`,
        '验收服务停止',
        () => serverOutput
      )
      await setViewport(client, 960, 480, false)
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-application]').getBoundingClientRect().height < 480`,
        '低高度视口适配',
        () => serverOutput
      )
      const lowViewport = await evaluate(
        client,
        `(() => {
        const application = document.querySelector('[data-remote-debug-application]');
        const dialog = application.closest('[role="dialog"]').getBoundingClientRect();
        return { top: dialog.top, bottom: dialog.bottom, height: application.getBoundingClientRect().height, availableHeight: innerHeight };
      })()`
      )
      assert.ok(
        lowViewport.top >= 0 && lowViewport.bottom <= lowViewport.availableHeight,
        '低高度视口弹窗不能超出屏幕'
      )
      assert.ok(lowViewport.height > 0 && lowViewport.height < idleMetrics.height)
      await setViewport(client, 1440, 900, false)
      await clickAriaLabel(client, '关闭 远程调试')
    }
    if (!launchOnly) {
      console.log('[remote-debug] 验收设置保存与已登记项目路径')
      await clickText(client, '设置')
      await waitFor(
        client,
        `Boolean(document.querySelector('button[aria-label="插件设置"]'))`,
        '插件设置导航',
        () => serverOutput
      )
      await clickAriaLabel(client, '插件设置')
      await clickText(client, '远程调试')
      await waitFor(
        client,
        `Boolean(document.querySelector('[data-remote-debug-settings]'))`,
        '远程调试设置页',
        () => serverOutput
      )
      assert.equal(
        await evaluate(
          client,
          `Boolean(document.querySelector('[data-remote-debug-settings] [aria-label="服务端绝对目录"], [data-remote-debug-settings] [aria-label="启动命令"]'))`
        ),
        false
      )
      await evaluate(
        client,
        `document.querySelectorAll('nextjs-portal').forEach(element => { element.style.display = 'none' })`
      )
      await waitFor(
        client,
        `document.querySelector('[data-remote-debug-settings]')?.innerText.includes('已登记归档项目')`,
        '显示未打开会话的已登记项目',
        () => serverOutput
      )
      assert.equal(
        await evaluate(
          client,
          `document.querySelector('[data-remote-debug-settings]').innerText.includes(${JSON.stringify(join(testRoot, '已登记归档项目'))})`
        ),
        true
      )
      if (!registryOnly) {
        await clickText(client, '连接')
        await waitFor(
          client,
          `document.querySelector('[role="tabpanel"][aria-label="连接"]')?.innerText.includes('http://tunnel.example.test:7001')`,
          '连接页签',
          () => serverOutput
        )
        captures.push([outputs.connection, await screenshot(client)])
        await clickText(client, '端口分配')
        await waitFor(
          client,
          `Boolean(document.querySelector('[aria-label="公网结束端口"]'))`,
          '端口分配页签',
          () => serverOutput
        )
        await evaluate(
          client,
          `(() => {
      const input = document.querySelector('[aria-label="公网结束端口"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '11098');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
        )
        await clickText(client, '端口登记')
        await clickText(client, '端口分配')
        assert.equal(
          await evaluate(client, `document.querySelector('[aria-label="公网结束端口"]').value`),
          '11098'
        )
        await clickText(client, '保存端口范围')
        await waitFor(
          client,
          `document.querySelector('[aria-label="公网结束端口"]')?.value === '11098' && [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '保存端口范围' && !button.disabled)`,
          '范围保存完成',
          () => serverOutput
        )
        const registry = JSON.parse(
          await readFile(join(agentDir, 'pi-desk-remote-debug-ports.json'), 'utf8')
        )
        assert.equal(registry.publicRange.end, 11098)
        assert.ok(registry.registrations.some((item) => item.profile === 'archive'))
        assert.equal(
          await readFile(join(projectDir, '.pi', 'remote_debug.yaml'), 'utf8'),
          originalProjectConfig
        )
        await waitFor(
          client,
          `!document.body.innerText.includes('端口范围已保存')`,
          '范围保存提示结束',
          () => serverOutput
        )
        captures.push([outputs.ranges, await screenshot(client)])
        await clickText(client, '端口登记')
      }

      const registered = JSON.parse(
        await readFile(join(agentDir, 'pi-desk-remote-debug-ports.json'), 'utf8')
      )
      const table = `document.querySelector('[role="table"][aria-label="已登记端口"]')`
      const dataRows = `[...(${table}?.querySelectorAll('[role="row"]') ?? [])].filter(row => row.querySelector('[role="cell"]'))`
      const archiveRow = `${dataRows}.find(row => row.innerText.includes('已登记归档项目 / archive'))`
      assert.equal(
        await evaluate(client, `${dataRows}.length`),
        registered.registrations.length,
        '每条登记仅显示一行'
      )
      assert.deepEqual(
        await evaluate(
          client,
          `[...${table}.querySelectorAll('[role="columnheader"]')].map(cell => cell.textContent)`
        ),
        ['归属项目 / 启动项', '本地端口', '远程端口', '项目路径', '服务器', '操作']
      )
      const portAlignment = await evaluate(
        client,
        `['本地端口', '远程端口'].every(label => {
          const header = [...${table}.querySelectorAll('[role="columnheader"]')].find(cell => cell.textContent === label);
          const cell = [...${archiveRow}.querySelectorAll('[role="cell"]')].find(cell => cell.textContent.startsWith(label));
          const headerBox = header.getBoundingClientRect();
          const cellBox = cell.getBoundingClientRect();
          return Math.abs(headerBox.left - cellBox.left) < 1 && Math.abs(headerBox.right - cellBox.right) < 1;
        })`
      )
      assert.equal(portAlignment, true, '桌面端口列与表头对齐')
      assert.equal(
        await evaluate(
          client,
          `[...${archiveRow}.querySelectorAll('button')].filter(button => button.textContent.trim() === '移除登记').length`
        ),
        1,
        '一条记录仅保留一个移除登记按钮'
      )
      async function searchRegistrations(value) {
        await evaluate(
          client,
          `(() => {
            const input = document.querySelector('[aria-label="搜索登记"]');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
          })()`
        )
      }
      for (const query of ['43100', '11006', '已登记归档项目', 'archive']) {
        await searchRegistrations(query)
        await waitFor(client, `${dataRows}.length === 1`, '搜索整条登记', () => serverOutput)
        const matchedRow = await evaluate(client, `${dataRows}[0].innerText`)
        for (const value of ['archive', '43101', '43100', '11006', 'tunnel.example.test']) {
          assert.ok(matchedRow.includes(value), `搜索 ${query} 后仍展示 ${value}`)
        }
      }
      await searchRegistrations('TUNNEL.EXAMPLE.TEST')
      await waitFor(
        client,
        `${dataRows}.length === ${registered.registrations.length}`,
        '按服务器搜索整条登记',
        () => serverOutput
      )
      await searchRegistrations('不存在的登记')
      await waitFor(
        client,
        `document.body.innerText.includes('没有匹配的登记')`,
        '搜索空态',
        () => serverOutput
      )
      await searchRegistrations('')
      await waitFor(
        client,
        `${dataRows}.length === ${registered.registrations.length}`,
        '清空搜索恢复登记',
        () => serverOutput
      )
      captures.push([outputs.ports, await screenshot(client)])
      await setViewport(client, 390, 844, true)
      assert.equal(
        await evaluate(client, `document.documentElement.scrollWidth > innerWidth + 1`),
        false
      )
      await evaluate(
        client,
        `document.querySelector('[aria-label="搜索登记"]').scrollIntoView({ block: 'start' })`
      )
      const portLabels = await evaluate(
        client,
        `['本地端口', '远程端口'].map(label => {
          const element = [...${archiveRow}.querySelectorAll('span')].find(span => span.textContent === label);
          return Boolean(element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
        })`
      )
      assert.deepEqual(portLabels, [true, true], '窄屏仍显示两侧端口的标签')
      captures.push([outputs.portsMobile, await screenshot(client)])

      const removeArchive = `[...${archiveRow}.querySelectorAll('button')].find(button => button.textContent.trim() === '移除登记').click()`
      await evaluate(client, removeArchive)
      await waitFor(
        client,
        `document.body.innerText.includes('移除端口登记？')`,
        '登记移除确认',
        () => serverOutput
      )
      await clickText(client, '取消')
      assert.equal(
        await evaluate(client, `${dataRows}.length`),
        registered.registrations.length,
        '取消移除保留整条登记'
      )
      await evaluate(client, removeArchive)
      await waitFor(
        client,
        `document.body.innerText.includes('移除端口登记？')`,
        '再次确认移除',
        () => serverOutput
      )
      const confirmed = await evaluate(
        client,
        `(() => {
          const dialog = [...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')].find(element => element.textContent.includes('移除端口登记？'));
          const button = dialog && [...dialog.querySelectorAll('button')].find(element => element.textContent.trim() === '移除登记');
          if (!button) return false;
          button.click();
          return true;
        })()`
      )
      assert.equal(confirmed, true, '确认移除登记按钮可操作')
      await waitFor(
        client,
        `${dataRows}.length === ${registered.registrations.length - 1} && !${archiveRow}`,
        '整条登记移除完成',
        () => serverOutput
      )
      const afterRemoval = JSON.parse(
        await readFile(join(agentDir, 'pi-desk-remote-debug-ports.json'), 'utf8')
      )
      assert.equal(
        afterRemoval.registrations.some((item) => item.profile === 'archive'),
        false
      )
      assert.equal(
        await readFile(join(projectDir, '.pi', 'remote_debug.yaml'), 'utf8'),
        originalProjectConfig,
        '移除登记不改项目配置'
      )
    }
    await publishScreenshots(captures)
    for (const [path] of captures) console.log(`screenshot=${path}`)
    passed = true
  } catch (error) {
    await mkdir(testRoot, { recursive: true })
    await writeFile(join(testRoot, 'failure.txt'), `${error.stack ?? error}\n${serverOutput}`)
    if (client)
      await screenshot(client)
        .then((image) => writeFile(join(testRoot, 'failure.png'), image))
        .catch(() => undefined)
    throw error
  } finally {
    client?.close()
    await stopBrowserTree(browserProcess, cdpPort)
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    if (entryPort > 0) {
      await assertPortReleased(entryPort).catch((error) => {
        serverOutput += `\nentry-port-release-error=${error instanceof Error ? error.message : String(error)}`
        throw error
      })
    }
    for (const [index, key] of desktopEnvironmentKeys.entries()) {
      const value = originalDesktopEnvironment[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    await writeFile(join(testRoot, 'server.log'), serverOutput)
    if (passed) {
      await rm(agentRoot, { recursive: true, force: true })
      console.log(`验收运行完成，服务和浏览器端口已释放：${testRoot}`)
    }
  }
}

await main()
