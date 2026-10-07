import assert from 'node:assert/strict'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
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
  waitForHttp,
  waitForPortReleased
} from './l4-browser-cdp-runtime.mjs'
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const visualOutputRoot = process.env.PI_DESK_VISUAL_OUTPUT_ROOT
  ? resolve(process.env.PI_DESK_VISUAL_OUTPUT_ROOT)
  : projectRoot
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const testRoot = join(projectRoot, 'temp', 'pi', 'slash-command-visual', String(process.pid))
const browserProfileDir = join(tmpdir(), `pi-desk-slash-command-edge-${process.pid}`)
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, 'Slash Command 验收项目')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const workId = 'slash-command-visual-work-session'
const password = 'Qq.445566'
const longCommandDescription = '用于验证单行命令菜单描述截断的外部扩展文案。'.repeat(8)
const desktopDefaultOutput = join(
  visualOutputRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '输入框命令__分组默认.png'
)
const desktopSearchOutput = join(
  visualOutputRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '输入框命令__跨类型搜索.png'
)
const mobileDefaultOutput = join(
  visualOutputRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '输入框命令__分组默认.png'
)

let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''

async function createFixture() {
  const extensionDir = join(agentDir, 'extensions', 'slash-visual')
  const promptsDir = join(agentDir, 'prompts')
  const skillsDir = join(agentDir, 'skills')
  await Promise.all([
    mkdir(join(agentDir, 'sessions'), { recursive: true }),
    mkdir(dirname(workSessionStorePath), { recursive: true }),
    mkdir(extensionDir, { recursive: true }),
    mkdir(promptsDir, { recursive: true }),
    mkdir(projectDir, { recursive: true })
  ])

  await writeFile(
    join(extensionDir, 'index.ts'),
    `const commands = ${JSON.stringify([
      ['api-review', '检查接口契约与边界'],
      ['benchmark', '运行性能基准'],
      ['commit', '分析改动并生成提交信息'],
      ['context', '查看当前上下文摘要'],
      ['docs', longCommandDescription],
      ['inspect', '深入检查模块实现'],
      ['plan', '生成紧凑的实施计划'],
      ['verify', '执行交付前完整检查']
    ])}

export default function slashVisual(pi) {
  for (const [name, description] of commands) {
    pi.registerCommand(name, { description, async handler() {} })
  }
}
`,
    'utf8'
  )

  await Promise.all([
    writeFile(
      join(promptsDir, 'review.md'),
      `---
description: 审查当前代码改动
---

请审查当前代码改动。
`,
      'utf8'
    ),
    writeFile(
      join(promptsDir, 'release-check.md'),
      `---
description: 执行发布前检查
---

请执行发布前检查。
`,
      'utf8'
    ),
    writeFile(
      join(promptsDir, 'api-review.md'),
      `---
description: 该模板应被同名扩展命令遮蔽
---

该模板不应出现在候选中。
`,
      'utf8'
    )
  ])

  for (const [name, description] of [
    ['imagegen', '生成或编辑图片'],
    ['my-server', '执行服务器与部署操作'],
    ['tapd', '查询 TAPD 项目数据']
  ]) {
    const skillDir = join(skillsDir, name)
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: ${name}
description: ${description}
---

# ${name}
`,
      'utf8'
    )
  }

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '输入 / 查看当前会话可用的分组命令。' }],
    timestamp: Date.now()
  })
  manager.appendSessionInfo('命令分组验收')
  const sessionFile = manager.getSessionFile()
  const sessionHeader = manager.getHeader()
  assert.ok(sessionFile)
  assert.ok(sessionHeader)
  await mkdir(dirname(sessionFile), { recursive: true })
  await writeFile(
    sessionFile,
    `${[sessionHeader, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8'
  )
  await access(sessionFile)
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

async function setComposerText(client, text) {
  await evaluate(
    client,
    `(async () => {
      const textarea = document.querySelector('textarea[placeholder*="输入消息"]');
      if (!textarea) return false;
      textarea.focus();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, ${JSON.stringify(text)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      return true;
    })()`
  )
}

async function pressComposerKey(client, key, count = 1) {
  await evaluate(
    client,
    `(async () => {
      const textarea = document.querySelector('textarea[placeholder*="输入消息"]');
      if (!textarea) return false;
      for (let index = 0; index < ${count}; index += 1) {
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: ${JSON.stringify(key)}, bubbles: true, cancelable: true
        }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return true;
    })()`
  )
}

async function waitForCommandMenu(client, label) {
  await waitFor(
    client,
    `(() => {
      const menu = document.querySelector('#l2-workbench-slash-command-menu');
      return Boolean(menu) && menu.getAttribute('aria-busy') === 'false';
    })()`,
    label,
    () => serverOutput,
    30_000
  )
}

async function stopServer() {
  if (!serverRuntime) return
  try {
    await stopE2eServerTree(serverRuntime)
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error
    await waitForPortReleased(appPort)
  }
}

async function hideDevelopmentPortal(client) {
  await evaluate(
    client,
    `document.querySelectorAll('nextjs-portal').forEach((element) => { element.style.display = 'none' })`
  )
}

async function main() {
  let client
  try {
    await createFixture()
    appPort = await reservePort()
    do {
      cdpPort = await reservePort()
    } while (cdpPort === appPort)
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

    browserProcess = spawnEdge(edgePath, cdpPort, browserProfileDir)
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge CDP')
    client = await createCdpPage(cdpPort)
    await navigate(client, `http://127.0.0.1:${appPort}/login`)
    const login = await evaluate(
      client,
      `fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Pi-Desk-Client-Id': '629cc15f-34a1-48a2-bfa2-f752175ece84'
        },
        body: JSON.stringify({ password: ${JSON.stringify(password)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(login.ok, true, login.body?.msg)

    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await setViewport(client, 1440, 900, false)
    await waitFor(
      client,
      `document.readyState === 'complete' && document.body.children.length > 0`,
      '应用页面首次渲染',
      () => serverOutput,
      90_000
    )
    await waitFor(
      client,
      `document.body.innerText.includes('Slash Command 验收项目')`,
      '工作会话出现',
      () => serverOutput,
      60_000
    )
    await evaluate(
      client,
      `(() => {
        const target = [...document.querySelectorAll('button, [role="button"]')].find((element) => element.textContent?.includes('Slash Command 验收项目'));
        target?.click();
      })()`
    )
    await waitFor(
      client,
      `document.querySelector('textarea[placeholder*="输入消息"]') !== null`,
      'Composer 出现'
    )
    await hideDevelopmentPortal(client)

    await setComposerText(client, '/')
    await waitForCommandMenu(client, '完整命令候选加载')
    assert.deepEqual(
      await evaluate(
        client,
        `[...document.querySelectorAll('#l2-workbench-slash-command-menu [role="group"]')].map((group) => group.getAttribute('aria-label'))`
      ),
      ['Pi 内置命令', 'Skills', '提示模板', '扩展命令']
    )
    assert.equal(
      await evaluate(
        client,
        `document.querySelectorAll('#l2-workbench-slash-command-menu [role="option"]').length`
      ),
      14
    )
    assert.equal(
      await evaluate(
        client,
        `([...document.querySelectorAll('#l2-workbench-slash-command-menu [role="option"]')].some((option) => option.textContent?.includes('/reload')))`
      ),
      true,
      '内置 reload 命令应出现在候选中'
    )
    assert.equal(
      await evaluate(
        client,
        `(() => {
          const menu = document.querySelector('#l2-workbench-slash-command-menu');
          const viewport = menu?.firstElementChild;
          return Boolean(viewport && viewport.scrollHeight > viewport.clientHeight);
        })()`
      ),
      true
    )
    const desktopMenuMetrics = await evaluate(
      client,
      `(() => {
        const menu = document.querySelector('#l2-workbench-slash-command-menu');
        const composer = document.querySelector('textarea[placeholder*="输入消息"]')?.closest('form');
        const menuRect = menu?.getBoundingClientRect();
        const composerRect = composer?.getBoundingClientRect();
        return {
          matchesComposer: Boolean(
            menuRect &&
              composerRect &&
              Math.abs(menuRect.left - composerRect.left) <= 1 &&
              Math.abs(menuRect.width - composerRect.width) <= 1
          ),
          menuWidth: menuRect?.width ?? 0,
          composerWidth: composerRect?.width ?? 0
        };
      })()`
    )
    assert.equal(
      desktopMenuMetrics.matchesComposer,
      true,
      `桌面端命令菜单未与输入框对齐：${JSON.stringify(desktopMenuMetrics)}`
    )
    const truncatedDescription = await evaluate(
      client,
      `(() => {
        const option = [...document.querySelectorAll('#l2-workbench-slash-command-menu [role="option"]')].find((element) => element.textContent?.includes('/docs'));
        const description = option?.querySelectorAll('span')[2]?.textContent ?? '';
        return { description, length: Array.from(description).length };
      })()`
    )
    assert.equal(truncatedDescription.length, 80)
    assert.equal(truncatedDescription.description.endsWith('…'), true)
    assert.equal(
      await evaluate(
        client,
        `[...document.querySelectorAll('#l2-workbench-slash-command-menu [role="option"]')].filter((option) => option.textContent?.includes('/api-review')).length`
      ),
      1,
      '同名 Prompt 应由 Extension 遮蔽'
    )

    await pressComposerKey(client, 'ArrowDown', 10)
    assert.equal(
      (await evaluate(
        client,
        `document.querySelector('#l2-workbench-slash-command-menu').firstElementChild.scrollTop`
      )) > 0,
      true
    )

    await setComposerText(client, '/skill')
    await waitForCommandMenu(client, 'Skills 筛选')
    assert.deepEqual(
      await evaluate(
        client,
        `[...document.querySelectorAll('#l2-workbench-slash-command-menu [role="group"]')].map((group) => group.getAttribute('aria-label'))`
      ),
      ['Skills']
    )
    await pressComposerKey(client, 'ArrowDown')
    await pressComposerKey(client, 'Enter')
    assert.equal(
      await evaluate(client, `document.querySelector('textarea[placeholder*="输入消息"]').value`),
      '/skill:my-server '
    )

    await setComposerText(client, '/')
    await waitForCommandMenu(client, '桌面默认分组重新打开')
    await evaluate(
      client,
      `document.querySelector('#l2-workbench-slash-command-menu').firstElementChild.scrollTop = 0`
    )
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      '桌面默认分组动画完成'
    )
    const desktopDefault = await screenshot(client)

    await setComposerText(client, '/review')
    await waitForCommandMenu(client, '跨类型搜索')
    assert.deepEqual(
      await evaluate(
        client,
        `[...document.querySelectorAll('#l2-workbench-slash-command-menu [role="group"]')].map((group) => group.getAttribute('aria-label'))`
      ),
      ['提示模板', '扩展命令']
    )
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      '跨类型搜索动画完成'
    )
    const desktopSearch = await screenshot(client)
    await pressComposerKey(client, 'Enter')
    assert.equal(
      await evaluate(client, `document.querySelector('textarea[placeholder*="输入消息"]').value`),
      '/review '
    )

    await setComposerText(client, '')
    await evaluate(
      client,
      `document.querySelector('textarea[placeholder*="输入消息"]')?.closest('form')?.querySelector('[aria-label="更多操作"]')?.click()`
    )
    await waitFor(
      client,
      `document.querySelector('[data-slot="dropdown-menu-content"] [aria-label="重载 Pi 配置"]') !== null`,
      '三个点菜单中的 Pi 重载入口'
    )
    assert.equal(
      await evaluate(
        client,
        `(() => {
          const item = document.querySelector('[data-slot="dropdown-menu-content"] [aria-label="重载 Pi 配置"]');
          return item instanceof HTMLElement && item.getAttribute('data-disabled') === null;
        })()`
      ),
      true,
      '空闲会话的 Pi 重载入口应可用'
    )
    await evaluate(client, 'document.body.click()')

    await setViewport(client, 390, 844, true)
    await setComposerText(client, '/')
    await waitForCommandMenu(client, '移动端完整分组')
    const mobileMetrics = await evaluate(
      client,
      `(() => {
        const menu = document.querySelector('#l2-workbench-slash-command-menu');
        const option = menu?.querySelector('[role="option"]');
        const menuRect = menu?.getBoundingClientRect();
        const optionRect = option?.getBoundingClientRect();
        const style = option ? getComputedStyle(option) : null;
        return {
          withinViewport: Boolean(menuRect && menuRect.left >= 0 && menuRect.right <= innerWidth),
          matchesComposer: Boolean(
            menuRect &&
              document.querySelector('textarea[placeholder*="输入消息"]')?.closest('form') &&
              Math.abs(
                menuRect.left -
                  document
                    .querySelector('textarea[placeholder*="输入消息"]')
                    ?.closest('form')
                    ?.getBoundingClientRect().left
              ) <= 1 &&
              Math.abs(
                menuRect.width -
                  document
                    .querySelector('textarea[placeholder*="输入消息"]')
                    ?.closest('form')
                    ?.getBoundingClientRect().width
              ) <= 1
          ),
          optionHeight: optionRect?.height ?? 0,
          minHeight: style?.minHeight ?? null,
          lineHeight: style?.lineHeight ?? null,
          className: option?.className ?? null,
          innerWidth,
          devicePixelRatio
        };
      })()`
    )
    assert.equal(mobileMetrics.withinViewport, true)
    assert.equal(
      mobileMetrics.matchesComposer,
      true,
      `移动端命令菜单未与输入框对齐：${JSON.stringify(mobileMetrics)}`
    )
    assert.ok(
      mobileMetrics.optionHeight >= 44,
      `移动端候选行高不足：${JSON.stringify(mobileMetrics)}`
    )
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      '移动端分组动画完成'
    )
    const mobileDefault = await screenshot(client)

    await publishScreenshots([
      [desktopDefaultOutput, desktopDefault],
      [desktopSearchOutput, desktopSearch],
      [mobileDefaultOutput, mobileDefault]
    ])
    console.log(`desktopDefault=${desktopDefaultOutput}`)
    console.log(`desktopSearch=${desktopSearchOutput}`)
    console.log(`mobileDefault=${mobileDefaultOutput}`)
  } finally {
    client?.close()
    await stopBrowserTree(browserProcess, cdpPort)
    await stopServer()
    await rm(browserProfileDir, { recursive: true, force: true })
    await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
