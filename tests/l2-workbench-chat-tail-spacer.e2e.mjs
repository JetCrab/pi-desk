import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clickAriaLabel,
  clickText,
  createCdpPage,
  evaluate,
  navigate,
  reservePort,
  screenshot,
  setViewport,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'
import {
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const runRoot = join(
  projectRoot,
  'temp',
  'pi',
  'workbench-chat-tail-spacer-e2e',
  String(process.pid)
)
const agentDir = join(runRoot, 'agent')
const projectDir = join(runRoot, '尾部占位回归项目')
const shortProjectDir = join(runRoot, '短内容回归项目')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const outputPath = join(projectRoot, 'temp', '验收', '客户端_移动端', '聊天__尾部占位修复.png')
const shortOutputPath = join(projectRoot, 'temp', '验收', '客户端_移动端', '聊天__短内容无滚动.png')
const workId = 'tail-spacer-regression-work-session'
const shortWorkId = 'short-chat-regression-work-session'
const password = 'Qq.445566'
const finalMarker = '尾部占位回归通过。'
const shortMarker = '短内容保持静止。'
const usage = {
  input: 120,
  output: 80,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 200,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''

async function createFixture() {
  await prepareIsolatedPiDirectory(agentDir)
  await mkdir(projectDir, { recursive: true })
  await mkdir(shortProjectDir, { recursive: true })
  await mkdir(dirname(workSessionStorePath), { recursive: true })

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const shortManager = SessionManager.create(shortProjectDir)
  let timestamp = Date.now()

  shortManager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '给出一条简短回复。' }],
    timestamp: timestamp++
  })
  shortManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: shortMarker }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp++
  })
  shortManager.appendSessionInfo('短内容无滚动回归')

  const manager = SessionManager.create(projectDir)

  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '先建立一轮历史消息。' }],
    timestamp: timestamp++
  })
  const codeBlockHistory = [
    '历史消息已建立。',
    '',
    '```ts',
    'const shortBlock = true',
    '```',
    '',
    '```tsx',
    ...Array.from({ length: 12 }, (_, index) => `export const middleLine${index} = ${index}`),
    '```',
    '',
    '```json',
    ...Array.from({ length: 28 }, (_, index) => `  "item${index}": ${index},`),
    '```'
  ].join('\n')
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: codeBlockHistory }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp++
  })
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '执行完整检查并给出较长的最终结论。' }],
    timestamp: timestamp++
  })

  for (let index = 1; index <= 12; index += 1) {
    const toolCallId = `tail-spacer-read-${index}`
    manager.appendMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: `正在执行检查步骤 ${index}。` },
        {
          type: 'toolCall',
          id: toolCallId,
          name: 'read',
          arguments: {
            path: `src/example-${index}.ts`,
            reasoning: `检查步骤 ${index} 的实现边界`
          }
        }
      ],
      api: 'openai-responses',
      provider: 'test',
      model: 'test-model',
      usage,
      stopReason: 'toolUse',
      timestamp: timestamp++
    })
    manager.appendMessage({
      role: 'toolResult',
      toolCallId,
      toolName: 'read',
      content: [{ type: 'text', text: `检查步骤 ${index} 已完成。` }],
      isError: false,
      timestamp: timestamp++
    })
  }

  const conclusion = Array.from(
    { length: 32 },
    (_, index) =>
      `${index + 1}. 最终结论条目 ${index + 1}，用于保证折叠后的正文高度超过手机聊天视口。`
  ).join('\n\n')
  manager.appendMessage({
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: `## 最终检查结果\n\n${conclusion}\n\n**${finalMarker}**\n\n${codeBlockHistory}`
      }
    ],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp++
  })
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '等待下一步处理。' }],
    timestamp: timestamp++
  })
  manager.appendSessionInfo('手机端尾部占位回归')

  await writeFile(
    workSessionStorePath,
    `${JSON.stringify(
      {
        workSessions: [
          {
            workId: shortWorkId,
            cwd: shortProjectDir,
            sessionId: shortManager.getSessionId()
          },
          { workId, cwd: projectDir, sessionId: manager.getSessionId() }
        ],
        pinnedCount: 0
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

async function login(client) {
  await navigate(client, `http://127.0.0.1:${appPort}/login`)
  const result = await evaluate(
    client,
    `fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Pi-Desk-Client-Id': crypto.randomUUID()
      },
      body: JSON.stringify({ password: ${JSON.stringify(password)} })
    }).then(async response => ({ ok: response.ok, body: await response.json() }))`
  )
  assert.equal(result.ok, true, result.body?.msg)
  await evaluate(
    client,
    `localStorage.setItem('pi-desk:workbench-layout', JSON.stringify({ primaryWorkId: ${JSON.stringify(shortWorkId)} }))`
  )
}

async function dispatchMouseWheel(client, targetWorkId, deltaY) {
  const point = await evaluate(
    client,
    `(() => {
      const scroll = document.querySelector(${JSON.stringify(`section[data-work-id="${targetWorkId}"] .pi-desk-chat-conversation-scroll`)});
      if (!(scroll instanceof HTMLElement)) return null;
      const rect = scroll.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  )
  assert.ok(point, `未找到聊天滚动容器：${targetWorkId}`)
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY
  })
}

async function sampleScrollFrames(client, targetWorkId, frameCount = 32) {
  return evaluate(
    client,
    `(async () => {
      const scroll = document.querySelector(${JSON.stringify(`section[data-work-id="${targetWorkId}"] .pi-desk-chat-conversation-scroll`)});
      if (!(scroll instanceof HTMLElement)) return null;
      const samples = [];
      for (let frame = 0; frame < ${frameCount}; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        samples.push({ scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight });
      }
      return samples;
    })()`
  )
}

function tailMetricsExpression(targetWorkId = workId, markerText = finalMarker) {
  return `(() => {
    const section = document.querySelector(${JSON.stringify(`section[data-work-id="${targetWorkId}"]`)});
    const scroll = section?.querySelector('.pi-desk-chat-conversation-scroll');
    const turn = scroll?.querySelector('[data-chat-tail-space]') ?? [...(scroll?.querySelectorAll('[data-chat-turn]') ?? [])].at(-1);
    const user = turn?.querySelector('[data-chat-user-message]');
    const lastContent = turn?.lastElementChild;
    const marker = [...(section?.querySelectorAll('p, li, strong') ?? [])].find((element) => element.textContent?.includes(${JSON.stringify(markerText)}));
    if (!(scroll instanceof HTMLElement) || !(turn instanceof HTMLElement) || !(user instanceof HTMLElement) || !(lastContent instanceof HTMLElement)) return null;

    const scrollRect = scroll.getBoundingClientRect();
    const turnRect = turn.getBoundingClientRect();
    const userRect = user.getBoundingClientRect();
    const contentRect = lastContent.getBoundingClientRect();
    const markerRect = marker?.getBoundingClientRect() ?? null;
    return {
      scrollTop: scroll.scrollTop,
      clientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      overflowHeight: scroll.scrollHeight - scroll.clientHeight,
      distanceFromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      userTopOffset: userRect.top - scrollRect.top,
      turnMinHeight: turn.style.minHeight,
      tailSpace: Math.max(0, turnRect.bottom - contentRect.bottom),
      blankBelowLastContent: Math.max(0, scrollRect.bottom - contentRect.bottom),
      lastContentVisible: contentRect.bottom > scrollRect.top && contentRect.top < scrollRect.bottom,
      markerVisible: markerRect !== null && markerRect.bottom > scrollRect.top && markerRect.top < scrollRect.bottom,
      scrollRect: { top: scrollRect.top, bottom: scrollRect.bottom },
      contentRect: { top: contentRect.top, bottom: contentRect.bottom },
      markerRect: markerRect ? { top: markerRect.top, bottom: markerRect.bottom } : null
    };
  })()`
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

    browserProcess = spawnEdge(edgePath, cdpPort, join(runRoot, 'edge-profile'), '390,844')
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge CDP')
    client = await createCdpPage(cdpPort)
    await setViewport(client, 390, 844, true)
    await login(client)
    await navigate(client, `http://127.0.0.1:${appPort}/`)

    await waitFor(
      client,
      `document.querySelector(${JSON.stringify(`section[data-work-id="${shortWorkId}"]`)})?.innerText.includes(${JSON.stringify(shortMarker)}) === true`,
      '短内容回归会话加载',
      () => serverOutput
    )
    await evaluate(
      client,
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
    )
    const shortMetrics = await evaluate(client, tailMetricsExpression(shortWorkId, shortMarker))
    assert.ok(shortMetrics)
    assert.equal(shortMetrics.scrollTop, 0, JSON.stringify(shortMetrics))
    assert.equal(shortMetrics.overflowHeight, 0, JSON.stringify(shortMetrics))
    assert.ok(shortMetrics.tailSpace > 100, JSON.stringify(shortMetrics))
    assert.ok(Math.abs(shortMetrics.userTopOffset - 12) <= 1, JSON.stringify(shortMetrics))
    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach((element) => { element.style.display = 'none' })`
    )
    const shortScreenshot = await screenshot(client)

    await clickAriaLabel(client, '显示工作会话菜单')
    await waitFor(
      client,
      `document.body.innerText.includes('手机端尾部占位回归')`,
      '尾部占位会话菜单项',
      () => serverOutput
    )
    const initialLongPosition = await evaluate(
      client,
      `new Promise((resolve) => {
        let observer;
        const timeout = window.setTimeout(() => {
          observer?.disconnect();
          resolve(null);
        }, 5_000);
        const capture = () => {
          const section = document.querySelector(${JSON.stringify(`section[data-work-id="${workId}"]`)});
          const scroll = section?.querySelector('.pi-desk-chat-conversation-scroll');
          const users = scroll?.querySelectorAll('[data-chat-user-message]');
          const user = users?.item((users?.length ?? 0) - 1);
          if (!(scroll instanceof HTMLElement) || !(user instanceof HTMLElement)) return false;
          const scrollRect = scroll.getBoundingClientRect();
          const userRect = user.getBoundingClientRect();
          window.clearTimeout(timeout);
          observer?.disconnect();
          resolve({
            scrollTop: scroll.scrollTop,
            distanceFromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
            userTopOffset: userRect.top - scrollRect.top
          });
          return true;
        };
        observer = new MutationObserver(capture);
        observer.observe(document.body, { childList: true, subtree: true });
        const target = [...document.querySelectorAll('button, [role="button"]')]
          .reverse()
          .find((element) => element.textContent?.includes('手机端尾部占位回归'));
        if (!target) {
          window.clearTimeout(timeout);
          observer.disconnect();
          resolve(null);
          return;
        }
        target.click();
        capture();
      })`
    )
    assert.ok(initialLongPosition)
    assert.ok(initialLongPosition.scrollTop > 100, JSON.stringify(initialLongPosition))
    assert.ok(
      Math.abs(initialLongPosition.userTopOffset - 12) <= 2,
      JSON.stringify(initialLongPosition)
    )
    await waitFor(
      client,
      `document.querySelector(${JSON.stringify(`section[data-work-id="${workId}"]`)})?.innerText.includes(${JSON.stringify(finalMarker)}) === true`,
      '尾部占位回归会话加载',
      () => serverOutput
    )
    await waitFor(
      client,
      `[...document.querySelectorAll('button')].some((button) => button.textContent?.includes('处理过程 · 12 次工具调用') && button.getAttribute('aria-expanded') === 'false')`,
      '处理过程默认折叠',
      () => serverOutput
    )

    await waitFor(
      client,
      `(() => {
        const metrics = ${tailMetricsExpression()};
        return metrics !== null && metrics.distanceFromBottom <= 2 && metrics.tailSpace > 100;
      })()`,
      '尾部占位物理底部稳定',
      () => serverOutput
    )
    await dispatchMouseWheel(client, workId, -1)
    await waitFor(
      client,
      `document.querySelector('[aria-label="回到聊天底部"]') !== null`,
      '物理底部导航按钮出现',
      () => serverOutput
    )
    const spacerBottomBeforeClick = await evaluate(
      client,
      `(() => {
        const section = document.querySelector(${JSON.stringify(`section[data-work-id="${workId}"]`)});
        const scroll = section?.querySelector('.pi-desk-chat-conversation-scroll');
        const button = section?.querySelector('[aria-label="回到聊天底部"]');
        const tail = section?.querySelector('[data-chat-tail-space]');
        const lastContent = tail?.lastElementChild;
        if (!(scroll instanceof HTMLElement) || !(button instanceof HTMLButtonElement) || !(tail instanceof HTMLElement) || !(lastContent instanceof HTMLElement)) return null;
        return {
          buttonDisabled: button.disabled,
          scrollHeight: scroll.scrollHeight,
          distanceFromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
          tailSpace: Math.max(0, tail.getBoundingClientRect().bottom - lastContent.getBoundingClientRect().bottom)
        };
      })()`
    )
    assert.ok(spacerBottomBeforeClick)
    assert.equal(
      spacerBottomBeforeClick.buttonDisabled,
      true,
      JSON.stringify(spacerBottomBeforeClick)
    )
    assert.ok(
      spacerBottomBeforeClick.distanceFromBottom <= 2,
      JSON.stringify(spacerBottomBeforeClick)
    )
    assert.ok(spacerBottomBeforeClick.tailSpace > 100, JSON.stringify(spacerBottomBeforeClick))
    const spacerBottomAfterClick = await evaluate(
      client,
      `(async () => {
        const section = document.querySelector(${JSON.stringify(`section[data-work-id="${workId}"]`)});
        const scroll = section?.querySelector('.pi-desk-chat-conversation-scroll');
        const button = section?.querySelector('[aria-label="回到聊天底部"]');
        const tail = section?.querySelector('[data-chat-tail-space]');
        const lastContent = tail?.lastElementChild;
        if (!(scroll instanceof HTMLElement) || !(button instanceof HTMLButtonElement) || !(tail instanceof HTMLElement) || !(lastContent instanceof HTMLElement)) return null;
        button.click();
        const samples = [];
        for (let index = 0; index < 4; index += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          samples.push({
            scrollHeight: scroll.scrollHeight,
            distanceFromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
            tailSpace: Math.max(0, tail.getBoundingClientRect().bottom - lastContent.getBoundingClientRect().bottom)
          });
        }
        return samples;
      })()`
    )
    assert.ok(spacerBottomAfterClick)
    assert.ok(
      spacerBottomAfterClick.every(
        (sample) => sample.distanceFromBottom <= 2 && sample.tailSpace > 100
      ),
      JSON.stringify(spacerBottomAfterClick)
    )
    assert.ok(
      spacerBottomAfterClick.every(
        (sample) => sample.scrollHeight === spacerBottomBeforeClick.scrollHeight
      ),
      JSON.stringify({ spacerBottomBeforeClick, spacerBottomAfterClick })
    )

    await dispatchMouseWheel(client, workId, -120)
    const firstScrollSamples = await sampleScrollFrames(client, workId)
    assert.ok(firstScrollSamples)
    const scrollHeights = firstScrollSamples.map((sample) => sample.scrollHeight)
    assert.ok(
      Math.max(...scrollHeights) - Math.min(...scrollHeights) <= 2,
      `首次真实上滚后 scrollHeight 不稳定：${JSON.stringify(firstScrollSamples)}`
    )
    const scrollTops = firstScrollSamples.map((sample) => sample.scrollTop)
    const minimumTopIndex = scrollTops.indexOf(Math.min(...scrollTops))
    assert.ok(
      Math.max(...scrollTops.slice(minimumTopIndex)) - scrollTops[minimumTopIndex] <= 2,
      `首次真实上滚发生反向 rebound：${JSON.stringify(firstScrollSamples)}`
    )
    await waitFor(
      client,
      `document.querySelector('[aria-label="定位到上一条用户消息"]') !== null`,
      '上一条用户消息导航',
      () => serverOutput
    )
    const codeBlockHeights = await evaluate(
      client,
      `(() => [...document.querySelectorAll(${JSON.stringify(`section[data-work-id="${workId}"] [data-streamdown="code-block"]`)})]
        .map((element) => element.getBoundingClientRect().height)
        .filter((height) => height > 0))()`
    )
    assert.ok(codeBlockHeights.length >= 3, JSON.stringify(codeBlockHeights))
    assert.ok(
      Math.max(...codeBlockHeights) - Math.min(...codeBlockHeights) >= 100,
      JSON.stringify(codeBlockHeights)
    )
    await clickAriaLabel(client, '定位到上一条用户消息')
    await waitFor(
      client,
      `document.querySelector('[aria-label="定位到下一条用户消息"]') !== null`,
      '下一条用户消息导航',
      () => serverOutput
    )
    await clickAriaLabel(client, '定位到下一条用户消息')
    await waitFor(
      client,
      `document.querySelector('[aria-label="回到聊天底部"]') !== null`,
      '回到底部导航',
      () => serverOutput
    )
    const bottomNavigationSamples = await evaluate(
      client,
      `(async () => {
        const section = document.querySelector(${JSON.stringify(`section[data-work-id="${workId}"]`)});
        const scroll = section?.querySelector('.pi-desk-chat-conversation-scroll');
        const button = section?.querySelector('[aria-label="回到聊天底部"]');
        if (!(scroll instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) return null;
        const capture = () => ({
          scrollTop: scroll.scrollTop,
          distanceFromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight
        });
        const samples = [capture()];
        button.click();
        for (let index = 0; index < 4; index += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          samples.push(capture());
        }
        return samples;
      })()`
    )
    assert.ok(bottomNavigationSamples)
    assert.ok(
      bottomNavigationSamples.every((sample) => sample.distanceFromBottom <= 2),
      JSON.stringify(bottomNavigationSamples)
    )

    await dispatchMouseWheel(client, workId, -120)
    await waitFor(
      client,
      `document.querySelector('[aria-label="定位到上一条用户消息"]') !== null`,
      '恢复尾部锚点导航',
      () => serverOutput
    )
    await clickAriaLabel(client, '定位到上一条用户消息')
    await waitFor(
      client,
      `document.querySelector(${JSON.stringify(`section[data-work-id="${workId}"] [data-chat-tail-space]`)}) !== null`,
      '恢复尾部锚点',
      () => serverOutput
    )

    await clickText(client, '处理过程 · 12 次工具调用')
    await waitFor(
      client,
      `[...document.querySelectorAll('button')].some((button) => button.textContent?.includes('处理过程 · 12 次工具调用') && button.getAttribute('aria-expanded') === 'true')`,
      '处理过程展开',
      () => serverOutput
    )
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      '展开动画完成',
      () => serverOutput
    )

    // 模拟手机浏览器工具栏引起的视口变化，使占位按展开后的自然高度重新计算。
    await setViewport(client, 390, 843, true)
    await evaluate(
      client,
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
    )
    const expandedMetrics = await evaluate(client, tailMetricsExpression())
    assert.ok(expandedMetrics)

    await clickText(client, '处理过程 · 12 次工具调用')
    await waitFor(
      client,
      `[...document.querySelectorAll('button')].some((button) => button.textContent?.includes('处理过程 · 12 次工具调用') && button.getAttribute('aria-expanded') === 'false')`,
      '处理过程收起',
      () => serverOutput
    )
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      '收起动画完成',
      () => serverOutput
    )
    await evaluate(
      client,
      `(() => {
        const scroll = document.querySelector(${JSON.stringify(`section[data-work-id="${workId}"] .pi-desk-chat-conversation-scroll`)});
        if (!(scroll instanceof HTMLElement)) return false;
        scroll.scrollTop = scroll.scrollHeight;
        return true;
      })()`
    )
    await evaluate(
      client,
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
    )

    const collapsedMetrics = await evaluate(client, tailMetricsExpression())
    assert.ok(collapsedMetrics)
    assert.ok(collapsedMetrics.distanceFromBottom <= 2, JSON.stringify(collapsedMetrics))
    assert.ok(collapsedMetrics.tailSpace <= 2, JSON.stringify(collapsedMetrics))
    assert.ok(collapsedMetrics.blankBelowLastContent <= 24, JSON.stringify(collapsedMetrics))
    assert.equal(collapsedMetrics.lastContentVisible, true, JSON.stringify(collapsedMetrics))

    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach((element) => { element.style.display = 'none' })`
    )
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(shortOutputPath, shortScreenshot)
    await writeFile(outputPath, await screenshot(client))
    console.log(
      JSON.stringify(
        {
          outputPath,
          shortOutputPath,
          shortMetrics,
          initialLongPosition,
          spacerBottomBeforeClick,
          spacerBottomAfterClick,
          firstScrollSamples,
          codeBlockHeights,
          bottomNavigationSamples,
          expandedMetrics,
          collapsedMetrics
        },
        null,
        2
      )
    )
  } finally {
    client?.close()
    await stopBrowserTree(browserProcess, cdpPort)
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await rm(runRoot, { recursive: true, force: true })
  }
}

await main()
