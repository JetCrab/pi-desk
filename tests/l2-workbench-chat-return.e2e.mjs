import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
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
  assertPortReleased,
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scenario = process.argv[2] ?? 'all'
assert.ok(['all', 'reading', 'follow-retained', 'follow-remount', 'send-switch'].includes(scenario))
const taskId = `follow-return-${scenario}-${process.pid}`
const runRoot = join(projectRoot, 'temp/run/chat-return', taskId)
const agentRoot = join(projectRoot, 'temp/pi/chat-return-e2e', taskId)
const agentDir = join(agentRoot, 'agent')
const buildRoot = join(projectRoot, 'temp/build/chat-return', taskId)
const workId = 'chat-return-primary'
const otherWorkId = 'chat-return-pinned'
const replacementWorkId = 'chat-return-replacement'
const column = `[data-work-id="${workId}"]`
const provider = 'return-fixture'
const model = 'return-model'
const answer = Array.from(
  { length: 40 },
  (_, index) => `第 ${index + 1} 段回复，用于验证返回后的阅读位置。\n\n`
).join('')
const modelEvents = new EventEmitter()
let modelResponse
let initialReply = answer
let modelRequestCount = 0
let serverOutput = ''

function send(text, finished = false) {
  assert.ok(modelResponse, '本地模型请求尚未到达')
  modelResponse.write(
    `data: ${JSON.stringify({
      id: 'return-response',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: finished ? 'stop' : null }]
    })}\n\n`
  )
  if (finished) modelResponse.end('data: [DONE]\n\n')
}

async function fixture(modelPort) {
  await prepareIsolatedPiDirectory(agentDir)
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const workSessions = []
  for (const id of [otherWorkId, workId, replacementWorkId]) {
    const cwd = join(agentRoot, id)
    await mkdir(join(cwd, '.pi'), { recursive: true })
    await writeFile(
      join(cwd, '.pi/settings.json'),
      JSON.stringify({ defaultProvider: provider, defaultModel: model })
    )
    await writeFile(
      join(cwd, 'preview.html'),
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>文件预览</title><p>返回聊天后保留阅读位置。</p></html>'
    )
    const session = SessionManager.create(cwd)
    for (let index = 0; index < 5; index += 1) {
      session.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: `${id} 提问 ${index + 1}` }],
        timestamp: Date.now()
      })
      session.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        api: 'openai-completions',
        provider,
        model,
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp: Date.now()
      })
    }
    session.appendSessionInfo(id)
    workSessions.push({ workId: id, cwd, sessionId: session.getSessionId() })
  }
  await writeFile(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({ workSessions, pinnedCount: 1 })
  )
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
              name: '返回定位验证',
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

const metrics = `(() => {
  const log = document.querySelector('${column} [role="log"]');
  const scroll = log && [...log.querySelectorAll('div')].find(element => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY));
  const user = [...(log?.querySelectorAll('[data-chat-user-message]') ?? [])].at(-1);
  if (!scroll || !user) return null;
  const tail = log.querySelector('[data-chat-tail-space]');
  const tailSpace = tail?.lastElementChild ? tail.getBoundingClientRect().bottom - tail.lastElementChild.getBoundingClientRect().bottom : 0;
  return { top: scroll.scrollTop, offset: user.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
    user: user.textContent, gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight, tailSpace };
})()`

async function settle(client) {
  await evaluate(
    client,
    `(async () => {
    await Promise.allSettled(document.getAnimations().filter(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished));
    for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame);
  })()`
  )
}

async function click(client, selector) {
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
    `操作可用：${selector}`
  )
  await evaluate(client, `document.querySelector(${JSON.stringify(selector)}).click()`)
}

async function checkLatest(client, label) {
  await waitFor(client, `Math.abs((${metrics})?.offset - 12) <= 2`, label, () => serverOutput)
  await settle(client)
  const result = await evaluate(client, metrics)
  assert.ok(Math.abs(result.offset - 12) <= 2, `${label}定位未保持稳定：${JSON.stringify(result)}`)
  assert.ok(result.gap > 100, '长回复必须保留在提问下方，不能用滚到底部代替定位用户消息')
  console.log(label, result)
}

async function scrollBy(client, deltaY) {
  const point = await evaluate(
    client,
    `(() => {
      const log = document.querySelector('${column} [role="log"]');
      const rect = log.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`
  )
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...point,
    deltaX: 0,
    deltaY
  })
}

async function readEarlier(client) {
  const before = await evaluate(client, metrics)
  await scrollBy(client, -Math.max(1500, 300 - before.offset))
  await waitFor(client, `(${metrics})?.offset > 200`, '上翻历史生效')
  await settle(client)
  return (await evaluate(client, metrics)).top
}

async function switchMobile(client, from, to) {
  await click(client, `[data-work-id="${from}"] [aria-label="显示工作会话菜单"]`)
  await click(client, '[data-testid="sidebar-mode-sessions"]')
  await click(client, `[data-testid="work-session-row-${to}"]`)
  await waitFor(
    client,
    `(() => {
      const rect = document.querySelector('[data-work-id="${to}"]')?.getBoundingClientRect();
      return rect && Math.abs(rect.left) <= 2 && rect.right <= window.innerWidth + 2;
    })()`,
    '切换聊天页'
  )
  await settle(client)
}

async function openFile(client) {
  const entry = `${column} [data-testid="session-files-entry"]`
  if (await evaluate(client, `document.querySelector(${JSON.stringify(entry)}) !== null`)) {
    await click(client, entry)
  } else {
    await click(client, `${column} [aria-label="显示工作会话菜单"]`)
    await click(client, '[data-testid="sidebar-mode-files"]')
    await click(client, '[data-testid="project-file-preview.html"]')
  }
  await waitFor(
    client,
    `(() => {
      const file = document.querySelector('${column} [data-testid="file-workspace"]');
      return Boolean(file && !file.closest('[inert]') && file.querySelector('iframe'));
    })()`,
    '文件预览已显示'
  )
  await settle(client)
}

async function returnFromFile(client, readingTop, label) {
  await click(client, `${column} [aria-label="返回聊天"]`)
  await waitFor(
    client,
    `document.querySelector('${column} [role="log"]')?.closest('[inert]') === null`,
    '聊天恢复显示'
  )
  await settle(client)
  const result = await evaluate(client, metrics)
  assert.ok(
    Math.abs(result.top - readingTop) <= 2,
    `${label}：${JSON.stringify({ readingTop, ...result })}`
  )
  console.log(label, result)
}

async function startReply(client, text, { short = false, immediate = false } = {}) {
  initialReply = short ? '正在修改。' : answer
  const nextRequest = modelRequestCount + 1
  await evaluate(client, `document.querySelector('${column} textarea').focus()`)
  await client.send('Input.insertText', { text })
  const selector = `${column} [aria-label="发送消息"]`
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(selector)})?.disabled === false`,
    '消息可发送'
  )
  await click(client, selector)
  if (immediate) return
  await waitFor(
    client,
    `document.querySelector('${column} [role="log"]')?.textContent.includes('本地流式回复 ${nextRequest}')`,
    '模型进入运行状态'
  )
  await settle(client)
}

async function finishReply(client) {
  send('本轮回复完成。', true)
  await waitFor(
    client,
    `document.querySelector('${column} [aria-label="发送消息"]') !== null`,
    '会话已经结束'
  )
  await settle(client)
}

async function checkFollowing(client, marker) {
  await waitFor(
    client,
    `document.querySelector('${column} [role="log"]')?.textContent.includes(${JSON.stringify(marker)})`,
    '新增回复已经显示'
  )
  await waitFor(
    client,
    `(${metrics})?.gap <= 2`,
    `${marker}：恢复底部跟随`,
    () => serverOutput,
    3000
  )
  await settle(client)
  const result = await evaluate(client, metrics)
  assert.ok(result.gap <= 2, `${marker}：未继续跟随底部 ${JSON.stringify(result)}`)
  console.log(marker, result)
}

async function checkFollowReturn(client, mode) {
  const remount = mode === 'follow-remount'
  const immediate = mode === 'send-switch'
  const destination = remount ? replacementWorkId : otherWorkId
  const requestArrived = once(modelEvents, 'reply', { signal: AbortSignal.timeout(20000) })
  await startReply(client, '修改', { short: true, immediate })
  if (!immediate) {
    const before = await evaluate(client, metrics)
    assert.ok(before.tailSpace > 100, `离开前必须仍有明显留白：${JSON.stringify(before)}`)
    assert.ok(before.gap <= 2, `离开前应正在底部：${JSON.stringify(before)}`)
  }
  await evaluate(
    client,
    `void (window.__originalChat = document.querySelector('${column} [role="log"]'))`
  )
  await switchMobile(client, workId, destination)
  assert.equal(
    await evaluate(client, `window.__originalChat.isConnected`),
    !remount,
    '必须覆盖指定的窗口生命周期'
  )
  // 立即切走用例也要等请求实际到达，不能向上一轮响应写入。
  await requestArrived
  await switchMobile(client, destination, workId)
  await checkFollowing(client, '正在修改。')
  assert.ok((await evaluate(client, metrics)).tailSpace > 100, '返回时应仍保留空白占位')

  await readEarlier(client)
  await scrollBy(client, 100000)
  await waitFor(client, `(${metrics})?.gap <= 2`, '手动滚回含留白的底部')
  await settle(client)
  assert.ok((await evaluate(client, metrics)).tailSpace > 100, '手动回底不能删除空白占位')
  await switchMobile(client, workId, destination)
  const marker = `${mode}：隐藏期间回复继续增长`
  send(`\n\n${answer}\n\n${marker}`)
  if (!remount) {
    await waitFor(
      client,
      `document.querySelector('${column} [role="log"]')?.textContent.includes(${JSON.stringify(marker)})`,
      '隐藏聊天已收到新增回复'
    )
    await settle(client)
  }
  await switchMobile(client, destination, workId)
  await checkFollowing(client, marker)
  const nextMarker = `${mode}：返回后继续跟随新增回复`
  send(`\n\n${answer}\n\n${nextMarker}`)
  await checkFollowing(client, nextMarker)

  await readEarlier(client)
  const reading = await evaluate(client, metrics)
  await switchMobile(client, workId, destination)
  await switchMobile(client, destination, workId)
  const returned = await evaluate(client, metrics)
  assert.ok(
    Math.abs(returned.offset - reading.offset) <= 2,
    `${mode}：手动上翻后应保留可见消息的位置 ${JSON.stringify({ reading, returned })}`
  )
  await finishReply(client)
}

async function main() {
  let server
  let browser
  let client
  let otherPage
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
        for await (const chunk of request) void chunk
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        modelResponse = response
        modelRequestCount += 1
        send(`本地流式回复 ${modelRequestCount}\n\n${initialReply}`)
        modelEvents.emit('reply')
      } catch (error) {
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
        serverOutput = (serverOutput + output).slice(-200000)
      }
    })
    await waitForHttp(
      `http://127.0.0.1:${appPort}/api/health`,
      60000,
      'Pi Desk',
      () => serverOutput
    )
    browser = spawnEdge(
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      cdpPort,
      join(runRoot, 'browser'),
      '560,854',
      ['--edge-skip-compat-layer-relaunch', '--disable-smooth-scrolling']
    )
    await waitForBrowserReady(browser, cdpPort)
    client = await createCdpPage(cdpPort)
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
      window.__scrollLog = [];
      const original = console.info;
      console.info = (...args) => {
        if (args[0] === '[Pi Desk][ChatScroll]') {
          window.__scrollLog.push(args.slice(1));
          if (window.__scrollLog.length > 1000) window.__scrollLog.shift();
        }
        original(...args);
      };
    `
    })
    await setViewport(client, 390, 854, true)
    await navigate(client, `http://127.0.0.1:${appPort}/login`)
    const login = await evaluate(
      client,
      `fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': crypto.randomUUID() }, body: JSON.stringify({ password: 'Qq.445566' }) }).then(response => response.json())`
    )
    assert.equal(login.code, 0, login.msg)
    await evaluate(
      client,
      `localStorage.setItem('pi-super:workbench-layout', JSON.stringify({ primaryWorkId: '${workId}' }))`
    )
    await navigate(client, `http://127.0.0.1:${appPort}/?chatScrollDebug=1`)
    await checkLatest(client, '已结束会话首次进入定位末条提问')
    for (const mode of ['follow-retained', 'follow-remount', 'send-switch']) {
      if (scenario === 'all' || scenario === mode) await checkFollowReturn(client, mode)
    }
    if (scenario !== 'all' && scenario !== 'reading') {
      success = true
      console.log(`聊天跟随定向回归通过：${scenario}`)
      return
    }
    const endedReadingTop = await readEarlier(client)
    await openFile(client)
    await returnFromFile(client, endedReadingTop, '已结束会话查看文件后保留阅读位置')
    await openFile(client)
    await returnFromFile(client, endedReadingTop, '重复查看文件后仍保留阅读位置')
    await evaluate(
      client,
      `void (window.__originalChat = document.querySelector('${column} [role="log"]'))`
    )
    await switchMobile(client, workId, otherWorkId)
    await switchMobile(client, otherWorkId, workId)
    assert.equal(
      await evaluate(
        client,
        `window.__originalChat === document.querySelector('${column} [role="log"]')`
      ),
      true,
      '测试必须覆盖保留挂载的返回路径'
    )
    await checkLatest(client, '已结束会话切回来定位末条提问')

    await startReply(client, '验证运行中返回保留阅读位置')
    const readingTop = await readEarlier(client)
    await switchMobile(client, workId, otherWorkId)
    await switchMobile(client, otherWorkId, workId)
    assert.ok(
      Math.abs((await evaluate(client, metrics)).top - readingTop) <= 2,
      '运行中的会话返回应保留阅读位置'
    )
    await finishReply(client)
    assert.ok(
      Math.abs((await evaluate(client, metrics)).top - readingTop) <= 2,
      '留在当前页面时回复结束不能打断阅读'
    )
    await switchMobile(client, workId, otherWorkId)
    await switchMobile(client, otherWorkId, workId)
    await checkLatest(client, '回复结束后再次进入定位末条提问')

    await startReply(client, '验证隐藏期间结束后的返回位置')
    await readEarlier(client)
    await switchMobile(client, workId, otherWorkId)
    await finishReply(client)
    await switchMobile(client, otherWorkId, workId)
    await checkLatest(client, '隐藏期间结束后返回定位末条提问')

    await startReply(client, '验证文件预览返回保留阅读位置')
    const fileReadingTop = await readEarlier(client)
    await openFile(client)
    await returnFromFile(client, fileReadingTop, '运行中查看文件后保留阅读位置')
    await openFile(client)
    await finishReply(client)
    await returnFromFile(client, fileReadingTop, '查看文件期间回复结束后保留阅读位置')

    await setViewport(client, 1280, 900, false)
    await checkLatest(client, '桌面布局重建后定位末条提问')
    await readEarlier(client)
    otherPage = await createCdpPage(cdpPort)
    await otherPage.send('Page.bringToFront')
    await waitFor(client, 'document.hidden', '聊天页面进入后台')
    await client.send('Page.bringToFront')
    await waitFor(client, '!document.hidden', '聊天页面恢复显示')
    await checkLatest(client, '保留页面从后台返回定位末条提问')
    success = true
    console.log('聊天返回定位定向回归通过')
  } catch (error) {
    await writeFile(join(runRoot, 'server.log'), serverOutput)
    if (client) {
      await writeFile(join(runRoot, 'failure.png'), await screenshot(client)).catch(() => undefined)
      await writeFile(
        join(runRoot, 'metrics.json'),
        JSON.stringify(await evaluate(client, metrics))
      ).catch(() => undefined)
      await writeFile(
        join(runRoot, 'scroll.json'),
        JSON.stringify(await evaluate(client, 'window.__scrollLog'), null, 2)
      ).catch(() => undefined)
    }
    console.error(`验证现场：${runRoot}`)
    throw error
  } finally {
    otherPage?.close()
    client?.close()
    await stopBrowserTree(browser, cdpPort)
    if (server) await stopE2eServerTree(server)
    if (modelServer) {
      modelResponse?.destroy()
      modelServer.closeAllConnections()
      await new Promise((resolveClose) => modelServer.close(resolveClose))
      await assertPortReleased(modelPort)
    }
    if (success) {
      await rm(agentRoot, { recursive: true, force: true })
      await rm(buildRoot, { recursive: true, force: true })
      await rm(runRoot, { recursive: true, force: true })
    }
  }
}

await main()
