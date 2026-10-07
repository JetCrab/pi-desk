import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
const testRoot = join(projectRoot, 'temp', 'pi', 'workbench-branch-picker-e2e', String(process.pid))
const agentDir = join(testRoot, 'agent')
const sourceProjectDir = join(testRoot, '分支树项目')
const fixedProjectDir = join(testRoot, '固定参考项目')
const branchRuntimeExtensionDir = join(agentDir, 'extensions', 'branch-runtime-fixture')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const resultPath = join(projectRoot, 'temp', 'pi', 'workbench-branch-picker-e2e', 'result.json')
const desktopOutput = join(projectRoot, 'temp', '验收', '客户端_桌面', '会话分支__紧凑树与详情.png')
const mobileOutput = join(projectRoot, 'temp', '验收', '客户端_移动端', '会话分支__详情与操作.png')
const obsoleteOutputs = [
  join(projectRoot, 'temp', '验收', '客户端_桌面', '会话分支__树选择.png'),
  join(projectRoot, 'temp', '验收', '客户端_桌面', '会话分支__二次确认.png'),
  join(projectRoot, 'temp', '验收', '客户端_移动端', '会话分支__二次确认.png')
]
const sourceWorkId = 'branch-picker-source'
const fixedWorkId = 'branch-picker-fixed'
const password = 'Qq.445566'
const usage = {
  input: 10,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''
let sourceSessionId = ''
let sourceSessionFile = ''
let fixedSessionId = ''
let forkUserText = ''
let forkExpectedMessageIds = []
let treeUserText = ''
let cloneExpectedMessageIds = []

function assistant(text, timestamp) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp
  }
}

function messageIds(entries) {
  return entries.filter((entry) => entry.type === 'message').map((entry) => entry.id)
}

async function createFixture() {
  process.env.TSX_TSCONFIG_PATH = join(projectRoot, 'tsconfig.json')
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(dirname(workSessionStorePath), { recursive: true })
  await mkdir(sourceProjectDir, { recursive: true })
  await mkdir(fixedProjectDir, { recursive: true })
  await mkdir(branchRuntimeExtensionDir, { recursive: true })
  await writeFile(
    join(branchRuntimeExtensionDir, 'index.ts'),
    `export default function branchRuntimeFixture(pi) {
  pi.registerCommand('append-branch-fixture', {
    description: '追加运行时分支索引测试节点',
    handler() {
      pi.sendMessage(
        {
          customType: 'runtime-branch-parent',
          content: '运行时分支父消息',
          display: true
        },
        { triggerTurn: false }
      )
      try {
        pi.appendEntry('runtime-branch-node', { fixture: true })
      } catch {}
      try {
        pi.appendEntry('runtime-branch-tail', { fixture: true })
      } catch {}
    }
  })
}
`,
    'utf8'
  )
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const timestamp = Date.now()

  const source = SessionManager.create(sourceProjectDir)
  source.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '请设计一版高密度的网页会话分支选择器。' }],
    timestamp
  })
  const sharedAssistant = source.appendMessage(
    assistant('共同回答：先建立清晰的树结构和稳定的路径身份。', timestamp + 1)
  )

  let previousAssistant = sharedAssistant
  for (let index = 1; index <= 6; index += 1) {
    const text =
      index === 3
        ? '请从这里 Fork 到新会话。\n保留这条用户输入，并允许我继续编辑。'
        : index === 5
          ? '请把这条消息作为 Tree 用户节点，切换后带回输入框。'
          : `旧分支阶段 ${index}：继续完善终端式导航。`
    source.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: timestamp + index * 2
    })
    if (index === 3) {
      forkUserText = text
      forkExpectedMessageIds = messageIds(source.getBranch(previousAssistant))
    }
    if (index === 5) {
      treeUserText = text
      cloneExpectedMessageIds = messageIds(source.getBranch(previousAssistant))
    }
    previousAssistant = source.appendMessage(
      assistant(
        `旧分支回答 ${index}：这是用于验证紧凑树密度的历史内容。`,
        timestamp + index * 2 + 1
      )
    )
  }
  source.appendLabelChange(sharedAssistant, '共同检查点')
  source.branch(sharedAssistant)
  for (let index = 1; index <= 12; index += 1) {
    source.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: `当前分支用户 ${index}：适配 Web 与移动端交互。` }],
      timestamp: timestamp + 100 + index * 2
    })
    if (index % 3 === 0) {
      const toolCallId = `branch-picker-read-${index}`
      source.appendMessage({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `当前分支回答 ${index}：使用单行列表、详情区域和明确操作按钮。`
          },
          {
            type: 'toolCall',
            id: toolCallId,
            name: 'read',
            arguments: {
              path: `src/example-${index}.ts`,
              offset: index,
              limit: 20,
              reasoning: '验证工具调用参数展示'
            }
          }
        ],
        api: 'openai-responses',
        provider: 'test',
        model: 'test-model',
        usage,
        stopReason: 'toolUse',
        timestamp: timestamp + 101 + index * 2
      })
      source.appendMessage({
        role: 'toolResult',
        toolCallId,
        toolName: 'read',
        content: [{ type: 'text', text: `src/example-${index}.ts 已读取完成` }],
        usage,
        isError: false,
        timestamp: timestamp + 102 + index * 2
      })
    } else {
      source.appendMessage(
        assistant(
          `当前分支回答 ${index}：使用单行列表、详情区域和明确操作按钮。`,
          timestamp + 101 + index * 2
        )
      )
    }
  }
  sourceSessionId = source.getSessionId()
  sourceSessionFile = source.getSessionFile()
  assert.ok(sourceSessionFile)

  const fixed = SessionManager.create(fixedProjectDir)
  fixed.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '这是固定参考窗口。' }],
    timestamp
  })
  fixed.appendMessage(assistant('固定窗口不会被其他列的分支选择器覆盖。', timestamp + 1))
  fixedSessionId = fixed.getSessionId()

  await writeFile(
    workSessionStorePath,
    `${JSON.stringify(
      {
        workSessions: [
          { workId: fixedWorkId, cwd: fixedProjectDir, sessionId: fixedSessionId },
          { workId: sourceWorkId, cwd: sourceProjectDir, sessionId: sourceSessionId }
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
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '8234c5f0-78ef-49e1-bcb9-0920d76c8c26' },
      body: JSON.stringify({ password: ${JSON.stringify(password)} })
    }).then(async response => ({ ok: response.ok, body: await response.json() }))`
  )
  assert.equal(login.ok, true, login.body?.msg)
  await setPrimary(client, sourceWorkId)
  await evaluate(client, `localStorage.setItem('pi-desk:new-work-session-behavior', 'activate')`)
}

async function setPrimary(client, workId) {
  await evaluate(
    client,
    `localStorage.setItem('pi-desk:workbench-layout', JSON.stringify({ primaryWorkId: ${JSON.stringify(workId)} }))`
  )
}

async function waitForWorkbench(client, workId = sourceWorkId) {
  await waitFor(
    client,
    `document.querySelector('[data-work-id=${JSON.stringify(workId)}] textarea') !== null`,
    `工作会话加载：${workId}`,
    () => serverOutput,
    60_000
  )
}

async function openPicker(client, workId = sourceWorkId) {
  await waitFor(
    client,
    `document.querySelector('[data-work-id=${JSON.stringify(workId)}] [aria-label="更多操作"]') !== null`,
    '输入框更多菜单可用',
    () => serverOutput
  )
  const menuOpened = await evaluate(
    client,
    `(() => {
      const column = document.querySelector('[data-work-id=${JSON.stringify(workId)}]');
      const button = column?.querySelector('[aria-label="更多操作"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(menuOpened, true, '未找到当前列更多按钮')
  await waitFor(
    client,
    `(() => {
      const item = document.querySelector('[data-slot="dropdown-menu-content"] [aria-label="切换会话分支"]');
      return item instanceof HTMLElement && item.getAttribute('data-disabled') === null;
    })()`,
    '更多菜单中的会话分支入口可用',
    () => serverOutput
  )
  const opened = await evaluate(
    client,
    `(() => {
      const item = document.querySelector('[data-slot="dropdown-menu-content"] [aria-label="切换会话分支"]');
      if (!(item instanceof HTMLElement)) return false;
      item.click();
      return true;
    })()`
  )
  assert.equal(opened, true, '未找到更多菜单中的会话分支入口')
  await waitFor(
    client,
    `(() => {
      const panel = document.querySelector('[data-work-id=${JSON.stringify(workId)}] [aria-label="会话分支选择器"]');
      return panel?.querySelectorAll('[role="treeitem"]').length > 0;
    })()`,
    '当前列会话树面板',
    () => serverOutput
  )
}

async function selectTreeNode(client, preview) {
  const searched = await evaluate(
    client,
    `(() => {
      const input = document.querySelector('[aria-label="会话分支选择器"] [aria-label="搜索会话分支"]');
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(preview)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  )
  assert.equal(searched, true)
  await waitFor(
    client,
    `(() => {
      const panel = document.querySelector('[aria-label="会话分支选择器"]');
      return [...(panel?.querySelectorAll('[role="treeitem"]') ?? [])].some((item) => item.textContent?.includes(${JSON.stringify(preview)}));
    })()`,
    `搜索树节点：${preview}`
  )
  const selected = await evaluate(
    client,
    `(() => {
      const panel = document.querySelector('[aria-label="会话分支选择器"]');
      const row = [...(panel?.querySelectorAll('[role="treeitem"]') ?? [])].find((item) => item.textContent?.includes(${JSON.stringify(preview)}));
      const button = row?.querySelector('button[tabindex]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(selected, true, `未找到树节点：${preview}`)
  await waitFor(
    client,
    `(() => {
      const panel = document.querySelector('[aria-label="会话分支选择器"]');
      return [...(panel?.querySelectorAll('[role="treeitem"]') ?? [])].some((item) => item.getAttribute('aria-selected') === 'true' && item.textContent?.includes(${JSON.stringify(preview)}));
    })()`,
    `选中树节点：${preview}`
  )
}

async function clearTreeSearch(client, selectedPreview) {
  const cleared = await evaluate(
    client,
    `(() => {
      const input = document.querySelector('[aria-label="会话分支选择器"] [aria-label="搜索会话分支"]');
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  )
  assert.equal(cleared, true)
  await waitFor(
    client,
    `(() => {
      const panel = document.querySelector('[aria-label="会话分支选择器"]');
      return [...(panel?.querySelectorAll('[role="treeitem"]') ?? [])].some((item) => item.getAttribute('aria-selected') === 'true' && item.textContent?.includes(${JSON.stringify(selectedPreview)}));
    })()`,
    `清空搜索后保持选中：${selectedPreview}`
  )
}

async function chooseTreeFilter(client, label) {
  const opened = await evaluate(
    client,
    `(() => {
      const trigger = document.querySelector('[aria-label="会话分支选择器"] [aria-label^="过滤会话树"]');
      if (!(trigger instanceof HTMLElement)) return false;
      trigger.click();
      return true;
    })()`
  )
  assert.equal(opened, true)
  await waitFor(
    client,
    `document.querySelector('[data-workbench-branch-picker-popup="true"]')?.textContent?.includes(${JSON.stringify(label)}) ?? false`,
    `打开筛选菜单：${label}`
  )
  const selected = await evaluate(
    client,
    `(() => {
      const popup = document.querySelector('[data-workbench-branch-picker-popup="true"]');
      const item = [...(popup?.querySelectorAll('[data-slot="dropdown-menu-item"]') ?? [])].find((candidate) => candidate.textContent?.trim().startsWith(${JSON.stringify(label)}));
      if (!(item instanceof HTMLElement)) return false;
      item.click();
      return true;
    })()`
  )
  assert.equal(selected, true)
  await waitFor(
    client,
    `(() => {
      const input = document.querySelector('[aria-label="会话分支选择器"] [aria-label="搜索会话分支"]');
      const trigger = document.querySelector('[aria-label="会话分支选择器"] [aria-label^="过滤会话树"]');
      return document.activeElement === input && trigger?.textContent?.includes(${JSON.stringify(label)});
    })()`,
    `筛选完成并恢复搜索焦点：${label}`
  )
}

async function prepareVisualCapture(client) {
  await waitFor(
    client,
    `(() => {
      const bodyBusy = document.body.innerText.includes('Compiling...');
      const portalBusy = [...document.querySelectorAll('nextjs-portal')].some((portal) => portal.shadowRoot?.textContent?.includes('Compiling'));
      return !bodyBusy && !portalBusy;
    })()`,
    'Next 开发编译完成',
    () => serverOutput,
    60_000
  )
  await evaluate(
    client,
    `(() => {
      for (const portal of document.querySelectorAll('nextjs-portal')) {
        if (portal instanceof HTMLElement) portal.style.display = 'none';
      }
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
    })()`
  )
}

async function clickRowAction(client, preview, ariaLabel) {
  const clicked = await evaluate(
    client,
    `(() => {
      const panel = document.querySelector('[aria-label="会话分支选择器"]');
      const row = [...(panel?.querySelectorAll('[role="treeitem"]') ?? [])].find((item) => item.textContent?.includes(${JSON.stringify(preview)}));
      const action = [...(row?.querySelectorAll('button') ?? [])].find((button) => button.getAttribute('aria-label') === ${JSON.stringify(ariaLabel)});
      if (!(action instanceof HTMLElement)) return false;
      action.click();
      return true;
    })()`
  )
  assert.equal(clicked, true, `未找到节点操作：${ariaLabel}`)
}

async function dispatchFocusedWindowEscape(client, workId) {
  const dispatched = await evaluate(
    client,
    `(() => {
      const workSessionWindow = document.querySelector('[data-work-id=${JSON.stringify(workId)}]');
      if (!(workSessionWindow instanceof HTMLElement)) return false;
      workSessionWindow.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      for (let index = 0; index < 2; index += 1) {
        workSessionWindow.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true
        }));
      }
      return true;
    })()`
  )
  assert.equal(dispatched, true)
}

async function dispatchSearchKey(client, key, shiftKey = false) {
  const dispatched = await evaluate(
    client,
    `(() => {
      const input = document.querySelector('[aria-label="会话分支选择器"] [aria-label="搜索会话分支"]');
      if (!(input instanceof HTMLInputElement)) return false;
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        shiftKey: ${JSON.stringify(shiftKey)},
        bubbles: true,
        cancelable: true
      }));
      return true;
    })()`
  )
  assert.equal(dispatched, true)
}

async function dispatchSelectedEnter(client, preview) {
  const selected = await evaluate(
    client,
    `(() => [...document.querySelectorAll('[aria-label="会话分支选择器"] [role="treeitem"]')].some((item) => item.getAttribute('aria-selected') === 'true' && item.textContent?.includes(${JSON.stringify(preview)})))()`
  )
  assert.equal(selected, true)
  await dispatchSearchKey(client, 'Enter')
}

async function executeNativeCommand(client, workId, command) {
  const response = await evaluate(
    client,
    `(async () => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(
        protocol + '//' + location.host + '/api/ws?clientId=' + crypto.randomUUID(),
        'pi-desk.v1'
      );
      const request = (path, body = {}) => new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timeout = setTimeout(() => {
          socket.removeEventListener('message', onMessage);
          reject(new Error('WebSocket 请求超时：' + path));
        }, 10000);
        const onMessage = (event) => {
          const message = JSON.parse(String(event.data));
          if (message.head?.op !== 'resp' || message.head.requestId !== requestId) return;
          clearTimeout(timeout);
          socket.removeEventListener('message', onMessage);
          resolve(message.body);
        };
        socket.addEventListener('message', onMessage);
        socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }));
      });
      try {
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true });
          socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), {
            once: true
          });
        });
        const list = await request('work-sessions/list');
        const workSession = list.data?.workSessions?.find((item) => item.workId === ${JSON.stringify(workId)});
        if (!workSession) return { code: 404, msg: '测试工作会话不存在', data: null };
        return await request('pi/commands/execute', {
          source: {
            workId: workSession.workId,
            sessionId: workSession.sessionId,
            branchId: workSession.branchId
          },
          command: ${JSON.stringify(command)}
        });
      } finally {
        socket.close();
      }
    })()`
  )
  assert.deepEqual(response, { code: 0, msg: '', data: {} })
}

async function readStore() {
  return JSON.parse(await readFile(workSessionStorePath, 'utf8'))
}

async function verifySessionPath(sessionId, expectedMessageIds, expectedParentSession) {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const sessions = await SessionManager.list(sourceProjectDir)
  const info = sessions.find((session) => session.id === sessionId)
  assert.ok(info, `未找到新 Pi session：${sessionId}`)
  const manager = SessionManager.open(info.path)
  assert.equal(manager.getHeader()?.parentSession, expectedParentSession)
  assert.deepEqual(messageIds(manager.getEntries()), expectedMessageIds)
}

async function primaryWorkId(client) {
  return evaluate(
    client,
    `document.querySelector('#work-session-columns [data-work-id]')?.getAttribute('data-work-id') ?? null`
  )
}

async function main() {
  let client
  try {
    await createFixture()
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

    browserProcess = spawnEdge(edgePath, cdpPort, join(testRoot, 'edge-profile'), '1440,900')
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge CDP')
    client = await createCdpPage(cdpPort)
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    await setViewport(client, 1440, 900, false)
    await loginAndPrepare(client)
    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitForWorkbench(client)
    await waitFor(
      client,
      `document.querySelector('[data-work-id=${JSON.stringify(fixedWorkId)}]')?.textContent?.includes('固定窗口不会被其他列的分支选择器覆盖。') ?? false`,
      '固定参考列聊天同步',
      () => serverOutput,
      60_000
    )

    await openPicker(client)
    await waitFor(
      client,
      `document.activeElement?.getAttribute('aria-label') === '搜索会话分支'`,
      '会话树默认聚焦搜索框'
    )
    const density = await evaluate(
      client,
      `(() => {
        const panel = document.querySelector('[data-work-id=${JSON.stringify(sourceWorkId)}] [aria-label="会话分支选择器"]');
        const fixedPanel = document.querySelector('[data-work-id=${JSON.stringify(fixedWorkId)}] [aria-label="会话分支选择器"]');
        const tree = panel?.querySelector('[role="tree"]');
        const rows = [...(tree?.querySelectorAll('[role="treeitem"]') ?? [])];
        const heights = rows.map((row) => row.getBoundingClientRect().height);
        const foldButtons = tree?.querySelectorAll('[aria-label="收起分支"], [aria-label="展开分支"]').length ?? 0;
        return {
          scoped: panel !== null && fixedPanel === null,
          renderedRows: rows.length,
          viewportRows: tree ? tree.clientHeight / 28 : 0,
          maxRowHeight: heights.length ? Math.max(...heights) : 0,
          foldButtons,
          treeIcons: tree?.querySelectorAll('svg').length ?? 0
        };
      })()`
    )
    assert.equal(density.scoped, true)
    assert.ok(density.renderedRows >= 16, `桌面渲染行数过少：${density.renderedRows}`)
    assert.ok(density.viewportRows >= 14, `桌面可见行数过少：${density.viewportRows}`)
    assert.ok(density.maxRowHeight <= 29, `桌面行高过大：${density.maxRowHeight}`)
    assert.ok(density.foldButtons >= 1, '真实分支段应提供折叠按钮')
    assert.ok(
      density.foldButtons < density.renderedRows / 4,
      `折叠按钮过多：${density.foldButtons}/${density.renderedRows}`
    )
    assert.equal(density.treeIcons, density.foldButtons, '树行只应为真实折叠点保留图标')

    await chooseTreeFilter(client, '无工具')
    const beforeKeyboardSelection = await evaluate(
      client,
      `document.querySelector('[aria-label="搜索会话分支"]')?.getAttribute('aria-activedescendant')`
    )
    await dispatchSearchKey(client, 'ArrowUp')
    await waitFor(
      client,
      `document.querySelector('[aria-label="搜索会话分支"]')?.getAttribute('aria-activedescendant') !== ${JSON.stringify(beforeKeyboardSelection)}`,
      '筛选后方向键继续选择'
    )
    await dispatchSearchKey(client, 'Tab')
    await waitFor(
      client,
      `(() => {
        const input = document.querySelector('[aria-label="搜索会话分支"]');
        const trigger = document.querySelector('[aria-label^="过滤会话树"]');
        return document.activeElement === input && trigger?.textContent?.includes('仅用户');
      })()`,
      'Tab 切换筛选并保持搜索焦点'
    )
    await dispatchSearchKey(client, 'Tab', true)
    await waitFor(
      client,
      `document.querySelector('[aria-label^="过滤会话树"]')?.textContent?.includes('无工具') ?? false`,
      'Shift+Tab 反向切换筛选'
    )
    await chooseTreeFilter(client, '默认')

    await selectTreeNode(client, 'read: src/example-12.ts')
    await waitFor(
      client,
      `(() => {
        const panel = document.querySelector('[aria-label="会话分支选择器"]');
        const text = panel?.textContent ?? '';
        return text.includes('工具：read') &&
          text.includes('目的：验证工具调用参数展示') &&
          text.includes('调用：src/example-12.ts') &&
          text.includes('范围/变化：12-31') &&
          !text.includes('src/example-12.ts 已读取完成');
      })()`,
      '工具节点展示调用参数而非返回结果',
      () => serverOutput
    )
    await clearTreeSearch(client, 'read: src/example-12.ts')
    await prepareVisualCapture(client)
    const desktopScreenshot = await screenshot(client)

    const outsideClosed = await evaluate(
      client,
      `(() => {
        const textarea = document.querySelector('[data-work-id=${JSON.stringify(fixedWorkId)}] textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) return false;
        textarea.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        textarea.focus();
        return true;
      })()`
    )
    assert.equal(outsideClosed, true)
    await waitFor(
      client,
      `document.querySelector('[aria-label="会话分支选择器"]') === null && document.activeElement === document.querySelector('[data-work-id=${JSON.stringify(fixedWorkId)}] textarea')`,
      '点击其他窗口关闭选择器且保留目标焦点'
    )
    await dispatchFocusedWindowEscape(client, fixedWorkId)
    await waitFor(
      client,
      `document.querySelector('[data-work-id=${JSON.stringify(fixedWorkId)}] [aria-label="会话分支选择器"]') !== null`,
      '固定窗口非输入框焦点双击 Esc 打开会话分支',
      () => serverOutput
    )
    await dispatchSearchKey(client, 'Escape')
    await waitFor(
      client,
      `document.querySelector('[aria-label="会话分支选择器"]') === null`,
      'Esc 关闭通过快捷键打开的会话分支'
    )
    await openPicker(client)

    await selectTreeNode(client, '旧分支回答 2')
    const mockedBranchFailure = await evaluate(
      client,
      `(() => {
        const originalFetch = window.fetch.bind(window);
        let handled = false;
        window.fetch = (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          if (!handled && url.includes('/api/work-sessions/branch')) {
            handled = true;
            window.fetch = originalFetch;
            return Promise.resolve(new Response(
              JSON.stringify({ code: 500, msg: '测试分支操作失败', data: null }),
              { status: 500, headers: { 'Content-Type': 'application/json' } }
            ));
          }
          return originalFetch(input, init);
        };
        return true;
      })()`
    )
    assert.equal(mockedBranchFailure, true)
    await dispatchSelectedEnter(client, '旧分支回答 2')
    await waitFor(
      client,
      `document.querySelector('[data-pi-desk-toast="error"]')?.textContent?.includes('测试分支操作失败') ?? false`,
      '分支失败 Toast 出现'
    )
    const persistentBranchError = await evaluate(
      client,
      `document.querySelector('[aria-label="会话分支选择器"] [role="alert"]')?.textContent?.includes('测试分支操作失败') ?? false`
    )
    assert.equal(persistentBranchError, false, '分支操作错误不应写入持久错误横幅')
    await waitFor(
      client,
      `document.querySelector('[data-pi-desk-toast="error"]') === null && document.querySelector('[aria-label="会话分支选择器"]') !== null`,
      '分支失败 Toast 自动清理',
      () => serverOutput,
      8_000
    )

    await selectTreeNode(client, '请从这里 Fork')
    await waitFor(
      client,
      `document.activeElement?.getAttribute('aria-label') === '搜索会话分支'`,
      '点击树行后搜索框继续持有焦点'
    )
    await waitFor(
      client,
      `document.querySelector('[aria-label="会话分支选择器"]')?.textContent?.includes('保留这条用户输入，并允许我继续编辑。') ?? false`,
      '桌面完整用户消息详情',
      () => serverOutput
    )
    await clickRowAction(client, '请从这里 Fork', '从这条用户消息新开会话')
    await waitFor(
      client,
      `(() => {
        const rows = document.querySelectorAll('[data-testid^="work-session-row-"]');
        const primary = document.querySelector('#work-session-columns [data-work-id]:not([data-work-id=${JSON.stringify(sourceWorkId)}]):not([data-work-id=${JSON.stringify(fixedWorkId)}])');
        const textarea = primary?.querySelector('textarea');
        return rows.length === 3 && textarea?.value === ${JSON.stringify(forkUserText)};
      })()`,
      '桌面 Fork 新会话并带入用户消息',
      () => serverOutput,
      30_000
    )
    let store = await readStore()
    assert.equal(
      store.workSessions.find((record) => record.workId === sourceWorkId)?.sessionId,
      sourceSessionId
    )
    const forkRecord = store.workSessions[1]
    assert.ok(forkRecord && forkRecord.workId !== fixedWorkId && forkRecord.workId !== sourceWorkId)
    await verifySessionPath(forkRecord.sessionId, forkExpectedMessageIds, sourceSessionFile)

    await setPrimary(client, sourceWorkId)
    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitForWorkbench(client)
    await openPicker(client)
    await selectTreeNode(client, '请把这条消息作为 Tree 用户节点')
    await dispatchSelectedEnter(client, '请把这条消息作为 Tree 用户节点')
    await waitFor(
      client,
      `(() => {
        const column = document.querySelector('[data-work-id=${JSON.stringify(sourceWorkId)}]');
        const textarea = column?.querySelector('textarea');
        return document.querySelector('[aria-label="会话分支选择器"]') === null && textarea?.value === ${JSON.stringify(treeUserText)};
      })()`,
      'Tree 用户消息切回父节点并回填输入框',
      () => serverOutput
    )
    store = await readStore()
    assert.equal(
      store.workSessions.find((record) => record.workId === sourceWorkId)?.sessionId,
      sourceSessionId
    )

    const cloneMenuOpened = await evaluate(
      client,
      `(() => {
        const column = document.querySelector('[data-work-id=${JSON.stringify(sourceWorkId)}]');
        const headerClone = column?.querySelector('header [aria-label="克隆当前会话"]');
        const more = column?.querySelector('[aria-label="更多操作"]');
        if (headerClone !== null || !(more instanceof HTMLElement)) return false;
        more.click();
        return true;
      })()`
    )
    assert.equal(cloneMenuOpened, true, '列头不应保留克隆入口，更多菜单必须可打开')
    await waitFor(
      client,
      `document.querySelector('[role="menu"] [aria-label="克隆当前会话"]') !== null`,
      '更多菜单显示克隆当前会话'
    )
    const cloneClicked = await evaluate(
      client,
      `(() => {
        const item = document.querySelector('[role="menu"] [aria-label="克隆当前会话"]');
        if (!(item instanceof HTMLElement)) return false;
        item.click();
        return true;
      })()`
    )
    assert.equal(cloneClicked, true)
    await waitFor(
      client,
      `(() => {
        const rows = document.querySelectorAll('[data-testid^="work-session-row-"]');
        const primary = document.querySelector('#work-session-columns [data-work-id]:not([data-work-id=${JSON.stringify(sourceWorkId)}]):not([data-work-id=${JSON.stringify(fixedWorkId)}])');
        const textarea = primary?.querySelector('textarea');
        return rows.length === 4 && textarea?.value === '';
      })()`,
      'Clone 当前活动路径并进入新会话',
      () => serverOutput,
      30_000
    )
    store = await readStore()
    const cloneRecord = store.workSessions[1]
    assert.ok(
      cloneRecord && cloneRecord.workId !== sourceWorkId && cloneRecord.workId !== fixedWorkId
    )
    await verifySessionPath(cloneRecord.sessionId, cloneExpectedMessageIds, sourceSessionFile)

    await setPrimary(client, sourceWorkId)
    await setViewport(client, 390, 844, true)
    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitForWorkbench(client)
    await openPicker(client)
    await selectTreeNode(client, '请从这里 Fork')
    await waitFor(
      client,
      `document.querySelector('[aria-label="会话分支选择器"]')?.textContent?.includes('保留这条用户输入，并允许我继续编辑。') ?? false`,
      '移动端单击消息查看详情',
      () => serverOutput
    )
    const mobileUserActions = await evaluate(
      client,
      `(() => {
        const panel = document.querySelector('[aria-label="会话分支选择器"]');
        const userRow = [...(panel?.querySelectorAll('[role="treeitem"]') ?? [])].find((item) => item.textContent?.includes('请从这里 Fork'));
        return {
          buttons: userRow?.querySelectorAll('button[aria-label]').length ?? 0,
          panelOpen: panel !== null,
          width: panel?.getBoundingClientRect().width ?? 0,
          viewportWidth: innerWidth
        };
      })()`
    )
    assert.equal(mobileUserActions.panelOpen, true)
    assert.ok(mobileUserActions.buttons >= 2)
    assert.equal(mobileUserActions.width, mobileUserActions.viewportWidth)

    await selectTreeNode(client, '旧分支回答 3')
    const mobileAssistantButtons = await evaluate(
      client,
      `(() => {
        const panel = document.querySelector('[aria-label="会话分支选择器"]');
        const row = [...(panel?.querySelectorAll('[role="treeitem"]') ?? [])].find((item) => item.textContent?.includes('旧分支回答 3'));
        return row?.querySelectorAll('button[aria-label]').length ?? 0;
      })()`
    )
    assert.ok(mobileAssistantButtons >= 1)
    await selectTreeNode(client, '请从这里 Fork')
    await clearTreeSearch(client, '请从这里 Fork')
    await prepareVisualCapture(client)
    const mobileScreenshot = await screenshot(client)

    await clickRowAction(client, '请从这里 Fork', '从这条用户消息新开会话')
    await waitFor(
      client,
      `(() => {
        const primary = document.querySelector('#work-session-columns [data-work-id]:not([data-work-id=${JSON.stringify(sourceWorkId)}]):not([data-work-id=${JSON.stringify(fixedWorkId)}])');
        return primary?.querySelector('textarea')?.value === ${JSON.stringify(forkUserText)};
      })()`,
      '移动端明确 Fork 按钮自动进入新会话',
      () => serverOutput,
      30_000
    )

    store = await readStore()
    assert.equal(store.workSessions.length, 5)
    assert.equal(
      store.workSessions.find((record) => record.workId === sourceWorkId)?.sessionId,
      sourceSessionId
    )
    const mobileForkRecord = store.workSessions[1]
    await verifySessionPath(mobileForkRecord.sessionId, forkExpectedMessageIds, sourceSessionFile)

    await setPrimary(client, sourceWorkId)
    await setViewport(client, 1440, 900, false)
    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitForWorkbench(client)
    const runtimeBranchLogStart = serverOutput.length
    await executeNativeCommand(client, sourceWorkId, 'append-branch-fixture')
    await waitFor(
      client,
      `(async () => {
        try {
          const response = await fetch('/api/work-session-tree/get', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'X-Pi-Desk-Client-Id': '8234c5f0-78ef-49e1-bcb9-0920d76c8c26'
            },
            body: JSON.stringify({
              workId: ${JSON.stringify(sourceWorkId)},
              sessionId: ${JSON.stringify(sourceSessionId)}
            })
          });
          const body = await response.json();
          return body.code === 0 && body.data?.nodes?.some((node) => node.preview === 'runtime-branch-node');
        } catch {
          return false;
        }
      })()`,
      '运行时追加分支节点进入会话树',
      () => serverOutput,
      30_000
    )
    await openPicker(client)
    await chooseTreeFilter(client, '全部')
    await selectTreeNode(client, 'runtime-branch-node')
    await dispatchSelectedEnter(client, 'runtime-branch-node')
    await waitFor(
      client,
      `document.querySelector('[aria-label="会话分支选择器"]') === null`,
      '切换到运行时追加的分支节点',
      () => serverOutput,
      30_000
    )
    const runtimeBranchLogs = serverOutput.slice(runtimeBranchLogStart)
    assert.doesNotMatch(runtimeBranchLogs, /增量同步 Pi 分支索引失败/)
    assert.doesNotMatch(runtimeBranchLogs, /Cannot append to missing Pi session parent/)

    const output = {
      generatedAt: new Date().toISOString(),
      sourceWorkId,
      sourceSessionId,
      forkWorkId: forkRecord.workId,
      cloneWorkId: cloneRecord.workId,
      mobileForkWorkId: mobileForkRecord.workId,
      runtimeBranchRecovered: true,
      finalPrimaryWorkId: await primaryWorkId(client),
      density,
      mobileActions: {
        userButtons: mobileUserActions.buttons,
        assistantButtons: mobileAssistantButtons,
        width: mobileUserActions.width,
        viewportWidth: mobileUserActions.viewportWidth
      }
    }
    await mkdir(dirname(resultPath), { recursive: true })
    await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
    await publishScreenshots([
      [desktopOutput, desktopScreenshot],
      [mobileOutput, mobileScreenshot]
    ])
    await Promise.all(obsoleteOutputs.map((path) => rm(path, { force: true })))
    console.log(JSON.stringify(output, null, 2))
    console.log(`desktop=${desktopOutput}`)
    console.log(`mobile=${mobileOutput}`)
  } finally {
    client?.close()
    await stopBrowserTree(browserProcess, cdpPort)
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
