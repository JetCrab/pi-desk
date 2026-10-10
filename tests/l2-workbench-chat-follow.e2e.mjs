import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clickAriaLabel,
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
  assertPortReleased,
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const taskId = `reasoning-follow-${process.pid}`
const runRoot = join(projectRoot, 'temp/run/chat-follow', taskId)
const agentRoot = join(projectRoot, 'temp/pi/chat-follow-e2e', taskId)
const agentDir = join(agentRoot, 'agent')
const buildRoot = join(projectRoot, 'temp/build/chat-follow', taskId)
const cwd = join(agentRoot, 'project')
const workId = 'reasoning-follow'
const provider = 'follow-fixture'
const model = 'follow-model'
const mobile = process.argv.includes('--mobile')
let modelResponse
let modelRequestCount = 0
let modelError
let serverOutput = ''
const widthPerformance = []

function send(delta, finishReason = null) {
  assert.ok(modelResponse, '模型请求尚未到达')
  modelResponse.write(
    `data: ${JSON.stringify({
      id: 'follow-response',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`
  )
}

async function fixture(modelPort) {
  await prepareIsolatedPiDirectory(agentDir)
  await mkdir(join(cwd, '.pi'), { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const session = SessionManager.create(cwd)
  await mkdir(dirname(session.getSessionFile()), { recursive: true })
  await writeFile(session.getSessionFile(), `${JSON.stringify(session.getHeader())}\n`)
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [
            {
              id: model,
              name: '滚动验证',
              reasoning: true,
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
  await writeFile(
    join(cwd, '.pi/settings.json'),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: 'medium'
    })
  )
  await writeFile(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({
      workSessions: [{ workId, cwd, sessionId: session.getSessionId() }],
      pinnedCount: 0
    })
  )
}

const metrics = `(() => {
  const log = document.querySelector('[role="log"]');
  const scroll = log && [...log.querySelectorAll('div')].find(element =>
    ['auto', 'scroll'].includes(getComputedStyle(element).overflowY));
  if (!scroll) return null;
  const turn = scroll.querySelector('[data-chat-tail-space]');
  return {
    top: scroll.scrollTop, height: scroll.scrollHeight, viewport: scroll.clientHeight,
    gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
    minHeight: turn?.style.minHeight,
    rect: { x: scroll.getBoundingClientRect().x, y: scroll.getBoundingClientRect().y,
      width: scroll.clientWidth, height: scroll.clientHeight }
  };
})()`

async function settle(client) {
  await evaluate(
    client,
    `(async () => {
    await Promise.allSettled(document.getAnimations()
      .filter(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime))
      .map(a => a.finished));
    for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame);
  })()`
  )
}

async function checkBottom(client, label) {
  await waitFor(
    client,
    `[...document.querySelectorAll('button')].every(button =>
    !button.textContent.includes('思考过程') || button.getAttribute('aria-expanded') === 'false')`,
    '已结束的思考全部收起'
  )
  await settle(client)
  const result = await evaluate(client, metrics)
  assert.ok(result?.height > result?.viewport + 200, `${label}未形成足够滚动内容`)
  assert.ok(result.gap <= 3, `${label}没有跟底：${JSON.stringify(result)}`)
  console.log(label, result)
}

async function wheel(client, deltaY) {
  const { rect } = await evaluate(client, metrics)
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: rect.x + 1,
    y: rect.y + rect.height - 50,
    deltaX: 0,
    deltaY
  })
}

async function renderingMetrics(client) {
  const { metrics: values } = await client.send('Performance.getMetrics')
  return Object.fromEntries(
    values
      .filter(({ name }) =>
        [
          'LayoutCount',
          'RecalcStyleCount',
          'LayoutDuration',
          'RecalcStyleDuration',
          'ScriptDuration'
        ].includes(name)
      )
      .map(({ name, value }) => [name, value])
  )
}

async function checkWidthSettled(client, label, baseline = null) {
  await settle(client)
  const before = await renderingMetrics(client)
  const elapsed = await evaluate(
    client,
    `(async () => {
      const start = performance.now();
      do { await new Promise(requestAnimationFrame); } while (performance.now() - start < 1000);
      return performance.now() - start;
    })()`
  )
  const after = await renderingMetrics(client)
  const delta = Object.fromEntries(
    Object.keys(before).map((key) => [key, after[key] - before[key]])
  )
  const animations = await evaluate(
    client,
    `document.getAnimations().filter(animation => animation.playState === 'running').map(animation => ({
      name: animation.animationName ?? null,
      target: animation.effect?.target?.tagName,
      className: animation.effect?.target?.className,
      pseudoElement: animation.effect?.pseudoElement,
      iterations: String(animation.effect?.getComputedTiming().iterations)
    }))`
  )
  widthPerformance.push({ label, elapsed, delta, animations })
  console.log(label, { elapsed, delta, animations })
  assert.ok(delta.LayoutCount <= 1, `${label}仍在持续布局：${JSON.stringify(delta)}`)
  if (baseline) {
    assert.ok(
      delta.RecalcStyleCount / elapsed <=
        baseline.delta.RecalcStyleCount / baseline.elapsed + 0.003,
      `${label}样式重算超过调整前基线：${JSON.stringify({ baseline, elapsed, delta })}`
    )
  }
  return { elapsed, delta }
}

async function dragSidebar(client) {
  const point = await evaluate(
    client,
    `(() => {
      const handle = document.querySelector('[role="separator"][aria-label="调整工作会话列表宽度"]');
      const rect = handle.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`
  )
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  let x = point.x
  const widths = []
  try {
    for (const target of [460, 230, point.x]) {
      const from = x
      for (let step = 1; step <= 12; step++) {
        x = from + ((target - from) * step) / 12
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y: point.y,
          button: 'left',
          buttons: 1
        })
        await evaluate(client, 'new Promise(requestAnimationFrame)')
        widths.push((await evaluate(client, metrics)).rect.width)
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
  const range = { min: Math.min(...widths), max: Math.max(...widths), samples: widths.length }
  assert.ok(range.max - range.min >= 100, `拖动未产生足够列宽变化：${JSON.stringify(range)}`)
  return range
}

async function main() {
  let server
  let browser
  let client
  let modelServer
  let modelPort
  let cdpPort
  let success = false
  try {
    await mkdir(runRoot, { recursive: true })
    modelPort = await reservePort()
    modelServer = createServer(async (request, response) => {
      try {
        assert.equal(request.url, '/v1/chat/completions')
        let body = ''
        for await (const chunk of request) body += chunk
        assert.equal(JSON.parse(body).model, model)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.flushHeaders()
        modelResponse = response
        modelRequestCount += 1
        send({ role: 'assistant' })
        send({
          reasoning_content: `第 ${modelRequestCount} 次思考。正在逐项检查滚动布局。\n\n`.repeat(80)
        })
      } catch (error) {
        modelError = String(error)
        response.destroy(error)
      }
    })
    modelServer.listen(modelPort, '127.0.0.1')
    await once(modelServer, 'listening')
    await fixture(modelPort)
    const appPort = await reservePort()
    cdpPort = await reservePort()
    server = spawnE2eServer({
      projectRoot,
      agentDir,
      port: appPort,
      development: true,
      nextDirectory: buildRoot,
      onOutput: (output) => {
        serverOutput += output
      }
    })
    await waitForHttp(
      `http://127.0.0.1:${appPort}/api/health`,
      60_000,
      'Pi Desk',
      () => serverOutput
    )
    browser = spawnEdge(
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      cdpPort,
      join(runRoot, 'browser'),
      '560,854',
      ['--edge-skip-compat-layer-relaunch']
    )
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge')
    client = await createCdpPage(cdpPort)
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
      window.__scrollLog = [];
      const original = console.info;
      console.info = (...args) => {
        if (args[0] === '[Pi Desk][ChatScroll]') {
          window.__scrollLog.push(args.slice(1));
          if (window.__scrollLog.length > 2000) window.__scrollLog.shift();
        }
        original(...args);
      };
    `
    })
    await setViewport(client, mobile ? 390 : 560, 854, mobile)
    await navigate(client, `http://127.0.0.1:${appPort}/login`)
    const login = await evaluate(
      client,
      `fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': crypto.randomUUID() },
      body: JSON.stringify({ password: 'Qq.445566' })
    }).then(response => response.json())`
    )
    assert.equal(login.code, 0, login.msg)
    await evaluate(
      client,
      `localStorage.setItem('pi-super:workbench-layout', JSON.stringify({primaryWorkId: '${workId}'}))`
    )
    await navigate(client, `http://127.0.0.1:${appPort}/?chatScrollDebug=1`)
    await waitFor(
      client,
      `(() => {
      const input = [...document.querySelectorAll('textarea')].find(element =>
        !element.disabled && element.getBoundingClientRect().height > 0);
      input?.focus();
      return input && document.activeElement === input;
    })()`,
      '聊天输入框可编辑并获得焦点',
      () => serverOutput,
      60_000
    )
    await client.send('Input.insertText', { text: '检查思考收起之后的滚动跟随。' })
    await waitFor(
      client,
      `document.querySelector('[aria-label="发送消息"]')?.disabled === false`,
      '发送可用'
    )
    await clickAriaLabel(client, '发送消息')
    await waitFor(
      client,
      `document.querySelector('[role="log"]')?.innerText.includes('正在逐项检查滚动布局')`,
      '思考展开',
      () => modelError ?? serverOutput
    )
    await settle(client)

    await evaluate(
      client,
      `(() => {
      window.__tailSpaceSamples = [];
      const sample = () => {
        const turn = document.querySelector('[data-chat-tail-space]');
        const last = turn?.lastElementChild;
        const scroll = turn?.closest('[role="log"]')?.firstElementChild;
        if (last && scroll) {
          const gap = Math.max(0, turn.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom);
          if (turn.getBoundingClientRect().height - gap > scroll.clientHeight) {
            window.__tailSpaceSamples.push(gap);
          }
        }
        if (window.__tailSpaceSamples.length < 2000) window.__tailSampleFrame = requestAnimationFrame(sample);
      };
      sample();
    })()`
    )
    const paragraphs = Array.from(
      { length: 24 },
      (_, index) => `${index + 1}. 检查聊天内容增长与思考收起的配合，保持当前阅读行为。\n\n`
    ).join('')
    for (let round = 0; round < 3; round++) {
      send({ content: `${paragraphs}正文输出检查点 ${round}。\n\n` })
      await waitFor(
        client,
        `document.querySelector('[role="log"]')?.innerText.includes('正文输出检查点 ${round}')`,
        '正文输出'
      )
      // 让真实增量穿过自动收起的整个动画窗口，不在收起后手动补滚。
      for (let frame = 0; frame < 90; frame++) {
        await evaluate(client, `new Promise(requestAnimationFrame)`)
        send({ content: `流式追加 ${round}-${frame}。\n\n` })
      }
      await waitFor(
        client,
        `document.querySelector('[role="log"]')?.innerText.includes('流式追加 ${round}-89')`,
        '本轮最后一段增量到达'
      )
      await waitFor(
        client,
        `[...document.querySelectorAll('button')].every(button =>
        !button.textContent.includes('思考过程') || button.getAttribute('aria-expanded') === 'false')`,
        '思考自动收起'
      )
      await checkBottom(client, `第 ${round + 1} 次思考收起后`)
      if (round < 2) {
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: `read-${round}`,
                type: 'function',
                function: {
                  name: 'read',
                  arguments: JSON.stringify({
                    path: '.pi/settings.json',
                    reasoning: '检查当前设置'
                  })
                }
              }
            ]
          },
          'tool_calls'
        )
        modelResponse.end('data: [DONE]\n\n')
        await waitFor(
          client,
          `document.querySelector('[role="log"]')?.innerText.includes('第 ${round + 2} 次思考')`,
          '下一次思考展开',
          () => modelError ?? serverOutput
        )
        assert.equal(modelRequestCount, round + 2)
      }
    }
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    for (let round = 0; round < 4; round++) {
      const nextRequest = modelRequestCount + 1
      send(
        {
          tool_calls: [
            {
              index: 0,
              id: `thinking-read-${round}`,
              type: 'function',
              function: {
                name: 'read',
                arguments: JSON.stringify({ path: '.pi/settings.json', reasoning: '检查当前设置' })
              }
            }
          ]
        },
        'tool_calls'
      )
      modelResponse.end('data: [DONE]\n\n')
      await waitFor(
        client,
        `document.querySelector('[role="log"]')?.innerText.includes('第 ${nextRequest} 次思考')`,
        '工具调用后新思考展开',
        () => modelError ?? serverOutput
      )
    }
    await checkBottom(client, '连续思考与工具切换后')
    const tailSpaces = await evaluate(
      client,
      `(() => {
      cancelAnimationFrame(window.__tailSampleFrame);
      return window.__tailSpaceSamples;
    })()`
    )
    await navigate(client, `http://127.0.0.1:${appPort}/?chatScrollDebug=1`)
    await waitFor(
      client,
      `document.querySelector('[role="log"]')?.innerText.includes('第 ${modelRequestCount} 次思考')`,
      '重新进入仍在思考的会话'
    )
    await wheel(client, -100000)
    await waitFor(client, `(${metrics})?.gap > 100`, '重新进入后上翻历史')
    await wheel(client, 100000)
    await waitFor(client, `(${metrics})?.gap <= 3`, '思考期间手动回到底部')
    await settle(client)

    // 消息收起与新项出现可能只重新分配高度，总高度不变时 ResizeObserver 不会通知。
    await evaluate(
      client,
      `(() => {
        const log = document.querySelector('[role="log"]');
        const scroll = [...log.querySelectorAll('div')].find(element =>
          ['auto', 'scroll'].includes(getComputedStyle(element).overflowY));
        const content = scroll.firstElementChild;
        const before = document.createElement('div');
        const after = document.createElement('div');
        before.style.height = '160px';
        after.style.height = '0px';
        before.style.flexShrink = after.style.flexShrink = '0';
        content.prepend(before);
        content.append(after);
        window.__layoutProbe = { before, after };
      })()`
    )
    await waitFor(client, `(${metrics})?.gap <= 3`, '布局变化前保持跟底')
    await settle(client)
    const beforeRedistribution = await evaluate(client, metrics)
    await evaluate(
      client,
      `(() => {
        const { before, after } = window.__layoutProbe;
        before.style.height = '0px';
        after.style.height = '160px';
      })()`
    )
    await settle(client)
    const afterRedistribution = await evaluate(client, metrics)
    assert.equal(afterRedistribution.height, beforeRedistribution.height, '本用例需保持总高度不变')
    console.log('总高度不变的内容换位', { beforeRedistribution, afterRedistribution })
    send({ content: `${paragraphs}重新进入后思考结束检查点。\n\n` })
    await waitFor(
      client,
      `document.querySelector('[role="log"]')?.innerText.includes('重新进入后思考结束检查点')`,
      '重新进入后思考转正文'
    )
    await checkBottom(client, '重新进入并手动到底后思考结束')
    await evaluate(
      client,
      `(() => {
        window.__layoutProbe.before.remove();
        window.__layoutProbe.after.remove();
        delete window.__layoutProbe;
      })()`
    )
    assert.ok(tailSpaces.length > 0, '未采集到内容超过视口时的布局')
    assert.ok(
      Math.max(...tailSpaces) <= 2,
      `内容收起留下多余尾部空白：${Math.max(...tailSpaces)}px`
    )
    send({ content: `${paragraphs}收起后继续输出检查点。\n\n` })
    await waitFor(
      client,
      `document.querySelector('[role="log"]')?.innerText.includes('收起后继续输出检查点')`,
      '收起后追加正文'
    )
    await checkBottom(client, '收起后继续输出')

    await wheel(client, -400)
    await waitFor(client, `(${metrics})?.gap > 100`, '用户主动上翻')
    await settle(client)
    const reading = await evaluate(client, metrics)
    send({ content: `${paragraphs}阅读历史时的输出检查点。\n\n` })
    await waitFor(
      client,
      `document.querySelector('[role="log"]')?.innerText.includes('阅读历史时的输出检查点')`,
      '历史阅读时追加正文'
    )
    await settle(client)
    const retained = await evaluate(client, metrics)
    assert.ok(
      Math.abs(retained.top - reading.top) <= 2,
      `用户阅读位置被拉回：${JSON.stringify({ reading, retained })}`
    )

    await wheel(client, 100000)
    await waitFor(client, `(${metrics})?.gap <= 3`, '手动回到底部')
    send({ content: '手动回底后恢复跟随。\n\n'.repeat(12) })
    await waitFor(
      client,
      `document.querySelector('[role="log"]')?.innerText.includes('手动回底后恢复跟随')`,
      '手动回底后追加正文'
    )
    await checkBottom(client, '手动回底后继续输出')
    await client.send('Performance.enable')
    const widthBaseline = await checkWidthSettled(client, '改变宽度前基线')
    const widthStart = await renderingMetrics(client)
    for (const width of [560, 460, 390, 520, mobile ? 390 : 560]) {
      await setViewport(client, width, 854, mobile)
      await checkBottom(client, `聊天宽度改为 ${width}px 后`)
    }
    const widthEnd = await renderingMetrics(client)
    widthPerformance.push({ label: '连续改变窗口宽度', before: widthStart, after: widthEnd })
    await checkWidthSettled(client, '窗口宽度停止变化后', widthBaseline)

    if (!mobile) {
      await setViewport(client, 1100, 854, false)
      await waitFor(client, `(${metrics}) !== null`, '桌面聊天列加载')
      await evaluate(client, `document.querySelector('[aria-label="显示工作会话菜单"]')?.click()`)
      await waitFor(
        client,
        `(() => {
          const handle = document.querySelector('[role="separator"][aria-label="调整工作会话列表宽度"]');
          return handle && handle.getAttribute('aria-hidden') !== 'true' && handle.getBoundingClientRect().height > 0;
        })()`,
        '桌面侧栏分隔条可拖动'
      )
      await settle(client)
      await wheel(client, 100000)
      await waitFor(client, `(${metrics})?.gap <= 3`, '拖动前位于底部')
      const dragBaseline = await checkWidthSettled(client, '分隔条拖动前基线')
      const dragStart = await renderingMetrics(client)
      const beforeDrag = await evaluate(client, metrics)
      const dragWidths = await dragSidebar(client)
      await checkBottom(client, '连续拖动聊天宽度后')
      const dragEnd = await renderingMetrics(client)
      widthPerformance.push({
        label: '连续拖动侧栏分隔条',
        before: dragStart,
        after: dragEnd,
        beforeDrag,
        dragWidths
      })
      await checkWidthSettled(client, '分隔条停止拖动后', dragBaseline)

      await wheel(client, -100000)
      await waitFor(client, `(${metrics})?.gap > 100`, '拖动前阅读历史')
      await dragSidebar(client)
      await settle(client)
      assert.ok((await evaluate(client, metrics)).gap > 100, '改变宽度把历史阅读拉回底部')
      await checkWidthSettled(client, '历史阅读时停止拖动后', dragBaseline)
      await wheel(client, 100000)
      await waitFor(client, `(${metrics})?.gap <= 3`, '宽度检查后手动回底')
      await setViewport(client, 560, 854, false)
      await checkBottom(client, '恢复原聊天宽度后')
    }
    await writeFile(
      join(runRoot, 'width-performance.json'),
      JSON.stringify(widthPerformance, null, 2)
    )
    await setViewport(client, mobile ? 390 : 560, 640, mobile)
    await checkBottom(client, '视口缩短后')
    await setViewport(client, mobile ? 390 : 560, 854, mobile)
    await checkBottom(client, '视口恢复后')

    send({ content: '本轮检查已完成。' }, 'stop')
    modelResponse.end('data: [DONE]\n\n')
    await waitFor(
      client,
      `document.querySelector('[aria-label="停止当前响应"]') === null &&
      document.querySelector('[role="log"]')?.innerText.includes('本轮检查已完成')`,
      '本轮结束'
    )
    await checkBottom(client, '处理过程收起后')
    assert.equal(modelError, undefined)
    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach(element => { element.style.display = 'none' })`
    )
    await writeFile(join(runRoot, 'following.png'), await screenshot(client))
    await writeFile(
      join(runRoot, 'events.json'),
      JSON.stringify(await evaluate(client, 'window.__scrollLog'), null, 2)
    )
    success = true
    console.log(`跟底回归通过：${runRoot}`)
  } catch (error) {
    if (client) {
      await writeFile(
        join(runRoot, 'failure.json'),
        JSON.stringify(
          await evaluate(
            client,
            `({ metrics: ${metrics}, events: window.__scrollLog, text: document.body.innerText,
          inputs: [...document.querySelectorAll('textarea')].map(e => ({value: e.value, disabled: e.disabled})),
          buttons: [...document.querySelectorAll('button[aria-label]')].map(e => ({label: e.ariaLabel, disabled: e.disabled})) })`
          ),
          null,
          2
        )
      ).catch(() => undefined)
      await writeFile(join(runRoot, 'failure.png'), await screenshot(client)).catch(() => undefined)
    }
    await writeFile(join(runRoot, 'server.log'), serverOutput)
    await writeFile(
      join(runRoot, 'width-performance.json'),
      JSON.stringify(widthPerformance, null, 2)
    )
    throw error
  } finally {
    modelResponse?.end()
    client?.close()
    await stopBrowserTree(browser, cdpPort)
    if (server) await stopE2eServerTree(server)
    if (modelServer) {
      modelServer.closeAllConnections()
      await new Promise((resolveClose) => modelServer.close(resolveClose))
      await assertPortReleased(modelPort)
    }
    if (success) {
      await rm(agentRoot, { recursive: true, force: true })
      await rm(buildRoot, { recursive: true, force: true })
      await rm(join(runRoot, 'browser'), { recursive: true, force: true })
    }
  }
}

await main()
