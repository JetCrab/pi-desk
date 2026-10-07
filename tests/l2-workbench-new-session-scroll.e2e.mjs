import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clickAriaLabel,
  createCdpPage,
  delay,
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
import {
  assertPortReleased,
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
  'workbench-new-session-scroll-e2e',
  String(process.pid)
)
const agentDir = join(runRoot, 'agent')
const projectDir = join(runRoot, '新会话滚动回归项目')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const outputPath = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '聊天__新会话首条输出跟随.png'
)
const moreOutputPath = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '聊天__更多开启新会话.png'
)
const workId = 'new-session-scroll-regression-work-session'
const providerId = 'scroll-regression-provider'
const modelId = 'scroll-regression-model'
const password = 'Qq.445566'
const prompt = '请持续输出足够长的内容，用于验证新会话首条消息的滚动跟随。'
const streamingMarker = '新会话首条消息正在持续输出。'
const finalMarker = '新会话首条消息滚动跟随完成。'

let appPort = 0
let cdpPort = 0
let modelPort = 0
let serverRuntime
let browserProcess
let modelServer
let serverOutput = ''
let moreScreenshot
let modelRequestCount = 0
let modelRequestError = null
let releaseStreaming = () => undefined

function streamChunk(content, finishReason = null, usage) {
  return {
    id: 'chatcmpl-scroll-regression',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        delta: content === null ? {} : { content },
        finish_reason: finishReason
      }
    ],
    ...(usage ? { usage } : {})
  }
}

function writeStreamEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function readJsonBody(request) {
  let body = ''
  for await (const chunk of request) body += chunk.toString('utf8')
  return JSON.parse(body)
}

async function handleModelRequest(request, response, continueStreaming) {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Not found' } }))
      return
    }

    const body = await readJsonBody(request)
    assert.equal(body.model, modelId)
    assert.equal(body.stream, true)
    modelRequestCount += 1

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })
    response.flushHeaders()

    writeStreamEvent(response, {
      ...streamChunk(''),
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    })

    for (let index = 1; index <= 36; index += 1) {
      writeStreamEvent(
        response,
        streamChunk(
          `${index}. 持续输出第 ${index} 段，用来确认内容增长时聊天视口始终贴近底部。${'滚动跟随。'.repeat(8)}\n\n`
        )
      )
      await delay(70)
    }

    writeStreamEvent(response, streamChunk(`**${streamingMarker}**`))
    await continueStreaming

    writeStreamEvent(
      response,
      streamChunk(`\n\n继续完成最后一段输出，确认暂停后恢复仍然保持吸底。\n\n**${finalMarker}**`)
    )
    writeStreamEvent(
      response,
      streamChunk(null, 'stop', {
        prompt_tokens: 40,
        completion_tokens: 1200,
        total_tokens: 1240,
        prompt_tokens_details: { cached_tokens: 0 }
      })
    )
    response.end('data: [DONE]\n\n')
  } catch (error) {
    modelRequestError = error
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: String(error) } }))
    } else {
      response.destroy(error)
    }
  }
}

async function startModelServer(port) {
  let resolveStreaming
  const continueStreaming = new Promise((resolveContinue) => {
    resolveStreaming = resolveContinue
  })
  releaseStreaming = () => resolveStreaming()

  const server = createServer((request, response) => {
    void handleModelRequest(request, response, continueStreaming)
  })
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  return server
}

async function stopModelServer(server, port) {
  if (!server) return
  server.closeAllConnections()
  await new Promise((resolveClose) => server.close(resolveClose))
  await assertPortReleased(port)
}

async function createFixture() {
  await prepareIsolatedPiDirectory(agentDir)
  await mkdir(projectDir, { recursive: true })
  await mkdir(join(projectDir, '.pi'), { recursive: true })
  await mkdir(dirname(workSessionStorePath), { recursive: true })

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  const sessionFile = manager.getSessionFile()
  const sessionHeader = manager.getHeader()
  assert.ok(sessionFile)
  assert.ok(sessionHeader)
  await mkdir(dirname(sessionFile), { recursive: true })
  await writeFile(sessionFile, `${JSON.stringify(sessionHeader)}\n`, 'utf8')

  await writeFile(
    join(agentDir, 'models.json'),
    `${JSON.stringify(
      {
        providers: {
          [providerId]: {
            baseUrl: `http://127.0.0.1:${modelPort}/v1`,
            api: 'openai-completions',
            apiKey: 'scroll-regression-key',
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false
            },
            models: [
              {
                id: modelId,
                name: 'Scroll regression model',
                reasoning: false,
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
              }
            ]
          }
        }
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  await writeFile(
    join(projectDir, '.pi', 'settings.json'),
    `${JSON.stringify(
      {
        defaultProvider: providerId,
        defaultModel: modelId,
        defaultThinkingLevel: 'off'
      },
      null,
      2
    )}\n`,
    'utf8'
  )
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
    `localStorage.setItem('pi-desk:workbench-layout', JSON.stringify({ primaryWorkId: ${JSON.stringify(workId)} }))`
  )
}

async function submitPrompt(client) {
  await waitFor(
    client,
    `(() => {
      const textarea = [...document.querySelectorAll(${JSON.stringify(
        `section[data-work-id="${workId}"] textarea`
      )})].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (!(textarea instanceof HTMLTextAreaElement)) return false;
      textarea.focus();
      return document.activeElement === textarea;
    })()`,
    '新会话输入框获得焦点',
    () => serverOutput
  )
  await client.send('Input.insertText', { text: prompt })
  await waitFor(
    client,
    `(() => {
      const textarea = [...document.querySelectorAll(${JSON.stringify(
        `section[data-work-id="${workId}"] textarea`
      )})].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const button = textarea?.closest('form')?.querySelector('[aria-label="发送消息"]');
      return textarea?.value === ${JSON.stringify(prompt)} &&
        button instanceof HTMLButtonElement && !button.disabled;
    })()`,
    '首条消息可以发送',
    () => serverOutput
  )
  const submitted = await evaluate(
    client,
    `(() => {
      const textarea = [...document.querySelectorAll(${JSON.stringify(
        `section[data-work-id="${workId}"] textarea`
      )})].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const button = textarea?.closest('form')?.querySelector('[aria-label="发送消息"]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(submitted, true)
}

async function acceptanceScreenshot(client) {
  await evaluate(client, 'window.__piDeskHideNextDevIndicator?.()')
  return screenshot(client)
}

function scrollMetricsExpression(marker) {
  return `(() => {
    const section = document.querySelector(${JSON.stringify(`section[data-work-id="${workId}"]`)});
    const scroll = section?.querySelector('.pi-desk-chat-conversation-scroll');
    const markerElement = [...(section?.querySelectorAll('p, li, strong') ?? [])]
      .find((element) => element.textContent?.includes(${JSON.stringify(marker)}));
    if (!(section instanceof HTMLElement) || !(scroll instanceof HTMLElement) || !(markerElement instanceof HTMLElement)) return null;
    const scrollRect = scroll.getBoundingClientRect();
    const markerRect = markerElement.getBoundingClientRect();
    return {
      scrollTop: scroll.scrollTop,
      clientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      overflowHeight: scroll.scrollHeight - scroll.clientHeight,
      distanceFromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      markerVisible: markerRect.bottom > scrollRect.top && markerRect.top < scrollRect.bottom,
      running: section.querySelector('[aria-label="停止当前响应"]') !== null,
      markerRect: { top: markerRect.top, bottom: markerRect.bottom },
      scrollRect: { top: scrollRect.top, bottom: scrollRect.bottom }
    };
  })()`
}

async function main() {
  let client
  try {
    modelPort = await reservePort()
    modelServer = await startModelServer(modelPort)
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
      60_000,
      'Pi Desk',
      () => serverOutput
    )

    browserProcess = spawnEdge(edgePath, cdpPort, join(runRoot, 'edge-profile'), '390,844')
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge CDP')
    client = await createCdpPage(cdpPort)
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          const observedShadows = new WeakSet();
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
              if (observedShadows.has(shadow)) continue;
              observedShadows.add(shadow);
              new MutationObserver(hideNextDevIndicator).observe(shadow, { childList: true, subtree: true });
            }
          };
          window.__piDeskHideNextDevIndicator = hideNextDevIndicator;
          const observer = new MutationObserver(hideNextDevIndicator);
          const observeDocument = () => {
            if (!document.documentElement) return;
            observer.observe(document.documentElement, { childList: true, subtree: true });
            hideNextDevIndicator();
          };
          if (document.documentElement) observeDocument();
          else document.addEventListener('DOMContentLoaded', observeDocument, { once: true });
        })();
      `
    })
    await setViewport(client, 390, 844, true)
    await login(client)
    await navigate(client, `http://127.0.0.1:${appPort}/`)

    await waitFor(
      client,
      `[...document.querySelectorAll(${JSON.stringify(
        `section[data-work-id="${workId}"] textarea`
      )})].some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })`,
      '新会话输入框加载',
      () => serverOutput,
      60_000
    )
    await clickAriaLabel(client, '更多操作')
    await waitFor(
      client,
      `document.querySelector('[aria-label="开启新会话"]') !== null`,
      '更多菜单显示开启新会话',
      () => serverOutput
    )
    const newSessionMenuState = await evaluate(
      client,
      `(() => ({
        menuItem: document.querySelector('[aria-label="开启新会话"]')?.textContent?.trim() ?? null,
        topHeaderItems: document.querySelectorAll('header [aria-label="开启新会话"]').length,
        menuItems: document.querySelectorAll('[aria-label="开启新会话"]').length
      }))()`
    )
    assert.equal(newSessionMenuState.menuItem, '开启新会话')
    assert.equal(newSessionMenuState.topHeaderItems, 0)
    assert.equal(newSessionMenuState.menuItems, 1)
    moreScreenshot = await acceptanceScreenshot(client)
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape'
    })
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape'
    })
    await waitFor(
      client,
      `document.querySelector('[aria-label="开启新会话"]') === null`,
      '关闭更多菜单',
      () => serverOutput
    )
    await submitPrompt(client)

    await waitFor(
      client,
      `(() => {
        const section = document.querySelector(${JSON.stringify(`section[data-work-id="${workId}"]`)});
        return section?.innerText.includes(${JSON.stringify(streamingMarker)}) === true &&
          section.querySelector('[aria-label="停止当前响应"]') !== null;
      })()`,
      '首条消息流式输出检查点',
      () => `${serverOutput}\n${modelRequestError ? String(modelRequestError) : ''}`,
      30_000
    )
    await evaluate(
      client,
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
    )

    const streamingMetrics = await evaluate(client, scrollMetricsExpression(streamingMarker))
    assert.ok(streamingMetrics)
    assert.equal(modelRequestCount, 1)
    assert.equal(modelRequestError, null)
    assert.equal(streamingMetrics.running, true, JSON.stringify(streamingMetrics))
    assert.ok(streamingMetrics.overflowHeight > 200, JSON.stringify(streamingMetrics))
    assert.ok(streamingMetrics.scrollTop > 100, JSON.stringify(streamingMetrics))
    assert.ok(streamingMetrics.distanceFromBottom <= 3, JSON.stringify(streamingMetrics))
    assert.equal(streamingMetrics.markerVisible, true, JSON.stringify(streamingMetrics))

    const streamingScreenshot = await acceptanceScreenshot(client)

    releaseStreaming()
    await waitFor(
      client,
      `(() => {
        const section = document.querySelector(${JSON.stringify(`section[data-work-id="${workId}"]`)});
        return section?.innerText.includes(${JSON.stringify(finalMarker)}) === true &&
          section.querySelector('[aria-label="停止当前响应"]') === null;
      })()`,
      '首条消息输出完成',
      () => `${serverOutput}\n${modelRequestError ? String(modelRequestError) : ''}`,
      30_000
    )
    await evaluate(
      client,
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
    )

    const finalMetrics = await evaluate(client, scrollMetricsExpression(finalMarker))
    assert.ok(finalMetrics)
    assert.equal(finalMetrics.running, false, JSON.stringify(finalMetrics))
    assert.ok(finalMetrics.distanceFromBottom <= 3, JSON.stringify(finalMetrics))
    assert.equal(finalMetrics.markerVisible, true, JSON.stringify(finalMetrics))

    await publishScreenshots([
      [outputPath, streamingScreenshot],
      [moreOutputPath, moreScreenshot]
    ])
    console.log(JSON.stringify({ outputPath, streamingMetrics, finalMetrics }, null, 2))
  } finally {
    releaseStreaming()
    client?.close()
    await stopBrowserTree(browserProcess, cdpPort)
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await stopModelServer(modelServer, modelPort)
    await rm(runRoot, { recursive: true, force: true })
  }
}

await main()
