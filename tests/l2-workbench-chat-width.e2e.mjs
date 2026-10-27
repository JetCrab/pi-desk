import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCdpPage,
  evaluate,
  navigate,
  reservePort,
  screenshot,
  setViewport,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForBrowserReady,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'
import {
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const taskId = `finished-bottom-${process.pid}`
const runRoot = join(projectRoot, 'temp/run/chat-width', taskId)
const agentRoot = join(projectRoot, 'temp/pi/chat-width-e2e', taskId)
const agentDir = join(agentRoot, 'agent')
const buildRoot = join(projectRoot, 'temp/build/chat-width', taskId)
const results = []
let serverOutput = ''

async function fixture() {
  await prepareIsolatedPiDirectory(agentDir)
  const cwd = join(agentRoot, 'project')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const workSessions = []
  for (const kind of ['long', 'short']) {
    const session = SessionManager.create(cwd)
    let timestamp = Date.now()
    for (let turn = 1; turn <= 6; turn++) {
      session.appendMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `第 ${turn} 轮宽度拖拽检查：请展示多段说明，方便观察文字换行后的滚动位置。`
          }
        ],
        timestamp: timestamp++
      })
      const paragraphs = Array.from(
        { length: turn === 6 && kind === 'short' ? 2 : 18 },
        (_, index) =>
          `第 ${turn} 轮第 ${index + 1} 段。窗口宽度改变时，文本会重新换行，消息高度也会改变。当前测试通过真实鼠标拖动分隔条，记录聊天消息的可见位置。已结束的回复保留在会话中，拖动期间不会添加或删除消息。这样可以区分正常换行与滚动校正造成的瞬间上下跳动。`
      )
      session.appendMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: paragraphs.join('\n\n') + '\n\n末尾定位标记：本轮回复结束。' }
        ],
        api: 'openai-completions',
        provider: 'fixture',
        model: 'fixture',
        usage: {
          input: 20,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 60,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp: timestamp++
      })
    }
    session.appendSessionInfo(kind === 'long' ? '长回复拖拽检查' : '短回复拖拽检查')
    workSessions.push({ workId: `width-${kind}`, cwd, sessionId: session.getSessionId() })
  }
  await writeFile(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({ workSessions, pinnedCount: 0 })
  )
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' })
  )
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [
            {
              id: 'fixture',
              name: '本地宽度检查',
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
}

const installProbe = `(() => {
  const log = document.querySelector('[role="log"]');
  const scroll = [...log.querySelectorAll('div')].find(element => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY));
  const marker = [...scroll.querySelectorAll('p')].findLast(element => element.textContent === '末尾定位标记：本轮回复结束。');
  if (!marker) throw new Error('末尾标记不存在');
  window.__scroll = scroll;
  window.__measure = () => {
    const rect = scroll.getBoundingClientRect();
    return { width: rect.width, viewport: scroll.clientHeight, top: scroll.scrollTop,
      height: scroll.scrollHeight, gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      markerBottom: marker.getBoundingClientRect().bottom - rect.top };
  };
  window.__samples = [];
  window.__sampling = false;
  window.__startSamples = () => {
    window.__samples = [];
    window.__sampling = true;
    // 连续读取绘制后的布局，覆盖相邻鼠标操作之间的短暂偏移。
    const frame = () => requestAnimationFrame(() => setTimeout(() => {
      if (!window.__sampling) return;
      if (window.__samples.length < 1500) window.__samples.push(window.__measure());
      frame();
    }, 0));
    frame();
  };
})()`

async function settle(client) {
  return evaluate(
    client,
    `(async () => {
    await document.fonts.ready;
    let last = '', stable = 0;
    for (let frame = 0; frame < 180; frame++) {
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const measured = window.__measure();
      const key = JSON.stringify(measured);
      stable = key === last ? stable + 1 : 0;
      last = key;
      if (stable >= 8) return measured;
    }
    throw new Error('聊天布局未稳定');
  })()`
  )
}

async function wheel(client, deltaY) {
  const point = await evaluate(
    client,
    `(() => {
    const rect = window.__scroll.getBoundingClientRect();
    return { x: rect.left + 5, y: rect.top + rect.height / 2 };
  })()`
  )
  await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY })
}

async function drag(client, label, following) {
  const point = await evaluate(
    client,
    `(() => {
    const handle = document.querySelector('[role="separator"][aria-label="调整工作会话列表宽度"]');
    const rect = handle.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`
  )
  const before = await settle(client)
  assert.ok(following ? before.gap <= 3 : before.gap > 100, `拖拽初始滚动状态错误：${label}`)
  await evaluate(client, 'window.__startSamples()')
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
    button: 'left',
    clickCount: 1
  })
  let x = point.x
  try {
    for (const target of [478, 226, 478, 226, point.x]) {
      const from = x
      for (let step = 1; step <= 28; step++) {
        x = from + ((target - from) * step) / 28
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y: point.y,
          button: 'left',
          buttons: 1
        })
        await evaluate(
          client,
          'new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))'
        )
      }
    }
  } finally {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y: point.y,
      button: 'left',
      clickCount: 1
    })
  }
  const after = await settle(client)
  const samples = await evaluate(client, '(window.__sampling = false, window.__samples)')
  const result = {
    label,
    following,
    before,
    after,
    samples,
    maxGap: Math.max(...samples.map((sample) => sample.gap)),
    widthRange:
      Math.max(...samples.map((sample) => sample.width)) -
      Math.min(...samples.map((sample) => sample.width))
  }
  results.push(result)
  console.log(
    `${label}：${samples.length} 帧，宽度变化 ${result.widthRange}px，最大距底部 ${result.maxGap}px`
  )
  assert.ok(result.widthRange > 150, '聊天宽度必须实际变化')
  assert.ok(
    Math.max(...samples.map((s) => s.height)) - Math.min(...samples.map((s) => s.height)) > 10,
    '内容高度必须因换行发生变化'
  )
  if (following) {
    assert.ok(
      samples.every((sample) => sample.gap <= 3),
      `拖拽中脱离底部：${label}，最大偏移 ${result.maxGap}px`
    )
    assert.ok(after.gap <= 3, '拖拽结束应保持底部')
  } else {
    assert.ok(
      samples.every((sample) => sample.gap > 100),
      '历史阅读被拉回底部'
    )
    assert.ok(Math.abs(after.top - before.top) <= 2, '恢复原宽度后阅读位置发生变化')
  }
}

async function main() {
  let server, browser, client, cdpPort
  let success = false
  try {
    await mkdir(runRoot, { recursive: true })
    await fixture()
    const port = await reservePort()
    cdpPort = await reservePort()
    server = spawnE2eServer({
      projectRoot,
      agentDir,
      port,
      development: true,
      nextDirectory: buildRoot,
      onOutput: (output) => {
        serverOutput = (serverOutput + output).slice(-2_000_000)
      }
    })
    await waitForHttp(`http://127.0.0.1:${port}/api/health`, 60000, 'Pi Desk', () => serverOutput)
    browser = spawnEdge(
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      cdpPort,
      join(runRoot, 'browser'),
      '1100,854'
    )
    await waitForBrowserReady(browser, cdpPort)
    client = await createCdpPage(cdpPort)
    await setViewport(client, 1100, 854, false)
    await navigate(client, `http://127.0.0.1:${port}/login`)
    const login = await evaluate(
      client,
      `fetch('/api/auth/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': crypto.randomUUID() },
      body: JSON.stringify({ password: 'Qq.445566' }) }).then(response => response.json())`
    )
    assert.equal(login.code, 0, login.msg)
    for (const kind of ['long', 'short']) {
      await evaluate(
        client,
        `localStorage.setItem('pi-super:workbench-layout', JSON.stringify({ primaryWorkId: 'width-${kind}' }))`
      )
      await navigate(client, `http://127.0.0.1:${port}/`)
      await waitFor(
        client,
        `document.querySelector('[role="log"]')?.textContent.includes('第 6 轮') && document.querySelector('textarea')?.disabled === false`,
        '聊天内容就绪',
        () => serverOutput,
        60000
      )
      await evaluate(client, `document.querySelector('[aria-label="显示工作会话菜单"]')?.click()`)
      await waitFor(
        client,
        `(() => {
        const handle = document.querySelector('[role="separator"][aria-label="调整工作会话列表宽度"]');
        return handle && handle.getAttribute('aria-hidden') !== 'true' && handle.getBoundingClientRect().height > 0;
      })()`,
        '分隔条可拖动'
      )
      await evaluate(client, installProbe)
      await settle(client)
      await wheel(client, -1000)
      await waitFor(client, 'window.__measure().gap > 100', '上翻解除首屏锚点')
      await wheel(client, 100000)
      await waitFor(client, 'window.__measure().gap <= 2', '手动回到底部')
      await drag(client, `${kind}-bottom`, true)
      await wheel(client, -450)
      await waitFor(client, 'window.__measure().gap > 100', '手动上翻')
      await drag(client, `${kind}-reading`, false)
    }
    success = true
    console.log('已结束长短回复的底部跟随、历史阅读宽度回归通过。')
  } catch (error) {
    if (client)
      await writeFile(join(runRoot, 'failure.png'), await screenshot(client)).catch(() => undefined)
    throw error
  } finally {
    await writeFile(join(runRoot, 'measurements.json'), JSON.stringify(results, null, 2))
    await writeFile(join(runRoot, 'server.log'), serverOutput)
    client?.close()
    try {
      await stopBrowserTree(browser, cdpPort)
    } finally {
      if (server) await stopE2eServerTree(server)
    }
    console.log('测试进程树已结束，端口已释放。')
    if (success) {
      await rm(agentRoot, { recursive: true, force: true })
      await rm(buildRoot, { recursive: true, force: true })
      await rm(runRoot, { recursive: true, force: true })
    } else {
      console.error(`失败现场：${runRoot}`)
    }
  }
}

await main()
