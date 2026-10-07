import assert from 'node:assert/strict'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
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
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const legacyRunId = `${Date.now()}-${process.pid}`
const legacyRoot = join(
  projectRoot,
  'temp',
  'run',
  'project-tree',
  `legacy-closeout-file-${legacyRunId}`
)
const progressPath = join(legacyRoot, 'progress.log')
const testRoot = join(
  projectRoot,
  'temp',
  'pi',
  'file-workspace-interaction-e2e',
  String(process.pid)
)
const agentDir = join(testRoot, 'agent')
const failureRoot = join(legacyRoot, 'failure')
const primaryProjectDir = join(testRoot, '主会话项目')
const focusedProjectDir = join(testRoot, '固定会话项目')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const outputRoot = join(legacyRoot, 'screenshots')
const desktopOutput = join(outputRoot, '客户端_桌面', '代码查看器__固定会话交互.png')
const desktopContextMenuOutput = join(outputRoot, '客户端_桌面', '项目文件__右键菜单.png')
const desktopTabsOutput = join(outputRoot, '客户端_桌面', '代码查看器__多行标签批量菜单.png')
const desktopExpandedOutput = join(outputRoot, '客户端_桌面', '代码查看器__放大目录正文.png')
const desktopResizeOutput = join(outputRoot, '客户端_桌面', '代码查看器__会话内宽度调整.png')
const mobileOutput = join(outputRoot, '客户端_移动端', '代码查看器__全屏预览.png')
const mobileTabsSidebarOutput = join(
  outputRoot,
  '客户端_移动端',
  '代码查看器__顶部标签统一侧栏.png'
)
const mobileContextMenuOutput = join(outputRoot, '客户端_移动端', '项目文件__长按菜单.png')
const primaryWorkId = 'file-workspace-primary'
const focusedWorkId = 'file-workspace-focused'
const multiTabPaths = Array.from(
  { length: 16 },
  (_, index) => `src/tab-preview-long-name-${String(index + 1).padStart(2, '0')}.ts`
)
const mobileTabPaths = Array.from(
  { length: 3 },
  (_, index) => `src/mobile-tab-preview-${String(index + 1).padStart(2, '0')}.ts`
)
const password = 'Qq.445566'
let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''
let primarySessionId = ''
let focusedSessionId = ''

async function progress(label) {
  const line = `${new Date().toISOString()} pid=${process.pid} ${label}\n`
  console.log(`[file-workspace-e2e] ${line.trim()}`)
  await mkdir(legacyRoot, { recursive: true })
  await appendFile(progressPath, line, 'utf8')
}

function withTimeout(promise, label, timeoutMs = 30_000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function assistant(text, timestamp) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 }
    },
    stopReason: 'stop',
    timestamp
  }
}

async function createFixture() {
  process.env.TSX_TSCONFIG_PATH = join(projectRoot, 'tsconfig.json')
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(dirname(workSessionStorePath), { recursive: true })
  await mkdir(join(primaryProjectDir, 'src'), { recursive: true })
  await mkdir(join(focusedProjectDir, 'src'), { recursive: true })
  await writeFile(join(primaryProjectDir, 'src', 'primary.ts'), 'export const primary = true\n')
  for (const [index, path] of mobileTabPaths.entries()) {
    await writeFile(
      join(primaryProjectDir, path.replaceAll('/', '\\')),
      `export const mobilePreview${index + 1} = '手机多行标签验收文件 ${index + 1}'\n`,
      'utf8'
    )
  }
  await writeFile(
    join(focusedProjectDir, 'src', 'active-preview.ts'),
    `export const selectionToken = '保持固定会话内的代码交互'\n
export function preview(): string {
  return selectionToken
}

${Array.from({ length: 80 }, (_, index) => `// readingLine${index + 1} = ${index + 1}`).join('\n')}
`,
    'utf8'
  )
  await writeFile(
    join(focusedProjectDir, 'src', 'iframe-preview.html'),
    `<!doctype html>
<html lang="zh-CN">
  <body>
    <main id="preview">iframe 拖动目标</main>
    <script>
      document.body.dataset.scriptRan = 'true'
    </script>
  </body>
</html>
`,
    'utf8'
  )
  for (const [index, path] of multiTabPaths.entries()) {
    await writeFile(
      join(focusedProjectDir, path.replaceAll('/', '\\')),
      `export const tabPreview${index + 1} = '多行标签验收文件 ${index + 1}'\n`,
      'utf8'
    )
  }

  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const timestamp = Date.now()
  const primary = SessionManager.create(primaryProjectDir)
  primary.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '这是第一列主会话。' }],
    timestamp
  })
  primary.appendMessage(assistant('主会话保持在第一列。', timestamp + 1))
  primarySessionId = primary.getSessionId()

  const focused = SessionManager.create(focusedProjectDir)
  focused.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '这是当前操作的固定会话。' }],
    timestamp
  })
  focused.appendMessage(assistant('固定会话中的代码查看器必须保持可操作。', timestamp + 1))
  focusedSessionId = focused.getSessionId()

  await writeFile(
    workSessionStorePath,
    `${JSON.stringify(
      {
        workSessions: [
          { workId: focusedWorkId, cwd: focusedProjectDir, sessionId: focusedSessionId },
          { workId: primaryWorkId, cwd: primaryProjectDir, sessionId: primarySessionId }
        ],
        pinnedCount: 1
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

async function loginAndPrepare(client) {
  await navigate(client, `http://127.0.0.1:${appPort}/login`)
  const login = await evaluate(
    client,
    `fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Pi-Desk-Client-Id': 'c3d66b93-f448-4f4a-8851-7451d2bb4b48'
      },
      body: JSON.stringify({ password: ${JSON.stringify(password)} })
    }).then(async (response) => ({ ok: response.ok, body: await response.json() }))`
  )
  assert.equal(login.ok, true, login.body?.msg)
  await evaluate(
    client,
    `localStorage.setItem('pi-desk:workbench-layout', JSON.stringify({ primaryWorkId: ${JSON.stringify(primaryWorkId)} }));
     localStorage.removeItem('pi-desk:file-window-position')`
  )
}

async function activateWorkSession(client, workId, label) {
  const activated = await evaluate(
    client,
    `(() => {
      const target = document.querySelector('[data-work-id=${JSON.stringify(workId)}] textarea');
      if (!(target instanceof HTMLElement)) return false;
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      target.focus();
      return true;
    })()`
  )
  assert.equal(activated, true, `未找到${label}输入框`)
  await waitFor(
    client,
    `document.querySelector('[data-work-id=${JSON.stringify(workId)}] footer[data-composer-active="true"]') !== null`,
    `${label}成为当前活跃会话`,
    () => serverOutput
  )
}

async function activateFixedWorkSession(client) {
  await activateWorkSession(client, focusedWorkId, '固定会话')
}

async function openFocusedFile(client) {
  const filesOpened = await evaluate(
    client,
    `(() => {
      const button = document.querySelector('[aria-label="显示项目文件"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(filesOpened, true, '未找到项目文件入口')
  await waitFor(
    client,
    `document.querySelector('[data-testid="project-folder-src"]') !== null`,
    '固定会话项目目录加载',
    () => serverOutput,
    60_000
  )
  await ensureFolderExpanded(client, '[data-testid="project-folder-src"]', '固定会话 src 目录')
  await waitFor(
    client,
    `document.querySelector('[data-testid="project-file-src/active-preview.ts"]') !== null`,
    '固定会话项目文件加载',
    () => serverOutput,
    60_000
  )
  const opened = await evaluate(
    client,
    `(() => {
      const target = document.querySelector('[data-testid="project-file-src/active-preview.ts"]');
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    })()`
  )
  assert.equal(opened, true, '未找到固定会话测试文件')
  await waitFor(
    client,
    `document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"] .monaco-editor .view-lines') !== null`,
    '固定会话代码查看器加载',
    () => serverOutput,
    60_000
  )
  await waitFor(
    client,
    `(() => {
      const fixed = document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"]');
      const primary = document.querySelector('[data-work-id=${JSON.stringify(primaryWorkId)}] [data-testid="file-workspace"]');
      return Boolean(fixed?.querySelector('.monaco-editor .view-lines')?.textContent?.includes('selectionToken')) && primary === null;
    })()`,
    '代码查看器归属固定活跃会话',
    () => serverOutput,
    60_000
  )
}

async function openProjectContextMenu(client, targetTestId, inputType, expectedText) {
  const target = await evaluate(
    client,
    `(() => {
      const scope = document.querySelector('[data-slot="app-dialog-content"]') ?? document;
      const element = [...scope.querySelectorAll('[data-testid=${JSON.stringify(targetTestId)}]')].find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
      });
      if (!(element instanceof HTMLElement)) return null;
      const target = element.querySelector('button') ?? element;
      if (!(target instanceof HTMLElement)) return null;
      const rect = target.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  )
  assert.ok(target, `未找到项目路径菜单触发项：${targetTestId}`)

  if (inputType === 'touch') {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: target.x, y: target.y, radiusX: 2, radiusY: 2, force: 1, id: 0 }]
    })
    await waitFor(
      client,
      `(() => {
        const menu = document.querySelector('[role="menu"]');
        return menu?.textContent?.includes(${JSON.stringify(expectedText)}) === true && !menu.hasAttribute('data-starting-style');
      })()`,
      '长按打开项目路径菜单',
      () => serverOutput
    )
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await waitFor(
      client,
      `(() => {
        const menu = document.querySelector('[role="menu"]');
        return menu !== null && !menu.hasAttribute('data-starting-style') && !menu.hasAttribute('data-ending-style');
      })()`,
      '长按菜单保持打开',
      () => serverOutput
    )
    return
  }

  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: target.x,
    y: target.y,
    button: 'right',
    clickCount: 1
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: target.x,
    y: target.y,
    button: 'right',
    clickCount: 1
  })
  await waitFor(
    client,
    `document.querySelector('[role="menu"]')?.textContent?.includes(${JSON.stringify(expectedText)}) === true`,
    '右键打开项目路径菜单',
    () => serverOutput
  )
}

async function assertWorkspaceInteraction(client) {
  const line = await evaluate(
    client,
    `(() => {
      const element = document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"] .monaco-editor .view-line');
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + 60, y: rect.top + rect.height / 2 };
    })()`
  )
  assert.ok(line, 'Monaco 代码行未渲染')
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: line.x,
    y: line.y,
    button: 'left',
    clickCount: 1
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: line.x,
    y: line.y,
    button: 'left',
    clickCount: 1
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2
  })

  const copied = await evaluate(
    client,
    `(() => {
      const workspace = document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"]');
      const button = workspace?.querySelector('[aria-label="复制选中内容或全部"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(copied, true, '未找到代码复制操作')
  await waitFor(
    client,
    `document.body.innerText.includes('已复制选中代码。') || document.body.innerText.includes('已复制全部代码。')`,
    '复制代码反馈',
    () => serverOutput
  )

  const searchOpened = await evaluate(
    client,
    `(() => {
      const workspace = document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"]');
      const button = workspace?.querySelector('[aria-label="在文件中查找"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(searchOpened, true, '未找到代码搜索操作')
  await waitFor(
    client,
    `(() => {
      const workspace = document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"]');
      const widget = workspace?.querySelector('.monaco-editor .find-widget');
      return widget instanceof HTMLElement && widget.getBoundingClientRect().width > 0 && widget.textContent?.includes('1 of 1');
    })()`,
    '代码搜索输入框聚焦',
    () => serverOutput
  )

  const retained = await evaluate(
    client,
    `(() => {
      const widget = document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"] .monaco-editor .find-widget');
      widget?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      const fixed = document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"]');
      const primary = document.querySelector('[data-work-id=${JSON.stringify(primaryWorkId)}] [data-testid="file-workspace"]');
      return fixed !== null && primary === null;
    })()`
  )
  assert.equal(retained, true, '操作代码搜索后不应切回第一列会话')
  const searchFocused = await evaluate(
    client,
    `(() => {
      const input = document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"] .monaco-editor .find-widget textarea');
      if (!(input instanceof HTMLElement)) return false;
      input.focus();
      return document.activeElement === input;
    })()`
  )
  assert.equal(searchFocused, true, '搜索输入框未获得焦点')
  await dispatchEscape(client)
  await waitFor(
    client,
    `(() => {
      const widget = document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"] .monaco-editor .find-widget');
      return widget === null || widget.getAttribute('aria-hidden') === 'true' || widget.getBoundingClientRect().width === 0;
    })()`,
    'Esc优先关闭Monaco搜索',
    () => serverOutput
  )
  await dispatchEscape(client)
  await waitFor(
    client,
    `(() => {
      const file = document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"]');
      const hidden = file?.closest('[inert]');
      return file !== null && hidden?.getAttribute('aria-hidden') === 'true';
    })()`,
    '第二层Esc收起文件面板',
    () => serverOutput
  )
  await click(client, `[data-work-id="${focusedWorkId}"] [data-testid="session-files-entry"]`)
  await waitFor(
    client,
    `(() => {
      const file = document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] [data-testid="file-workspace"]');
      return file !== null && file.closest('[inert]') === null;
    })()`,
    '会话文件入口恢复面板',
    () => serverOutput
  )
}

async function acceptanceScreenshot(client) {
  await evaluate(client, 'window.__piDeskHideNextDevIndicator?.()')
  return withTimeout(screenshot(client), '文件旧E2E截图', 30_000)
}

async function click(client, selector) {
  assert.equal(
    await evaluate(
      client,
      `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`
    ),
    true,
    `找不到操作：${selector}`
  )
}

async function ensureFolderExpanded(client, selector, label) {
  const expanded = await evaluate(
    client,
    `(() => {
      const folder = document.querySelector(${JSON.stringify(selector)});
      const trigger = folder?.querySelector('button');
      if (!(trigger instanceof HTMLElement)) return false;
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
      return true;
    })()`
  )
  assert.equal(expanded, true, `未找到${label}`)
}

async function openManyFiles(client, paths) {
  for (const path of paths) {
    const projectFileSelector = `[data-testid="project-file-${path}"]`
    const fileTabSelector = `[data-testid="file-tab-${path}"]`
    await waitFor(
      client,
      `document.querySelector(${JSON.stringify(projectFileSelector)}) !== null`,
      `多行标签文件加载：${path}`,
      () => serverOutput
    )
    await click(client, projectFileSelector)
    await waitFor(
      client,
      `document.querySelector(${JSON.stringify(fileTabSelector)}) !== null`,
      `多行标签打开：${path}`,
      () => serverOutput
    )
  }
}

async function openFileTabContextMenu(client, path, inputType = 'mouse') {
  const target = await evaluate(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(`[data-testid="file-tab-${path}"]`)});
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  )
  assert.ok(target, `未找到文件标签：${path}`)

  if (inputType === 'touch') {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: target.x, y: target.y, radiusX: 2, radiusY: 2, force: 1, id: 0 }]
    })
    await waitFor(
      client,
      `document.querySelector('[role="menu"]')?.textContent?.includes('关闭标签') === true`,
      '长按打开文件标签菜单',
      () => serverOutput
    )
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    return
  }

  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: target.x,
    y: target.y,
    button: 'right',
    clickCount: 1
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: target.x,
    y: target.y,
    button: 'right',
    clickCount: 1
  })
  await waitFor(
    client,
    `document.querySelector('[role="menu"]')?.textContent?.includes('关闭标签') === true`,
    '右键打开文件标签菜单',
    () => serverOutput
  )
}

async function clickMenuItem(client, text) {
  const clicked = await evaluate(
    client,
    `(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent?.trim() === ${JSON.stringify(text)} && element.getAttribute('aria-disabled') !== 'true');
      if (!(item instanceof HTMLElement)) return false;
      item.click();
      return true;
    })()`
  )
  assert.equal(clicked, true, `未找到菜单项：${text}`)
}

async function dispatchEscape(client) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
}

async function dispatchControlTab(client, shift = false) {
  const result = await evaluate(
    client,
    `(() => {
      const target = document.activeElement?.closest('[data-testid="session-file-layout"]') ?? document.querySelector('[data-testid="session-file-layout"]');
      if (!(target instanceof HTMLElement)) return null;
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        code: 'Tab',
        ctrlKey: true,
        shiftKey: ${shift},
        bubbles: true,
        cancelable: true
      });
      target.dispatchEvent(event);
      return { dispatched: true, defaultPrevented: event.defaultPrevented };
    })()`
  )
  assert.equal(result?.dispatched, true, '未找到文件布局键盘宿主')
  assert.equal(result.defaultPrevented, true, '宿主未消费Ctrl+Tab事件')
}

async function openFileTabKeyboardContextMenu(client, path) {
  const focused = await evaluate(
    client,
    `(() => {
      const button = document.querySelector(${JSON.stringify(`[data-testid="file-tab-${path}"] [role="tab"]`)});
      if (!(button instanceof HTMLElement)) return false;
      button.focus();
      return document.activeElement === button;
    })()`
  )
  assert.equal(focused, true, `未找到文件标签键盘目标：${path}`)
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'F10',
    code: 'F10',
    modifiers: 8,
    windowsVirtualKeyCode: 121,
    nativeVirtualKeyCode: 121
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'F10',
    code: 'F10',
    modifiers: 8,
    windowsVirtualKeyCode: 121,
    nativeVirtualKeyCode: 121
  })
  await waitFor(
    client,
    `document.querySelector('[role="menu"]')?.textContent?.includes('关闭标签') === true`,
    'Shift+F10打开文件标签菜单',
    () => serverOutput
  )
}

async function readSessionSplitMetrics(client, workId) {
  const layoutSelector = `[data-work-id="${workId}"] [data-testid="session-file-layout"]`
  const chatPanelSelector = `[data-testid="session-chat-pane-${workId}"]`
  const filePanelSelector = `[data-testid="session-file-pane-${workId}"]`
  const dividerSelector = `#session-file-divider-${workId}`
  return evaluate(
    client,
    `(() => {
      const layout = document.querySelector(${JSON.stringify(layoutSelector)});
      const group = layout?.querySelector('[data-slot="resizable-panel-group"]');
      const chat = layout?.querySelector(${JSON.stringify(chatPanelSelector)});
      const file = layout?.querySelector(${JSON.stringify(filePanelSelector)});
      const divider = layout?.querySelector(${JSON.stringify(dividerSelector)});
      const column = document.querySelector('[data-work-id="${workId}"]');
      if (!(layout instanceof HTMLElement) || !(group instanceof HTMLElement) || !(chat instanceof HTMLElement) || !(file instanceof HTMLElement) || !(divider instanceof HTMLElement) || !(column instanceof HTMLElement)) return null;
      const rect = (element) => {
        const value = element.getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
      };
      return {
        fileLayout: layout.getAttribute('data-file-layout'),
        groupDisabled: group.getAttribute('data-disabled') === 'true' || group.getAttribute('aria-disabled') === 'true',
        column: rect(column),
        chat: rect(chat),
        file: rect(file),
        divider: {
          rect: rect(divider),
          display: getComputedStyle(divider).display,
          hidden: divider.getAttribute('aria-hidden') === 'true',
          disabled: divider.getAttribute('aria-disabled') === 'true',
          tabIndex: divider.getAttribute('tabindex'),
          valueNow: divider.getAttribute('aria-valuenow')
        },
        chatTextArea: layout.querySelector('textarea') !== null,
        fileWorkspace: layout.querySelector('[data-testid="file-workspace"]') !== null,
        editor: layout.querySelector('.monaco-editor') !== null,
        iframe: layout.querySelector('iframe') !== null
      };
    })()`
  )
}

async function dragDivider(client, workId, delta, ySelector = null) {
  const dividerSelector = `#session-file-divider-${workId}`
  const start = await evaluate(
    client,
    `(() => {
      const divider = document.querySelector(${JSON.stringify(dividerSelector)});
      const yTarget = ${ySelector ? `document.querySelector(${JSON.stringify(ySelector)})` : 'null'};
      if (!(divider instanceof HTMLElement)) return null;
      const dividerRect = divider.getBoundingClientRect();
      const targetRect = yTarget instanceof HTMLElement ? yTarget.getBoundingClientRect() : dividerRect;
      if (dividerRect.width <= 0 || dividerRect.height <= 0 || divider.getAttribute('aria-hidden') === 'true' || divider.getAttribute('aria-disabled') === 'true') return null;
      return { x: dividerRect.left + dividerRect.width / 2, y: targetRect.top + targetRect.height / 2 };
    })()`
  )
  assert.ok(start, `分隔线不可拖动：${workId}`)
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: start.x,
    y: start.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  for (const ratio of [0.01, 0.35, 0.7, 1]) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x + delta * ratio,
      y: start.y,
      button: 'left',
      buttons: 1
    })
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: start.x + delta,
    y: start.y,
    button: 'left',
    buttons: 0
  })
}

async function pressDividerKey(client, workId, key) {
  const dividerSelector = `#session-file-divider-${workId}`
  const focused = await evaluate(
    client,
    `(() => {
      const divider = document.querySelector(${JSON.stringify(dividerSelector)});
      if (!(divider instanceof HTMLElement) || divider.getAttribute('aria-disabled') === 'true') return false;
      divider.focus();
      return document.activeElement === divider;
    })()`
  )
  assert.equal(focused, true, `分隔线未获得键盘焦点：${key}`)
  const virtualKeyCodes = { ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35 }
  const virtualKeyCode = virtualKeyCodes[key]
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code: key,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: key,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  })
}

async function main() {
  let client
  let desktopCapture
  let desktopContextMenuCapture
  let desktopTabsCapture
  let desktopExpandedCapture
  let desktopResizeCapture
  let mobileCapture
  let mobileTabsSidebarCapture
  let mobileContextMenuCapture
  try {
    await progress('开始')
    await createFixture()
    await progress('fixture完成')
    appPort = await reservePort()
    cdpPort = await reservePort()
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
    await progress(`服务就绪 appPort=${appPort}`)
    browserProcess = spawnEdge(edgePath, cdpPort, join(testRoot, 'edge-profile'), '1440,900')
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge CDP')
    client = await createCdpPage(cdpPort)
    await progress(`浏览器就绪 cdpPort=${cdpPort}`)
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await client.send('Page.bringToFront')
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__piDeskE2eErrors = [];
        window.__piDeskRequests = [];
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const input = args[0];
          const requestUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
          const response = await originalFetch(...args);
          window.__piDeskRequests.push({ path: new URL(requestUrl, location.href).pathname, ok: response.ok });
          return response;
        };
        const describeError = (value) => {
          if (value instanceof ErrorEvent) {
            return {
              type: 'ErrorEvent',
              message: value.message,
              filename: value.filename,
              line: value.lineno,
              column: value.colno,
              error: String(value.error ?? ''),
              target: value.target instanceof HTMLScriptElement ? value.target.src : ''
            };
          }
          if (value instanceof Error) {
            return { type: value.name, message: value.message, stack: value.stack ?? '' };
          }
          return { type: typeof value, message: String(value) };
        };
        window.addEventListener('error', (event) => window.__piDeskE2eErrors.push(describeError(event)));
        window.addEventListener('unhandledrejection', (event) => window.__piDeskE2eErrors.push(describeError(event.reason)));
        (() => {
          const hideNextDevIndicator = () => {
            for (const portal of document.querySelectorAll('nextjs-portal')) {
              const shadow = portal.shadowRoot;
              if (!shadow?.querySelector('[data-next-mark]')) continue;
              portal.style.setProperty('display', 'none', 'important');
              if (shadow.querySelector('style[data-pi-desk-e2e-hide-next-indicator]')) continue;
              const style = document.createElement('style');
              style.setAttribute('data-pi-desk-e2e-hide-next-indicator', '');
              style.textContent = ':host { display: none !important; }';
              shadow.append(style);
            }
          };
          window.__piDeskHideNextDevIndicator = hideNextDevIndicator;
          const observer = new MutationObserver(hideNextDevIndicator);
          const observe = () => {
            if (!document.documentElement) return;
            observer.observe(document.documentElement, { childList: true, subtree: true });
            hideNextDevIndicator();
          };
          observe();
        })();
      `
    })
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    await setViewport(client, 1440, 900, false)
    await loginAndPrepare(client)
    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitFor(
      client,
      `document.querySelector('[data-work-id=${JSON.stringify(primaryWorkId)}] textarea') !== null && document.querySelector('[data-work-id=${JSON.stringify(focusedWorkId)}] textarea') !== null`,
      '双会话工作台加载',
      () => serverOutput,
      60_000
    )
    await progress('工作台加载完成')
    await activateFixedWorkSession(client)
    await openFocusedFile(client)
    await openManyFiles(client, multiTabPaths)
    await waitFor(
      client,
      `(() => {
        const tabs = document.querySelector('[data-testid="file-tabs"]');
        const tablist = tabs?.querySelector('[role="tablist"]');
        if (!(tabs instanceof HTMLElement) || !(tablist instanceof HTMLElement)) return false;
        const rows = new Set(
          [...tabs.querySelectorAll('[data-file-tab]')].map((item) => item.getBoundingClientRect().top)
        );
        return rows.size >= 4;
      })()`,
      '桌面多行文件标签展开',
      () => serverOutput
    )
    const tabsLayout = await evaluate(
      client,
      `(() => {
        const tabs = document.querySelector('[data-testid="file-tabs"]');
        const tablist = tabs?.querySelector('[role="tablist"]');
        const active = tabs?.querySelector('[aria-selected="true"]')?.closest('[data-file-tab]');
        if (!(tabs instanceof HTMLElement) || !(tablist instanceof HTMLElement)) return null;
        const rows = new Set(
          [...tabs.querySelectorAll('[data-file-tab]')].map((item) => item.getBoundingClientRect().top)
        );
        return {
          order: [...tabs.querySelectorAll('[data-file-tab]')].map((item) => item.getAttribute('data-testid')),
          rowCount: rows.size,
          horizontalScroll: tablist.scrollWidth > tablist.clientWidth,
          activeHidden: active?.getAttribute('aria-hidden') === 'true',
          activeInert: active?.hasAttribute('inert') === true,
          expandControl: tabs.querySelector('[aria-expanded]')?.getAttribute('aria-expanded') ?? null
        };
      })()`
    )
    assert.ok(tabsLayout)
    assert.ok(tabsLayout.rowCount >= 4, JSON.stringify(tabsLayout))
    assert.equal(tabsLayout.horizontalScroll, false, JSON.stringify(tabsLayout))
    assert.equal(tabsLayout.activeHidden, false, JSON.stringify(tabsLayout))
    assert.equal(tabsLayout.activeInert, false, JSON.stringify(tabsLayout))
    const tabsOrderBeforeMenu = tabsLayout.order
    await openFileTabContextMenu(client, multiTabPaths[7])
    const tabsMenuState = await evaluate(
      client,
      `(() => {
        const tabs = document.querySelector('[data-testid="file-tabs"]');
        return {
          order: [...(tabs?.querySelectorAll('[data-file-tab]') ?? [])].map((item) => item.getAttribute('data-testid')),
          texts: [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()),
          active: tabs?.querySelector('[aria-selected="true"]')?.closest('[data-file-tab]')?.getAttribute('data-testid') ?? null
        };
      })()`
    )
    assert.deepEqual(tabsMenuState.order, tabsOrderBeforeMenu)
    assert.deepEqual(tabsMenuState.texts, [
      '关闭标签',
      '关闭其他标签',
      '关闭右侧标签',
      '关闭左侧标签',
      '关闭全部标签'
    ])
    assert.equal(tabsMenuState.active, tabsOrderBeforeMenu.at(-1))
    desktopTabsCapture = await acceptanceScreenshot(client)
    await clickMenuItem(client, '关闭右侧标签')
    const expectedAfterRight = [
      'file-tab-src/active-preview.ts',
      ...multiTabPaths.slice(0, 8).map((path) => `file-tab-${path}`)
    ]
    await waitFor(
      client,
      `(() => {
        const actual = [...document.querySelectorAll('[data-testid="file-tabs"] [data-file-tab]')].map((item) => item.getAttribute('data-testid'));
        return JSON.stringify(actual) === ${JSON.stringify(JSON.stringify(expectedAfterRight))};
      })()`,
      '关闭右侧标签保持左侧逻辑顺序',
      () => serverOutput
    )
    await openFileTabKeyboardContextMenu(client, multiTabPaths[0])
    assert.equal(
      await evaluate(
        client,
        `document.querySelector('[data-testid="file-tabs"] [aria-selected="true"]')?.closest('[data-file-tab]')?.getAttribute('data-testid') === ${JSON.stringify(`file-tab-${multiTabPaths[7]}`)}`
      ),
      true,
      'Shift+F10打开菜单不切换当前文件'
    )
    await dispatchEscape(client)
    await waitFor(
      client,
      `document.querySelector('[role="menu"]') === null`,
      '关闭标签键盘菜单',
      () => serverOutput
    )
    await click(client, '[data-testid="file-tab-src/active-preview.ts"] [role="tab"]')
    await waitFor(
      client,
      `document.querySelector('[data-testid="file-tab-src/active-preview.ts"] [aria-selected="true"]') !== null`,
      '恢复固定会话主文件标签',
      () => serverOutput
    )
    await openProjectContextMenu(client, 'project-folder-src', 'mouse', '复制绝对路径')
    const folderMenuTexts = await evaluate(
      client,
      `(() => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()))()`
    )
    assert.deepEqual(folderMenuTexts, [
      '收起',
      '打开此文件夹',
      '复制绝对路径',
      '复制相对路径',
      '复制目录名'
    ])
    await dispatchEscape(client)
    await waitFor(
      client,
      `document.querySelector('[role="menu"]') === null`,
      '关闭项目目录菜单',
      () => serverOutput
    )
    await openProjectContextMenu(
      client,
      'project-file-src/active-preview.ts',
      'mouse',
      '打开所在文件夹'
    )
    const desktopMenuState = await evaluate(
      client,
      `(() => {
        const items = [...document.querySelectorAll('[role="menuitem"]')];
        return {
          texts: items.map((item) => item.textContent?.trim()),
          heights: items.map((item) => item.getBoundingClientRect().height),
          hitAreas: items.map((item) => ({ width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height, focusable: item instanceof HTMLElement }))
        };
      })()`
    )
    assert.deepEqual(desktopMenuState.texts, [
      '打开预览',
      '打开所在文件夹',
      '复制绝对路径',
      '复制相对路径',
      '复制文件名'
    ])
    assert.ok(
      desktopMenuState.heights.every((height) => height >= 28),
      `项目文件菜单单行高度不足：${JSON.stringify(desktopMenuState.heights)}`
    )
    assert.ok(
      desktopMenuState.hitAreas.every(
        (item) => item.width >= 24 && item.height >= 24 && item.focusable
      ),
      `项目文件菜单命中区不可用：${JSON.stringify(desktopMenuState.hitAreas)}`
    )
    desktopContextMenuCapture = await acceptanceScreenshot(client)
    assert.equal(
      await evaluate(
        client,
        `(() => { const item = document.querySelector('[role="menuitem"]'); if (!(item instanceof HTMLElement)) return false; item.focus(); return document.activeElement === item; })()`
      ),
      true,
      '项目菜单键盘焦点不可达'
    )
    const copiedAddress = await evaluate(
      client,
      `(() => {
        const item = document.querySelector('[data-testid="project-file-copy-address-src/active-preview.ts"]');
        if (!(item instanceof HTMLElement)) return false;
        item.click();
        return true;
      })()`
    )
    assert.equal(copiedAddress, true, '未找到复制文件地址操作')
    await waitFor(
      client,
      `document.body.innerText.includes('已复制。')`,
      '复制文件地址反馈',
      () => serverOutput
    )
    const browserErrors = await evaluate(
      client,
      `new Promise((resolve) => setTimeout(() => resolve(window.__piDeskE2eErrors ?? []), 500))`
    )
    assert.deepEqual(browserErrors, [], `Monaco 浏览器异常：${JSON.stringify(browserErrors)}`)
    await assertWorkspaceInteraction(client)
    await evaluate(
      client,
      `document.querySelectorAll('[aria-label="关闭提示"]').forEach(button => button.click()); window.__piDeskHideNextDevIndicator?.()`
    )
    await waitFor(
      client,
      `document.querySelector('[data-pi-desk-toast]') === null`,
      '关闭已完成复制提示',
      () => serverOutput
    )
    desktopCapture = await acceptanceScreenshot(client)

    const primaryColumn = `[data-work-id="${primaryWorkId}"]`
    const focusedColumn = `[data-work-id="${focusedWorkId}"]`
    await activateWorkSession(client, primaryWorkId, '主会话')
    await click(client, '[aria-label="显示项目文件"]')
    await waitFor(
      client,
      `document.querySelector('[data-testid="project-folder-src"] button') !== null`,
      '主会话项目目录加载',
      () => serverOutput
    )
    await ensureFolderExpanded(client, '[data-testid="project-folder-src"]', '主会话 src 目录')
    await waitFor(
      client,
      `document.querySelector('[data-testid="project-file-src/primary.ts"]') !== null`,
      '主会话文件加载',
      () => serverOutput
    )
    await click(client, '[data-testid="project-file-src/primary.ts"]')
    await openManyFiles(client, mobileTabPaths)
    await click(client, `${primaryColumn} [data-testid="file-tab-src/primary.ts"] [role="tab"]`)
    await waitFor(
      client,
      `document.querySelector('${primaryColumn} [data-testid="file-workspace"]')?.textContent.replaceAll('\u00a0', ' ').includes('export const primary') && document.querySelector('${focusedColumn} [data-testid="file-workspace"]') !== null`,
      '两个会话的文件同时保留',
      () => serverOutput
    )
    await evaluate(
      client,
      `(() => {
        window.__focusedFileWorkspaceBeforeHide = document.querySelector('${focusedColumn} [data-testid="file-workspace"]');
        return true;
      })()`
    )
    await click(
      client,
      `${focusedColumn} [aria-label="收起文件"], ${focusedColumn} [aria-label="返回聊天"]`
    )
    await waitFor(
      client,
      `(() => {
        const focused = document.querySelector('${focusedColumn} [data-testid="file-workspace"]');
        const primary = document.querySelector('${primaryColumn} [data-testid="file-workspace"]');
        const hidden = focused?.closest('[inert]');
        return focused !== null && focused === window.__focusedFileWorkspaceBeforeHide && focused.querySelector('.monaco-editor') !== null && hidden?.getAttribute('aria-hidden') === 'true' && primary !== null;
      })()`,
      '收起只隐藏来源会话并保留文件实例',
      () => serverOutput
    )
    await click(client, `${focusedColumn} [data-testid="session-files-entry"]`)
    await waitFor(
      client,
      `document.querySelector('${focusedColumn} [data-testid="file-workspace"]')?.textContent.includes('selectionToken')`,
      '本会话入口一键恢复文件',
      () => serverOutput
    )

    await setViewport(client, 2300, 1000, false)
    await waitFor(
      client,
      `['${primaryWorkId}', '${focusedWorkId}'].every(id => {
      const column = document.querySelector('[data-work-id="' + id + '"]');
      const chat = column?.querySelector('footer textarea')?.getBoundingClientRect();
      const file = column?.querySelector('[data-testid="file-workspace"]')?.getBoundingClientRect();
      return chat?.width > 200 && file?.width > 400 && file.left > chat.left;
    })`,
      '宽会话内聊天和文件独立并排',
      () => serverOutput
    )
    const beforeFocus = await evaluate(
      client,
      `['${primaryWorkId}', '${focusedWorkId}'].map(id => document.querySelector('[data-work-id="' + id + '"]').getBoundingClientRect().width)`
    )
    await activateFixedWorkSession(client)
    await waitFor(
      client,
      `document.querySelector('${primaryColumn} [data-testid="file-workspace"]') !== null && document.querySelector('${focusedColumn} [data-testid="file-workspace"]') !== null`,
      '焦点切换保持两个文件窗口',
      () => serverOutput
    )
    const afterFocus = await evaluate(
      client,
      `['${primaryWorkId}', '${focusedWorkId}'].map(id => document.querySelector('[data-work-id="' + id + '"]').getBoundingClientRect().width)`
    )
    assert.deepEqual(afterFocus, beforeFocus, '聚焦会话不得改变整体列宽')
    const independentHeaders = await evaluate(
      client,
      `(() => {
      const column = document.querySelector('${focusedColumn}');
      const chatHeader = column.querySelector('header').getBoundingClientRect();
      const fileHeader = column.querySelector('[data-testid="file-workspace"] header').getBoundingClientRect();
      return Math.abs(chatHeader.top - fileHeader.top) < 2 && chatHeader.right <= fileHeader.left + 2;
    })()`
    )
    assert.equal(independentHeaders, true, '文件和聊天使用相邻独立顶部')
    await waitFor(
      client,
      `(() => {
        return ['${primaryWorkId}', '${focusedWorkId}'].every((workId) => {
          const layout = document.querySelector('[data-work-id="' + workId + '"] [data-testid="session-file-layout"]');
          const divider = layout?.querySelector('[aria-label="调整聊天和文件宽度"]');
          return layout?.getAttribute('data-file-layout') === 'split' && divider?.getAttribute('aria-hidden') !== 'true' && divider?.getAttribute('aria-disabled') !== 'true' && divider?.getBoundingClientRect().width > 0;
        });
      })()`,
      '会话内分隔线在宽屏可操作',
      () => serverOutput
    )
    const beforeResize = await readSessionSplitMetrics(client, focusedWorkId)
    const beforeOtherResize = await readSessionSplitMetrics(client, primaryWorkId)
    assert.ok(beforeResize)
    assert.ok(beforeOtherResize)
    assert.ok(
      beforeResize.chat.width >= 319 && beforeResize.file.width >= 319,
      JSON.stringify(beforeResize)
    )
    assert.ok(
      beforeOtherResize.chat.width >= 319 && beforeOtherResize.file.width >= 319,
      JSON.stringify(beforeOtherResize)
    )
    const draftText = '会话内宽度调整草稿'
    const draftFocused = await evaluate(
      client,
      `(() => {
        const textarea = document.querySelector('${focusedColumn} textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) return false;
        textarea.focus();
        return document.activeElement === textarea;
      })()`
    )
    assert.equal(draftFocused, true, '分隔线测试前聊天草稿未获得焦点')
    await client.send('Input.insertText', { text: draftText })
    await waitFor(
      client,
      `document.querySelector('${focusedColumn} textarea')?.value.includes(${JSON.stringify(draftText)}) === true`,
      '拖动前聊天草稿写入',
      () => serverOutput
    )
    const readingScrollTop = await evaluate(
      client,
      `(() => {
        const scroll = document.querySelector('${focusedColumn} [data-testid="file-workspace"] .monaco-scrollable-element');
        if (!(scroll instanceof HTMLElement)) return null;
        scroll.scrollTop = Math.min(260, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
        scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
        return scroll.scrollTop;
      })()`
    )
    assert.ok(typeof readingScrollTop === 'number', '代码编辑器滚动容器未找到')
    await evaluate(
      client,
      `(() => {
        const column = document.querySelector('${focusedColumn}');
        window.__resizeChatPanel = column?.querySelector('[data-testid="session-chat-pane-${focusedWorkId}"]');
        window.__resizeFilePanel = column?.querySelector('[data-testid="session-file-pane-${focusedWorkId}"]');
        window.__resizeFileWorkspace = column?.querySelector('[data-testid="file-workspace"]');
        window.__resizeEditor = column?.querySelector('[data-testid="file-workspace"] .monaco-editor');
        window.__resizeDraft = column?.querySelector('footer textarea');
        return true;
      })()`
    )
    const dragDelta = Math.min(180, Math.max(100, beforeResize.file.width - 350))
    await dragDivider(client, focusedWorkId, dragDelta)
    await waitFor(
      client,
      `(() => {
        const layout = document.querySelector('${focusedColumn} [data-testid="session-file-layout"]');
        const chat = layout?.querySelector('[data-testid="session-chat-pane-${focusedWorkId}"]')?.getBoundingClientRect();
        const file = layout?.querySelector('[data-testid="session-file-pane-${focusedWorkId}"]')?.getBoundingClientRect();
        return Boolean(chat && file && chat.width > ${beforeResize.chat.width + 20} && file.width >= 319);
      })()`,
      '鼠标拖动分隔线调整当前会话宽度',
      () => serverOutput
    )
    const afterDrag = await readSessionSplitMetrics(client, focusedWorkId)
    const afterOtherDrag = await readSessionSplitMetrics(client, primaryWorkId)
    assert.ok(afterDrag)
    assert.ok(afterOtherDrag)
    assert.ok(
      afterDrag.chat.width > beforeResize.chat.width + 20,
      JSON.stringify({ beforeResize, afterDrag })
    )
    assert.ok(afterDrag.file.width >= 319, JSON.stringify(afterDrag))
    assert.ok(
      Math.abs(afterOtherDrag.chat.width - beforeOtherResize.chat.width) <= 2,
      JSON.stringify({ beforeOtherResize, afterOtherDrag })
    )
    assert.ok(
      Math.abs(afterOtherDrag.file.width - beforeOtherResize.file.width) <= 2,
      JSON.stringify({ beforeOtherResize, afterOtherDrag })
    )
    assert.ok(
      Math.abs(afterOtherDrag.column.width - beforeOtherResize.column.width) <= 2,
      JSON.stringify({ beforeOtherResize, afterOtherDrag })
    )
    const retainedAfterDrag = await evaluate(
      client,
      `(() => {
        const column = document.querySelector('${focusedColumn}');
        const scroll = column?.querySelector('[data-testid="file-workspace"] .monaco-scrollable-element');
        const textarea = column?.querySelector('footer textarea');
        return {
          chatSame: column?.querySelector('[data-testid="session-chat-pane-${focusedWorkId}"]') === window.__resizeChatPanel,
          fileSame: column?.querySelector('[data-testid="session-file-pane-${focusedWorkId}"]') === window.__resizeFilePanel,
          workspaceSame: column?.querySelector('[data-testid="file-workspace"]') === window.__resizeFileWorkspace,
          editorSame: column?.querySelector('[data-testid="file-workspace"] .monaco-editor') === window.__resizeEditor,
          draftSame: textarea?.value.includes(${JSON.stringify(draftText)}) === true,
          scrollTop: scroll?.scrollTop ?? null
        };
      })()`
    )
    assert.equal(retainedAfterDrag.chatSame, true, JSON.stringify(retainedAfterDrag))
    assert.equal(retainedAfterDrag.fileSame, true, JSON.stringify(retainedAfterDrag))
    assert.equal(retainedAfterDrag.workspaceSame, true, JSON.stringify(retainedAfterDrag))
    assert.equal(retainedAfterDrag.editorSame, true, JSON.stringify(retainedAfterDrag))
    assert.equal(retainedAfterDrag.draftSame, true, JSON.stringify(retainedAfterDrag))
    assert.ok(
      Math.abs(retainedAfterDrag.scrollTop - readingScrollTop) <= 2,
      JSON.stringify({ readingScrollTop, retainedAfterDrag })
    )

    const dragChatWidth = afterDrag.chat.width
    await pressDividerKey(client, focusedWorkId, 'ArrowLeft')
    await waitFor(
      client,
      `document.querySelector('${focusedColumn} [data-testid="session-chat-pane-${focusedWorkId}"]')?.getBoundingClientRect().width < ${dragChatWidth - 10}`,
      '分隔线ArrowLeft缩小聊天面板',
      () => serverOutput
    )
    const afterArrowLeft = await readSessionSplitMetrics(client, focusedWorkId)
    assert.ok(afterArrowLeft)
    assert.ok(
      afterArrowLeft.chat.width >= 319 && afterArrowLeft.file.width >= 319,
      JSON.stringify(afterArrowLeft)
    )
    await pressDividerKey(client, focusedWorkId, 'ArrowRight')
    await waitFor(
      client,
      `document.querySelector('${focusedColumn} [data-testid="session-chat-pane-${focusedWorkId}"]')?.getBoundingClientRect().width > ${afterArrowLeft.chat.width + 10}`,
      '分隔线ArrowRight扩大聊天面板',
      () => serverOutput
    )
    await pressDividerKey(client, focusedWorkId, 'Home')
    await waitFor(
      client,
      `(() => {
        const chat = document.querySelector('${focusedColumn} [data-testid="session-chat-pane-${focusedWorkId}"]')?.getBoundingClientRect();
        const file = document.querySelector('${focusedColumn} [data-testid="session-file-pane-${focusedWorkId}"]')?.getBoundingClientRect();
        return Boolean(chat && file && chat.width <= 340 && file.width >= 319);
      })()`,
      '分隔线Home到聊天最小可用宽度',
      () => serverOutput
    )
    const afterHome = await readSessionSplitMetrics(client, focusedWorkId)
    assert.ok(afterHome)
    assert.ok(afterHome.chat.width >= 319 && afterHome.file.width >= 319, JSON.stringify(afterHome))
    await pressDividerKey(client, focusedWorkId, 'End')
    await waitFor(
      client,
      `(() => {
        const chat = document.querySelector('${focusedColumn} [data-testid="session-chat-pane-${focusedWorkId}"]')?.getBoundingClientRect();
        const file = document.querySelector('${focusedColumn} [data-testid="session-file-pane-${focusedWorkId}"]')?.getBoundingClientRect();
        return Boolean(chat && file && chat.width >= 319 && file.width <= 340);
      })()`,
      '分隔线End到文件最小可用宽度',
      () => serverOutput
    )
    const afterEnd = await readSessionSplitMetrics(client, focusedWorkId)
    assert.ok(afterEnd)
    assert.ok(afterEnd.chat.width >= 319 && afterEnd.file.width >= 319, JSON.stringify(afterEnd))

    await waitFor(
      client,
      `document.querySelector('[data-testid="project-file-src/iframe-preview.html"]') !== null`,
      'HTML拖动测试文件加载',
      () => serverOutput
    )
    await click(client, '[data-testid="project-file-src/iframe-preview.html"]')
    const iframeSelector = `${focusedColumn} iframe[title$="iframe-preview.html HTML 预览"]`
    await waitFor(
      client,
      `document.querySelector(${JSON.stringify(iframeSelector)}) !== null`,
      'HTML拖动测试预览加载',
      () => serverOutput
    )
    await dragDivider(client, focusedWorkId, -120, iframeSelector)
    await waitFor(
      client,
      `document.querySelector('${focusedColumn} [data-testid="session-file-pane-${focusedWorkId}"]')?.getBoundingClientRect().width > 340`,
      'HTML预览下分隔线向左调整',
      () => serverOutput
    )
    const beforeIframeDrag = await readSessionSplitMetrics(client, focusedWorkId)
    await evaluate(
      client,
      `(() => {
        window.__resizeIframe = document.querySelector(${JSON.stringify(iframeSelector)});
        return true;
      })()`
    )
    await dragDivider(client, focusedWorkId, 80, iframeSelector)
    await waitFor(
      client,
      `(() => {
        const chat = document.querySelector('${focusedColumn} [data-testid="session-chat-pane-${focusedWorkId}"]')?.getBoundingClientRect();
        const file = document.querySelector('${focusedColumn} [data-testid="session-file-pane-${focusedWorkId}"]')?.getBoundingClientRect();
        return Boolean(chat && file && chat.width > ${beforeIframeDrag.chat.width + 10} && file.width >= 319);
      })()`,
      '鼠标拖过HTML iframe后仍完成调整',
      () => serverOutput
    )
    const afterIframeDrag = await readSessionSplitMetrics(client, focusedWorkId)
    assert.ok(afterIframeDrag)
    assert.ok(afterIframeDrag.file.width >= 319, JSON.stringify(afterIframeDrag))
    assert.equal(
      await evaluate(
        client,
        `document.querySelector(${JSON.stringify(iframeSelector)}) === window.__resizeIframe`
      ),
      true,
      'HTML iframe拖动期间未重建'
    )
    await click(
      client,
      `${focusedColumn} [data-testid="file-tab-src/active-preview.ts"] [role="tab"]`
    )
    await waitFor(
      client,
      `(() => {
        const file = document.querySelector('${focusedColumn} [data-testid="file-workspace"]');
        return file?.querySelector('.monaco-editor .view-lines') !== null && file.querySelector('header')?.textContent.includes('active-preview.ts');
      })()`,
      '拖动后恢复代码文件',
      () => serverOutput
    )
    await evaluate(
      client,
      `(() => {
        window.__resizeEditorAfterHtml = document.querySelector('${focusedColumn} [data-testid="file-workspace"] .monaco-editor');
        return true;
      })()`
    )
    await click(client, `${focusedColumn} [aria-label="收起文件"]`)
    await waitFor(
      client,
      `document.querySelector('${focusedColumn} [data-testid="file-workspace"]')?.closest('[inert]')?.getAttribute('aria-hidden') === 'true'`,
      '宽屏拖动比例收起时保留隐藏面',
      () => serverOutput
    )
    await click(client, `${focusedColumn} [data-testid="session-files-entry"]`)
    await waitFor(
      client,
      `document.querySelector('${focusedColumn} [data-testid="session-file-layout"]')?.getAttribute('data-file-layout') === 'split'`,
      '宽屏拖动比例收起再开恢复并排',
      () => serverOutput
    )
    const afterReopen = await readSessionSplitMetrics(client, focusedWorkId)
    assert.ok(afterReopen)
    const reopenedRatio = afterReopen.chat.width / (afterReopen.chat.width + afterReopen.file.width)
    const rememberedRatio =
      afterIframeDrag.chat.width / (afterIframeDrag.chat.width + afterIframeDrag.file.width)
    assert.ok(
      Math.abs(reopenedRatio - rememberedRatio) <= 0.03,
      JSON.stringify({ rememberedRatio, reopenedRatio, afterReopen })
    )
    assert.equal(
      await evaluate(
        client,
        `(() => {
          const column = document.querySelector('${focusedColumn}');
          return column?.querySelector('[data-testid="file-workspace"]') === window.__resizeFileWorkspace && column?.querySelector('[data-testid="file-workspace"] .monaco-editor') === window.__resizeEditorAfterHtml;
        })()`
      ),
      true,
      '收起再开保留文件编辑器实例'
    )
    const restoredPrimaryBeforeResize = await readSessionSplitMetrics(client, primaryWorkId)
    assert.ok(restoredPrimaryBeforeResize)
    const focusedRatioBeforeResponsive = reopenedRatio
    const primaryRatioBeforeResponsive =
      restoredPrimaryBeforeResize.chat.width /
      (restoredPrimaryBeforeResize.chat.width + restoredPrimaryBeforeResize.file.width)
    assert.ok(
      Math.abs(focusedRatioBeforeResponsive - 0.5) > 0.08,
      JSON.stringify({ focusedRatioBeforeResponsive, primaryRatioBeforeResponsive })
    )
    assert.ok(
      Math.abs(primaryRatioBeforeResponsive - 0.5) < 0.08,
      JSON.stringify({ focusedRatioBeforeResponsive, primaryRatioBeforeResponsive })
    )
    desktopResizeCapture = await acceptanceScreenshot(client)

    await activateWorkSession(client, primaryWorkId, '主会话')
    await activateFixedWorkSession(client)
    const afterResizeFocus = await readSessionSplitMetrics(client, focusedWorkId)
    assert.ok(afterResizeFocus)
    const focusedRatioAfterFocusSwitch =
      afterResizeFocus.chat.width / (afterResizeFocus.chat.width + afterResizeFocus.file.width)
    assert.ok(
      Math.abs(focusedRatioAfterFocusSwitch - focusedRatioBeforeResponsive) <= 0.03,
      JSON.stringify({ focusedRatioBeforeResponsive, focusedRatioAfterFocusSwitch })
    )

    await setViewport(client, 700, 900, false)
    await waitFor(
      client,
      `document.querySelector('${primaryColumn} [data-testid="session-file-layout"]')?.getAttribute('data-file-layout') === 'single'`,
      '窄桌面会话内覆盖布局',
      () => serverOutput
    )
    const narrowMetrics = await readSessionSplitMetrics(client, primaryWorkId)
    assert.ok(narrowMetrics)
    assert.equal(narrowMetrics.fileLayout, 'single')
    assert.ok(
      narrowMetrics.chat.width > 0 && narrowMetrics.file.width > 0,
      JSON.stringify(narrowMetrics)
    )
    assert.equal(narrowMetrics.divider.hidden, true, JSON.stringify(narrowMetrics))
    assert.equal(narrowMetrics.divider.disabled, true, JSON.stringify(narrowMetrics))
    assert.equal(narrowMetrics.divider.display, 'none', JSON.stringify(narrowMetrics))

    await setViewport(client, 390, 844, true)
    await progress('进入最终移动端回归阶段')
    await waitFor(
      client,
      `document.querySelector('${primaryColumn} [data-testid="session-file-layout"]')?.getAttribute('data-file-layout') === 'single'`,
      '手机会话内覆盖布局',
      () => serverOutput
    )
    const mobileDividerMetrics = await readSessionSplitMetrics(client, primaryWorkId)
    assert.ok(mobileDividerMetrics)
    assert.equal(mobileDividerMetrics.divider.hidden, true, JSON.stringify(mobileDividerMetrics))
    assert.equal(mobileDividerMetrics.divider.disabled, true, JSON.stringify(mobileDividerMetrics))
    assert.equal(mobileDividerMetrics.divider.display, 'none', JSON.stringify(mobileDividerMetrics))
    assert.ok(
      mobileDividerMetrics.chat.width > 0 && mobileDividerMetrics.file.width > 0,
      JSON.stringify(mobileDividerMetrics)
    )

    await setViewport(client, 2300, 1000, false)
    await waitFor(
      client,
      `['${primaryWorkId}', '${focusedWorkId}'].every((workId) => document.querySelector('[data-work-id="' + workId + '"] [data-testid="session-file-layout"]')?.getAttribute('data-file-layout') === 'split')`,
      '宽屏恢复两个会话并排布局',
      () => serverOutput
    )
    const restoredFocused = await readSessionSplitMetrics(client, focusedWorkId)
    const restoredPrimary = await readSessionSplitMetrics(client, primaryWorkId)
    assert.ok(restoredFocused)
    assert.ok(restoredPrimary)
    const restoredFocusedRatio =
      restoredFocused.chat.width / (restoredFocused.chat.width + restoredFocused.file.width)
    const restoredPrimaryRatio =
      restoredPrimary.chat.width / (restoredPrimary.chat.width + restoredPrimary.file.width)
    assert.ok(
      Math.abs(restoredFocusedRatio - focusedRatioBeforeResponsive) <= 0.03,
      JSON.stringify({ focusedRatioBeforeResponsive, restoredFocusedRatio })
    )
    assert.ok(
      Math.abs(restoredPrimaryRatio - primaryRatioBeforeResponsive) < 0.08,
      JSON.stringify({ primaryRatioBeforeResponsive, restoredPrimaryRatio })
    )
    assert.ok(
      restoredFocused.chat.width >= 319 && restoredFocused.file.width >= 319,
      JSON.stringify(restoredFocused)
    )
    assert.ok(
      restoredPrimary.chat.width >= 319 && restoredPrimary.file.width >= 319,
      JSON.stringify(restoredPrimary)
    )
    await activateWorkSession(client, primaryWorkId, '主会话')
    await activateFixedWorkSession(client)
    const afterResponsiveFocus = await readSessionSplitMetrics(client, focusedWorkId)
    assert.ok(afterResponsiveFocus)
    assert.ok(
      Math.abs(
        afterResponsiveFocus.chat.width /
          (afterResponsiveFocus.chat.width + afterResponsiveFocus.file.width) -
          focusedRatioBeforeResponsive
      ) <= 0.03,
      JSON.stringify({ focusedRatioBeforeResponsive, afterResponsiveFocus })
    )
    desktopCapture = await acceptanceScreenshot(client)
    await click(client, `${primaryColumn} [data-testid="session-files-entry"]`)
    await waitFor(
      client,
      `document.querySelector('${primaryColumn} [data-testid="file-workspace"]')?.closest('[inert]') === null`,
      '响应式测试前恢复主会话文件面板',
      () => serverOutput
    )

    await click(client, `${focusedColumn} [aria-label="放大文件"]`)
    await waitFor(
      client,
      `(() => {
        const file = document.querySelector('[data-slot="app-dialog-content"] [data-file-work-id="${focusedWorkId}"]');
        return file?.querySelector('.monaco-editor .view-lines') !== null && file.querySelector('header')?.textContent.includes('active-preview.ts');
      })()`,
      '放大来源会话文件',
      () => serverOutput
    )
    assert.equal(
      await evaluate(
        client,
        `document.querySelectorAll('[data-slot="app-dialog-content"]').length`
      ),
      1
    )
    await waitFor(
      client,
      `document.querySelector('[data-slot="app-dialog-content"] [aria-label="预览项目目录"]') !== null && document.querySelector('[data-slot="app-dialog-content"] [data-testid="project-file-src/active-preview.ts"]') !== null`,
      '放大窗口显示左侧项目目录',
      () => serverOutput
    )
    const expandedLayout = await evaluate(
      client,
      `(() => {
        const dialog = document.querySelector('[data-slot="app-dialog-content"]');
        const directory = dialog?.querySelector('[aria-label="预览项目目录"]');
        const file = dialog?.querySelector('[data-testid="file-workspace"]');
        if (!(dialog instanceof HTMLElement) || !(directory instanceof HTMLElement) || !(file instanceof HTMLElement)) return null;
        const dialogRect = dialog.getBoundingClientRect();
        const directoryRect = directory.getBoundingClientRect();
        const content = directory.parentElement?.children[1];
        if (!(content instanceof HTMLElement)) return null;
        const contentRect = content.getBoundingClientRect();
        return {
          dialogWidth: dialogRect.width,
          directoryWidth: directoryRect.width,
          directoryLeft: directoryRect.left,
          directoryRight: directoryRect.right,
          contentLeft: contentRect.left,
          contentRight: contentRect.right,
          hasTabs: content.querySelector('[data-testid="file-tabs"]') !== null,
          hasEditor: file.querySelector('.monaco-editor .view-lines') !== null
        };
      })()`
    )
    assert.ok(expandedLayout)
    assert.ok(expandedLayout.directoryWidth >= 200, JSON.stringify(expandedLayout))
    assert.ok(expandedLayout.directoryLeft >= 0, JSON.stringify(expandedLayout))
    assert.ok(
      expandedLayout.directoryRight <= expandedLayout.contentLeft + 2,
      JSON.stringify(expandedLayout)
    )
    assert.ok(
      expandedLayout.contentRight > expandedLayout.contentLeft,
      JSON.stringify(expandedLayout)
    )
    assert.equal(expandedLayout.hasTabs, true, JSON.stringify(expandedLayout))
    assert.equal(expandedLayout.hasEditor, true, JSON.stringify(expandedLayout))
    desktopExpandedCapture = await acceptanceScreenshot(client)
    await openProjectContextMenu(
      client,
      'project-file-src/active-preview.ts',
      'mouse',
      '打开所在文件夹'
    )
    assert.equal(
      await evaluate(
        client,
        `(() => {
      const menu = document.querySelector('[role="menu"]');
      const rect = menu.getBoundingClientRect();
      return menu.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    })()`
      ),
      true,
      '放大窗口中的目录菜单必须位于文件层之上'
    )
    const menuFocused = await evaluate(
      client,
      `(() => {
        const menu = document.querySelector('[role="menu"]');
        if (!(menu instanceof HTMLElement)) return false;
        menu.focus();
        return document.activeElement === menu;
      })()`
    )
    assert.equal(menuFocused, true, '目录菜单未获得键盘焦点')
    await dispatchEscape(client)
    await waitFor(
      client,
      `document.querySelector('[role="menu"]') === null`,
      '只关闭目录菜单',
      () => serverOutput
    )
    const dialogAfterMenu = await evaluate(
      client,
      `(() => ({
        dialog: document.querySelector('[data-slot="app-dialog-content"]') !== null,
        file: document.querySelector('[data-slot="app-dialog-content"] [data-testid="project-file-src/active-preview.ts"]') !== null,
        workspace: document.querySelector('[data-slot="app-dialog-content"] [data-testid="file-workspace"]') !== null
      }))()`
    )
    assert.equal(
      dialogAfterMenu.dialog && dialogAfterMenu.file && dialogAfterMenu.workspace,
      true,
      JSON.stringify(dialogAfterMenu)
    )
    await click(
      client,
      '[data-slot="app-dialog-content"] [data-testid="project-file-src/active-preview.ts"]'
    )
    await click(client, '[data-slot="app-dialog-content"] [aria-label="退出放大"]')
    await waitFor(
      client,
      `(() => {
        const file = document.querySelector('${focusedColumn} [data-testid="file-workspace"]');
        return document.querySelector('[data-slot="app-dialog-content"]') === null && file?.querySelector('.monaco-editor .view-lines') !== null && file.querySelector('header')?.textContent.includes('active-preview.ts');
      })()`,
      '退出放大恢复会话文件面板',
      () => serverOutput
    )

    await waitFor(
      client,
      `document.activeElement?.closest('[data-file-work-id]')?.getAttribute('data-file-work-id') === '${focusedWorkId}'`,
      '退出放大焦点回到文件面板',
      () => serverOutput
    )
    await click(client, `[data-testid="work-session-row-${focusedWorkId}"]`)
    await waitFor(
      client,
      `document.querySelector('${focusedColumn} footer[data-composer-active="true"]') !== null`,
      '缩屏前公开选择固定会话',
      () => serverOutput
    )
    await setViewport(client, 390, 844, true)
    await waitFor(
      client,
      `(() => {
        const file = document.querySelector('${focusedColumn} [data-testid="file-workspace"]');
        return file?.querySelector('.monaco-editor .view-lines') !== null && file.querySelector('header')?.textContent.includes('active-preview.ts') && file.getBoundingClientRect().left >= -1 && file.getBoundingClientRect().right <= window.innerWidth + 1 && file.getBoundingClientRect().width >= 388;
      })()`,
      '移动端保留当前焦点会话文件',
      () => serverOutput
    )
    await click(client, '[aria-label="显示工作会话菜单"]')
    await waitFor(
      client,
      `document.querySelector('[data-testid="sidebar-mode-sessions"]') !== null`,
      '移动端会话选择入口',
      () => serverOutput
    )
    await click(client, '[data-testid="sidebar-mode-sessions"]')
    await click(client, `[data-testid="work-session-row-${primaryWorkId}"]`)
    await waitFor(
      client,
      `(() => {
        const file = document.querySelector('${primaryColumn} [data-testid="file-workspace"]');
        return file?.textContent.replaceAll('\\u00a0', ' ').includes('export const primary') && file.getBoundingClientRect().left >= -1 && file.getBoundingClientRect().right <= window.innerWidth + 1 && file.getBoundingClientRect().width >= 388;
      })()`,
      '通过会话选择切换到主会话文件',
      () => serverOutput
    )
    const mobileLayout = await evaluate(
      client,
      `(() => {
      const file = document.querySelector('${primaryColumn} [data-testid="file-workspace"]');
      const rect = file.getBoundingClientRect();
      const back = file.querySelector('[aria-label="返回聊天"]').getBoundingClientRect();
      const textarea = document.querySelector('${primaryColumn} footer textarea');
      const hiddenChat = textarea?.closest('[aria-hidden="true"]');
      return { width: rect.width, height: rect.height, left: rect.left, backWidth: back.width, backHeight: back.height, chatHidden: hiddenChat?.hasAttribute('inert') === true };
    })()`
    )
    assert.ok(
      mobileLayout.width >= 388 && mobileLayout.height >= 840 && mobileLayout.left >= -1,
      JSON.stringify(mobileLayout)
    )
    assert.ok(
      mobileLayout.backWidth >= 32 && mobileLayout.backHeight >= 32 && mobileLayout.chatHidden,
      JSON.stringify(mobileLayout)
    )
    await click(client, `${primaryColumn} [aria-label="显示工作会话菜单"]`)
    await waitFor(
      client,
      `document.querySelector('[aria-label="关闭工作会话菜单"]')?.getAttribute('aria-hidden') !== 'true'`,
      '手机文件视图打开统一侧栏',
      () => serverOutput
    )
    mobileTabsSidebarCapture = await acceptanceScreenshot(client)
    await click(client, '[aria-label="关闭工作会话菜单"]')
    await waitFor(
      client,
      `document.querySelector('[aria-label="关闭工作会话菜单"]')?.getAttribute('aria-hidden') === 'true'`,
      '关闭手机统一侧栏',
      () => serverOutput
    )
    mobileCapture = await acceptanceScreenshot(client)
    await waitFor(
      client,
      `(() => {
        const file = document.querySelector('${primaryColumn} [data-testid="file-workspace"]');
        return file !== null && file.closest('[inert]') === null;
      })()`,
      'CtrlTab前文件面板保持可见',
      () => serverOutput
    )
    await dispatchControlTab(client)
    await waitFor(
      client,
      `(() => {
        const file = document.querySelector('${primaryColumn} [data-testid="file-workspace"]');
        const hidden = file?.closest('[inert]');
        return hidden?.getAttribute('aria-hidden') === 'true';
      })()`,
      '手机Ctrl+Tab切回聊天',
      () => serverOutput
    )
    await dispatchControlTab(client, true)
    await waitFor(
      client,
      `(() => {
        const file = document.querySelector('${primaryColumn} [data-testid="file-workspace"]');
        return file?.closest('[inert]') === null && document.activeElement?.closest('[data-testid="file-workspace"]') === file;
      })()`,
      '手机Ctrl+Shift+Tab切回文件',
      () => serverOutput
    )
    const activeMobileTab = await evaluate(
      client,
      `document.querySelector('${primaryColumn} [data-testid="file-tabs"] [aria-selected="true"]')?.closest('[data-file-tab]')?.getAttribute('data-testid') ?? null`
    )
    await openFileTabContextMenu(client, 'src/primary.ts', 'touch')
    assert.equal(
      await evaluate(
        client,
        `document.querySelector('${primaryColumn} [data-testid="file-tabs"] [aria-selected="true"]')?.closest('[data-file-tab]')?.getAttribute('data-testid') === ${JSON.stringify(activeMobileTab)}`
      ),
      true,
      '长按标签打开菜单不误激活正文'
    )
    const singleTabMenuState = await evaluate(
      client,
      `(() => [...document.querySelectorAll('[role="menuitem"]')].map((item) => ({ text: item.textContent?.trim(), disabled: item.getAttribute('aria-disabled') === 'true' })))()`
    )
    assert.equal(singleTabMenuState.length, 5)
    assert.equal(singleTabMenuState.find((item) => item.text === '关闭标签')?.disabled, false)
    assert.equal(singleTabMenuState.find((item) => item.text === '关闭其他标签')?.disabled, false)
    assert.equal(singleTabMenuState.find((item) => item.text === '关闭左侧标签')?.disabled, true)
    assert.equal(singleTabMenuState.find((item) => item.text === '关闭右侧标签')?.disabled, false)
    await dispatchEscape(client)
    await waitFor(
      client,
      `document.querySelector('[role="menu"]') === null`,
      '关闭长按标签菜单',
      () => serverOutput
    )
    await waitFor(
      client,
      `document.querySelector('${primaryColumn} [data-testid="file-tab-close-src/primary.ts"]') !== null`,
      '手机已打开文件列表',
      () => serverOutput
    )
    assert.equal(
      await evaluate(
        client,
        `document.querySelector('${primaryColumn} [data-testid="file-tab-close-src/primary.ts"]').getBoundingClientRect().height >= 32`
      ),
      true
    )
    await openFileTabContextMenu(client, 'src/primary.ts', 'touch')
    await clickMenuItem(client, '关闭全部标签')
    await waitFor(
      client,
      `document.querySelector('${primaryColumn} [data-testid="file-workspace"]') === null && document.querySelector('${primaryColumn} [data-testid="session-files-entry"]') === null`,
      '批量关闭手机全部文件后返回聊天并移除入口',
      () => serverOutput
    )
    await click(client, '[aria-label="显示工作会话菜单"]')
    await click(client, '[data-testid="sidebar-mode-sessions"]')
    await click(client, `[data-testid="work-session-row-${primaryWorkId}"]`)
    await waitFor(
      client,
      `document.querySelector('${primaryColumn} footer[data-composer-active="true"]') !== null`,
      '手机侧栏切换主会话',
      () => serverOutput
    )
    await click(client, '[aria-label="显示工作会话菜单"]')
    await click(client, '[data-testid="sidebar-mode-files"]')
    await waitFor(
      client,
      `document.querySelector('[data-testid="project-folder-src"] button') !== null`,
      '手机统一侧栏项目目录加载',
      () => serverOutput
    )
    await ensureFolderExpanded(client, '[data-testid="project-folder-src"]', '手机主会话 src 目录')
    await waitFor(
      client,
      `document.querySelector('[data-testid="project-file-src/primary.ts"]') !== null`,
      '手机统一侧栏文件加载',
      () => serverOutput
    )
    await click(client, '[data-testid="project-file-src/primary.ts"]')
    await waitFor(
      client,
      `document.querySelector('${primaryColumn} [data-testid="file-workspace"] .monaco-editor') !== null`,
      '目录内重新打开文件',
      () => serverOutput
    )
    await evaluate(
      client,
      `(() => {
        window.__primaryFileWorkspaceBeforeHide = document.querySelector('${primaryColumn} [data-testid="file-workspace"]');
        return true;
      })()`
    )
    await click(client, `${primaryColumn} [aria-label="返回聊天"]`)
    await waitFor(
      client,
      `(() => {
        const file = document.querySelector('${primaryColumn} [data-testid="file-workspace"]');
        const hidden = file?.closest('[inert]');
        return document.querySelector('${primaryColumn} textarea')?.getBoundingClientRect().width > 0 && file !== null && file === window.__primaryFileWorkspaceBeforeHide && file.querySelector('.monaco-editor') !== null && hidden?.getAttribute('aria-hidden') === 'true';
      })()`,
      '手机返回聊天并保留文件实例',
      () => serverOutput
    )
    await click(client, `${primaryColumn} [data-testid="session-files-entry"]`)
    await waitFor(
      client,
      `document.querySelector('${primaryColumn} [data-testid="file-workspace"]')?.textContent.replaceAll('\u00a0', ' ').includes('export const primary')`,
      '手机从固定入口恢复同一文件',
      () => serverOutput
    )
    await click(client, `${primaryColumn} [aria-label="返回聊天"]`)
    await click(client, '[aria-label="显示工作会话菜单"]')
    await click(client, '[data-testid="sidebar-mode-sessions"]')
    await click(client, `[data-testid="work-session-row-${focusedWorkId}"]`)
    await waitFor(
      client,
      `(() => {
        const file = document.querySelector('${focusedColumn} [data-testid="file-workspace"]');
        return file?.querySelector('.monaco-editor .view-lines') !== null && file.querySelector('header')?.textContent.includes('active-preview.ts');
      })()`,
      '手机切换会话恢复各自文件',
      () => serverOutput
    )
    await click(client, '[aria-label="显示工作会话菜单"]')
    await click(client, '[data-testid="sidebar-mode-files"]')
    await ensureFolderExpanded(
      client,
      '[data-testid="project-folder-src"]',
      '手机固定会话 src 目录'
    )
    await waitFor(
      client,
      `(() => {
        const element = document.querySelector('[data-testid="project-file-src/active-preview.ts"]');
        if (!(element instanceof HTMLElement) || document.querySelector('[data-slot="app-dialog-content"]')) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
      })()`,
      '移动端项目文件列表进入视口',
      () => serverOutput
    )
    await openProjectContextMenu(
      client,
      'project-file-src/active-preview.ts',
      'touch',
      '打开所在文件夹'
    )
    assert.equal(
      await evaluate(
        client,
        `[...document.querySelectorAll('[role="menuitem"]')].every((item) => item.getBoundingClientRect().height >= 28)`
      ),
      true,
      '移动端菜单项触控高度不足'
    )
    mobileContextMenuCapture = await acceptanceScreenshot(client)

    assert.deepEqual(
      await evaluate(client, 'window.__piDeskE2eErrors ?? []'),
      [],
      '双端文件交互不得产生浏览器异常'
    )
    await progress('全部断言完成，写入截图')
    await publishScreenshots([
      [desktopOutput, desktopCapture],
      [desktopContextMenuOutput, desktopContextMenuCapture],
      [desktopTabsOutput, desktopTabsCapture],
      [desktopExpandedOutput, desktopExpandedCapture],
      [desktopResizeOutput, desktopResizeCapture],
      [mobileOutput, mobileCapture],
      [mobileTabsSidebarOutput, mobileTabsSidebarCapture],
      [mobileContextMenuOutput, mobileContextMenuCapture]
    ])
  } catch (error) {
    await mkdir(failureRoot, { recursive: true })
    await writeFile(
      join(failureRoot, 'error.txt'),
      error instanceof Error ? `${error.stack ?? error.message}\n` : String(error),
      'utf8'
    )
    if (client) {
      const evidence = await evaluate(
        client,
        `({
        url: location.href,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        activeElement: document.activeElement instanceof HTMLElement ? { tag: document.activeElement.tagName, ariaLabel: document.activeElement.getAttribute('aria-label'), testId: document.activeElement.getAttribute('data-testid') } : null,
        scroll: { x: window.scrollX, y: window.scrollY },
        errors: window.__piDeskE2eErrors ?? [],
        requests: window.__piDeskRequests ?? [],
        columns: [...document.querySelectorAll('[data-work-id]')].map((node) => ({ workId: node.getAttribute('data-work-id'), columnRect: node.getBoundingClientRect().toJSON(), transform: getComputedStyle(node).transform, fileRect: node.querySelector('[data-testid="file-workspace"]')?.getBoundingClientRect().toJSON() ?? null, window: Boolean(node.querySelector('[data-testid="file-workspace"]')), windowOpen: node.querySelector('[data-testid="file-workspace"]')?.closest('[inert]')?.getAttribute('aria-hidden') ?? null, text: node.innerText.slice(0, 1200) }))
      })`
      )
      evidence.targetInfo = await client.send('Target.getTargetInfo').catch(() => null)
      evidence.targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
        .then((response) => response.json())
        .catch(() => [])
      await writeFile(join(failureRoot, 'dom.json'), JSON.stringify(evidence, null, 2), 'utf8')
      const image = await withTimeout(
        client.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true
        }),
        '文件旧E2E失败截图',
        10_000
      )
      await writeFile(join(failureRoot, 'failure.png'), Buffer.from(image.data, 'base64'))
    }
    await writeFile(join(failureRoot, 'server.log'), serverOutput, 'utf8')
    await writeFile(
      join(failureRoot, 'run-info.txt'),
      `pid=${process.pid}\nrunId=${legacyRunId}\nfailedAt=${new Date().toISOString()}\nappPort=${appPort}\ncdpPort=${cdpPort}\n`,
      'utf8'
    )
    throw error
  } finally {
    await progress('进入finally清理')
    client?.close()
    await stopBrowserTree(browserProcess, cdpPort)
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await progress('端口与进程清理完成')
    await writeFile(
      join(legacyRoot, 'run-info.txt'),
      `pid=${process.pid}\nrunId=${legacyRunId}\nfinishedAt=${new Date().toISOString()}\nappPort=${appPort}\ncdpPort=${cdpPort}\n`,
      'utf8'
    )
    await rm(testRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
