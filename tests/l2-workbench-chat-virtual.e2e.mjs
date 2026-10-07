import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clickAriaLabel,
  createCdpPage,
  evaluate,
  navigate,
  reservePort,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const runRoot = join(projectRoot, 'temp', 'pi', 'workbench-chat-virtual-e2e', String(process.pid))
const agentDir = join(runRoot, 'agent')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const resultPath = join(projectRoot, 'temp', 'pi', 'virtual-list-evaluation', 'integration.json')
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

async function createSession(SessionManager, cwd, title, count, prefix) {
  await mkdir(cwd, { recursive: true })
  const manager = SessionManager.create(cwd)
  const timestamp = Date.now()
  for (let index = 0; index < count; index += 1) {
    manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: `${prefix} ${index} 用户` }],
      timestamp: timestamp + index * 2
    })
    manager.appendMessage({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `${prefix} ${index} 回答\n\n${'动态高度内容。'.repeat(1 + (index % 6))}`
        }
      ],
      api: 'openai-responses',
      provider: 'test',
      model: 'test-model',
      usage,
      stopReason: 'stop',
      timestamp: timestamp + index * 2 + 1
    })
  }
  manager.appendSessionInfo(title)
  return manager.getSessionId()
}

async function createFixture() {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(dirname(workSessionStorePath), { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const largeCwd = join(runRoot, '超长会话项目')
  const smallCwd = join(runRoot, '短会话项目')
  const largeSessionId = await createSession(
    SessionManager,
    largeCwd,
    '超长会话 1200 轮',
    1_200,
    '长会话'
  )
  const smallSessionId = await createSession(SessionManager, smallCwd, '短会话 5 轮', 5, '短会话')
  await writeFile(
    workSessionStorePath,
    `${JSON.stringify(
      {
        workSessions: [
          { workId: 'virtual-large', cwd: largeCwd, sessionId: largeSessionId },
          { workId: 'virtual-small', cwd: smallCwd, sessionId: smallSessionId }
        ],
        pinnedCount: 0
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

async function clickAndMeasure(client, label, expectedText) {
  const startedAt = await evaluate(
    client,
    `(() => {
      const target = [...document.querySelectorAll('button, [role="button"]')].reverse().find((element) => element.textContent?.trim().includes(${JSON.stringify(label)}));
      if (!target) return null;
      const startedAt = performance.now();
      target.click();
      return startedAt;
    })()`
  )
  assert.notEqual(startedAt, null, `未找到会话：${label}`)
  await waitFor(
    client,
    `document.body.innerText.includes(${JSON.stringify(expectedText)})`,
    expectedText,
    undefined,
    30_000
  )
  return (await evaluate(client, `performance.now()`)) - startedAt
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

    browserProcess = spawnEdge(edgePath, cdpPort, join(runRoot, 'edge-profile'), '1440,900')
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge CDP')
    client = await createCdpPage(cdpPort)
    await navigate(client, `http://127.0.0.1:${appPort}/login`)
    const login = await evaluate(
      client,
      `fetch('/api/auth/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': 'a5b2de5f-1203-45d4-a293-330ca155b68c' },
        body: JSON.stringify({ password: ${JSON.stringify(password)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(login.ok, true, login.body?.msg)

    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitFor(client, `document.body.innerText.includes('超长会话 1200 轮')`, '会话列表')
    const firstLargeSwitchMs = await clickAndMeasure(client, '超长会话 1200 轮', '长会话 1199 用户')
    const initialMetrics = await evaluate(
      client,
      `(() => ({
        renderedTurns: document.querySelectorAll('[data-chat-turn]').length,
        domNodes: document.querySelectorAll('*').length,
        heapMb: performance.memory ? performance.memory.usedJSHeapSize / 1024 / 1024 : null
      }))()`
    )
    assert.ok(
      initialMetrics.renderedTurns <= 30,
      `初始虚拟 Turn 过多：${initialMetrics.renderedTurns}`
    )
    assert.ok(initialMetrics.domNodes < 3_000, `初始 DOM 过多：${initialMetrics.domNodes}`)
    await waitFor(
      client,
      `(() => {
        const scroll = document.querySelector('.pi-desk-chat-conversation-scroll');
        const users = scroll?.querySelectorAll('[data-chat-user-message]');
        const user = users?.item((users?.length ?? 0) - 1);
        if (!(scroll instanceof HTMLElement) || !(user instanceof HTMLElement)) return false;
        return Math.abs(user.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12) <= 2;
      })()`,
      '最新用户消息首次定位'
    )

    const scrollReady = await evaluate(
      client,
      `(() => {
        const scroll = document.querySelector('.pi-desk-chat-conversation-scroll');
        if (!(scroll instanceof HTMLElement)) return false;
        scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
        return true;
      })()`
    )
    assert.equal(scrollReady, true)
    await waitFor(
      client,
      `document.querySelector('[aria-label="定位到上一条用户消息"]') !== null`,
      '上一条用户消息导航'
    )
    const previousNavigation = await evaluate(
      client,
      `(async () => {
        const scroll = document.querySelector('.pi-desk-chat-conversation-scroll');
        const button = document.querySelector('[aria-label="定位到上一条用户消息"]');
        if (!(scroll instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) return null;
        const capture = () => ({
          top: scroll.scrollTop,
          height: scroll.scrollHeight,
          ratio: scroll.scrollTop / Math.max(1, scroll.scrollHeight - scroll.clientHeight)
        });
        const samples = [capture()];
        button.click();
        for (let index = 0; index < 8; index += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          samples.push(capture());
        }
        const tops = samples.map((sample) => sample.top);
        const ratios = samples.map((sample) => sample.ratio);
        const minimumTopIndex = tops.indexOf(Math.min(...tops));
        const minimumRatioIndex = ratios.indexOf(Math.min(...ratios));
        return {
          samples,
          rebound: Math.max(...tops.slice(minimumTopIndex)) - tops[minimumTopIndex],
          ratioRebound: Math.max(...ratios.slice(minimumRatioIndex)) - ratios[minimumRatioIndex],
          heightRange: Math.max(...samples.map((sample) => sample.height)) - Math.min(...samples.map((sample) => sample.height))
        };
      })()`
    )
    assert.ok(previousNavigation)
    assert.ok(
      previousNavigation.rebound <= 2,
      `上一条消息定位发生反向回跳：${JSON.stringify(previousNavigation.samples)}`
    )
    await waitFor(client, `document.body.innerText.includes('长会话 1198 用户')`, '上一轮可见')

    await waitFor(
      client,
      `document.querySelector('[aria-label="定位到下一条用户消息"]') !== null`,
      '下一条用户消息操作'
    )
    await clickAriaLabel(client, '定位到下一条用户消息')
    await waitFor(
      client,
      `document.querySelector('[aria-label="回到聊天底部"]') !== null`,
      '回到底部操作'
    )
    await clickAriaLabel(client, '回到聊天底部')
    await waitFor(
      client,
      `(() => {
        const scroll = document.querySelector('.pi-desk-chat-conversation-scroll');
        return scroll instanceof HTMLElement && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2;
      })()`,
      '包含底部留白的真实置底'
    )
    const bottomDistance = await evaluate(
      client,
      `(() => {
        const scroll = document.querySelector('.pi-desk-chat-conversation-scroll');
        return scroll instanceof HTMLElement ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight : null;
      })()`
    )
    await evaluate(client, `new Promise((resolve) => setTimeout(resolve, 300))`)

    const allLoadedMetrics = await evaluate(
      client,
      `(async () => {
        const scroll = document.querySelector('.pi-desk-chat-conversation-scroll');
        if (!(scroll instanceof HTMLElement)) return null;
        for (let index = 0; index < 60; index += 1) {
          if (document.body.innerText.includes('长会话 0 用户')) break;
          scroll.scrollTop = 0;
          scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        return {
          earliestVisible: document.body.innerText.includes('长会话 0 用户'),
          renderedTurns: document.querySelectorAll('[data-chat-turn]').length,
          containedTurns: document.querySelectorAll('[data-chat-turn].pi-desk-chat-turn-contained').length,
          domNodes: document.querySelectorAll('*').length
        };
      })()`
    )
    assert.ok(allLoadedMetrics)
    assert.equal(allLoadedMetrics.earliestVisible, true, '渐进滚动后应能挂载完整历史')
    assert.equal(allLoadedMetrics.renderedTurns, 1_200)
    assert.ok(allLoadedMetrics.containedTurns >= 1_199, JSON.stringify(allLoadedMetrics))

    const smallSwitchMs = await clickAndMeasure(client, '短会话 5 轮', '短会话 4 用户')
    const secondLargeSwitchMs = await clickAndMeasure(
      client,
      '超长会话 1200 轮',
      '长会话 1199 用户'
    )
    const finalMetrics = await evaluate(
      client,
      `(() => ({
        renderedTurns: document.querySelectorAll('[data-chat-turn]').length,
        domNodes: document.querySelectorAll('*').length,
        scrollHeight: document.querySelector('.pi-desk-chat-conversation-scroll')?.scrollHeight ?? 0,
        heapMb: performance.memory ? performance.memory.usedJSHeapSize / 1024 / 1024 : null
      }))()`
    )
    assert.ok(finalMetrics.renderedTurns <= 30)
    assert.ok(firstLargeSwitchMs < 2_500, `首次长会话切换过慢：${firstLargeSwitchMs}ms`)
    assert.ok(secondLargeSwitchMs < 2_500, `再次长会话切换过慢：${secondLargeSwitchMs}ms`)

    const output = {
      generatedAt: new Date().toISOString(),
      turns: 1_200,
      messages: 2_400,
      firstLargeSwitchMs,
      smallSwitchMs,
      secondLargeSwitchMs,
      initialMetrics,
      previousNavigationReboundPx: previousNavigation.rebound,
      previousNavigationRatioRebound: previousNavigation.ratioRebound,
      previousNavigationHeightRange: previousNavigation.heightRange,
      bottomDistance,
      allLoadedMetrics,
      finalMetrics
    }
    await mkdir(dirname(resultPath), { recursive: true })
    await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify(output, null, 2))
  } finally {
    client?.close()
    await stopBrowserTree(browserProcess, cdpPort)
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await rm(runRoot, { recursive: true, force: true })
  }
}

await main()
