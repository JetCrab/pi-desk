import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

import { assertPortReleased, spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const testRoot = join(projectRoot, 'temp', 'pi', 'conversation-visual', String(process.pid))
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, '默认聊天视觉项目')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const externalReadPath = join(agentDir, 'session-preview.jsonl')
const workId = 'conversation-visual-work-session'
const desktopDefaultOutput = join(projectRoot, 'temp', '验收', '客户端_桌面', '聊天__默认消息.png')
const desktopDetailOutput = join(projectRoot, 'temp', '验收', '客户端_桌面', '聊天__详情展开.png')
const desktopPreviewOutput = join(projectRoot, 'temp', '验收', '客户端_桌面', '聊天__文件预览.png')
const mobileDefaultOutput = join(projectRoot, 'temp', '验收', '客户端_移动端', '聊天__默认消息.png')
const mobileDetailOutput = join(projectRoot, 'temp', '验收', '客户端_移动端', '聊天__详情展开.png')
const mobilePreviewOutput = join(projectRoot, 'temp', '验收', '客户端_移动端', '聊天__图片预览.png')
const readDetailContent = [
  `const longReadLine = '${'read'.repeat(80)}'`,
  ...Array.from({ length: 34 }, (_, index) => `export const readValue${index + 1} = ${index + 1}`),
  '',
  '[35 more lines in file. Use offset=36 to continue.]'
].join('\n')
const editDiffContent = Array.from({ length: 18 }, (_, index) => {
  const line = index + 10
  return ` ${line - 1} const stable${index} = true\n-${line} const value${index} = 'old'\n+${line} const value${index} = 'new'`
}).join('\n')
const writeDetailContent = [
  `export const longWriteLine = '${'write'.repeat(80)}'`,
  ...Array.from({ length: 34 }, (_, index) => `export const writeValue${index + 1} = ${index + 1}`)
].join('\n')
let imageData = ''
const password = 'Qq.445566'
const compactionSummary = [
  '## Goal',
  '',
  '验证上下文压缩摘要只在用户主动展开后显示。',
  '',
  '## Progress',
  '',
  '- 压缩完成提示保持独立时间线样式。',
  '- 摘要内容超过固定高度后只在详情区域内部滚动。',
  '',
  '## Critical Context',
  '',
  ...Array.from(
    { length: 18 },
    (_, index) => `- 保留的关键上下文 ${index + 1}：用于验证长摘要滚动区域。`
  )
].join('\n')
let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''
let sessionId = ''

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function reservePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
  return address.port
}

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {
      // 目标仍在启动。
    }
    await delay(100)
  }
  throw new Error(`${label}启动超时\n${serverOutput}`)
}

async function createFixture() {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(join(projectDir, 'src'), { recursive: true })
  await mkdir(join(projectDir, 'assets'), { recursive: true })
  await mkdir(dirname(workSessionStorePath), { recursive: true })
  await writeFile(externalReadPath, readDetailContent, 'utf8')
  await writeFile(
    join(projectDir, 'src', 'edit-example.ts'),
    "export const value = 'new'\n",
    'utf8'
  )
  await writeFile(join(projectDir, 'src', 'write-example.ts'), writeDetailContent, 'utf8')
  const { default: sharp } = await import('sharp')
  const imageBuffer = await sharp({
    create: {
      width: 320,
      height: 180,
      channels: 4,
      background: { r: 18, g: 128, b: 196, alpha: 1 }
    }
  })
    .png()
    .toBuffer()
  imageData = imageBuffer.toString('base64')
  await writeFile(join(projectDir, 'assets', 'pixel.png'), imageBuffer)

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  const timestamp = Date.now()
  const usage = {
    input: 1200,
    output: 345,
    cacheRead: 6000,
    cacheWrite: 0,
    totalTokens: 7545,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.001, cacheWrite: 0, total: 0.004 }
  }

  const firstUserEntryId = manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '请核对默认聊天消息、处理过程和按需详情。' }],
    timestamp
  })
  manager.appendMessage({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '先确认 Summary，再按需读取 canonical Detail。' },
      { type: 'text', text: '我会检查当前消息投影与详情加载行为。' },
      {
        type: 'toolCall',
        id: 'conversation-visual-read',
        name: 'read',
        arguments: {
          path: externalReadPath,
          offset: 1,
          limit: 35,
          reasoning: '确认 Read 范围'
        }
      },
      {
        type: 'toolCall',
        id: 'conversation-visual-edit',
        name: 'edit',
        arguments: {
          path: join(projectDir, 'src', 'edit-example.ts'),
          edits: [{ oldText: "export const value = 'old'", newText: "export const value = 'new'" }],
          reasoning: '确认 Edit Diff'
        }
      },
      {
        type: 'toolCall',
        id: 'conversation-visual-write',
        name: 'write',
        arguments: {
          path: join(projectDir, 'src', 'write-example.ts'),
          content: writeDetailContent,
          reasoning: '确认 Write 正文'
        }
      },
      {
        type: 'toolCall',
        id: 'conversation-visual-image',
        name: 'read',
        arguments: {
          path: join(projectDir, 'assets', 'pixel.png'),
          reasoning: '确认图片 Read'
        }
      }
    ],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'toolUse',
    timestamp: timestamp + 1
  })
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'conversation-visual-read',
    toolName: 'read',
    content: [{ type: 'text', text: readDetailContent }],
    usage,
    isError: false,
    timestamp: timestamp + 2
  })
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'conversation-visual-edit',
    toolName: 'edit',
    content: [{ type: 'text', text: 'Successfully replaced 1 block.' }],
    details: {
      diff: editDiffContent,
      patch: 'fixture patch',
      firstChangedLine: 10
    },
    usage,
    isError: false,
    timestamp: timestamp + 3
  })
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'conversation-visual-write',
    toolName: 'write',
    content: [{ type: 'text', text: 'Successfully wrote file.' }],
    usage,
    isError: false,
    timestamp: timestamp + 4
  })
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'conversation-visual-image',
    toolName: 'read',
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: imageData, mimeType: 'image/png' }
    ],
    usage,
    isError: false,
    timestamp: timestamp + 5
  })
  manager.appendMessage({
    role: 'bashExecution',
    command: 'pnpm typecheck',
    output: 'TypeScript 基线检查通过。',
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: timestamp + 6
  })
  manager.appendCustomMessageEntry(
    'conversation-visual-note',
    '当前默认 Custom Message 视觉基线。',
    true
  )
  manager.appendMessage({
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '默认聊天基线已确认：处理过程默认折叠，Durable 详情由用户展开后按需加载。'
      }
    ],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp + 8
  })
  manager.appendCompaction(compactionSummary, firstUserEntryId, 120_000)
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '请确认展开处理过程后无需二次加载即可看到模型错误。' }],
    timestamp: timestamp + 9
  })
  manager.appendMessage({
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'error',
    errorMessage: 'terminated',
    timestamp: timestamp + 10
  })
  manager.appendSessionInfo('默认聊天视觉基线')
  sessionId = manager.getSessionId()

  await writeFile(
    workSessionStorePath,
    `${JSON.stringify(
      {
        workSessions: [{ workId, cwd: projectDir, sessionId }],
        pinnedCount: 0
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8'))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }
      for (const listener of this.events.get(message.method) ?? []) listener(message.params)
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  once(method) {
    return new Promise((resolveEvent) => {
      const listeners = this.events.get(method) ?? new Set()
      const listener = (params) => {
        listeners.delete(listener)
        resolveEvent(params)
      }
      listeners.add(listener)
      this.events.set(method, listeners)
    })
  }

  close() {
    this.socket.close()
  }
}

async function createCdpPage(url) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT'
  })
  assert.equal(response.ok, true)
  const target = await response.json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  const client = new CdpClient(socket)
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  return client
}

async function navigate(client, url) {
  const loaded = client.once('Page.loadEventFired')
  await client.send('Page.navigate', { url })
  await loaded
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本执行失败')
  }
  return result.result.value
}

async function waitFor(client, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return
    await delay(100)
  }
  const bodyText = await evaluate(client, `document.body.innerText.slice(0, 6000)`)
  throw new Error(
    `等待页面状态超时：${label}\n--- DOM ---\n${bodyText}\n--- Server ---\n${serverOutput}`
  )
}

async function clickText(client, text) {
  const clicked = await evaluate(
    client,
    `(() => {
      const target = [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')].reverse().find((element) => element.textContent?.includes(${JSON.stringify(text)}));
      if (!target) return false;
      target.click();
      return true;
    })()`
  )
  assert.equal(clicked, true, `未找到按钮：${text}`)
}

async function clickAriaLabel(client, label) {
  const clicked = await evaluate(
    client,
    `(() => {
      const target = [...document.querySelectorAll('[aria-label]')].find((element) => element.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!target) return false;
      target.click();
      return true;
    })()`
  )
  assert.equal(clicked, true, `未找到操作：${label}`)
}

async function clickAriaLabelIfPresent(client, label) {
  const clicked = await evaluate(
    client,
    `(() => {
      const target = [...document.querySelectorAll('[aria-label]')].find((element) => element.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!target) return false;
      target.click();
      return true;
    })()`
  )
  return clicked
}

async function centerAriaLabel(client, label) {
  const result = await evaluate(
    client,
    `(async () => {
      const target = [...document.querySelectorAll('[aria-label]')].find((element) => element.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!target) return null;
      let scroller = target.parentElement;
      while (scroller) {
        const style = getComputedStyle(scroller);
        if (
          scroller.scrollHeight > scroller.clientHeight &&
          (style.overflowY === 'auto' || style.overflowY === 'scroll')
        ) break;
        scroller = scroller.parentElement;
      }
      if (!scroller) return { visible: false, reason: 'missing-scroller' };

      for (let index = 0; index < 3; index += 1) {
        const targetRect = target.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        scroller.scrollTop +=
          targetRect.top -
          scrollerRect.top -
          (scroller.clientHeight - targetRect.height) / 2;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      const targetRect = target.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      return {
        visible:
          targetRect.bottom > scrollerRect.top &&
          targetRect.top < scrollerRect.bottom,
        viewportVisible: targetRect.bottom > 0 && targetRect.top < window.innerHeight,
        targetTop: targetRect.top,
        targetBottom: targetRect.bottom,
        scrollerTop: scrollerRect.top,
        scrollerBottom: scrollerRect.bottom,
        scrollTop: scroller.scrollTop
      };
    })()`
  )
  assert.ok(result, `未找到需要居中的操作：${label}`)
  assert.equal(result.visible, true, `操作没有进入聊天滚动区：${label} ${JSON.stringify(result)}`)
  assert.equal(
    result.viewportVisible,
    true,
    `操作没有进入浏览器视口：${label} ${JSON.stringify(result)}`
  )
}

async function assertCompactionDetailScrollable(client, label) {
  const metrics = await evaluate(
    client,
    `(() => {
      const target = document.querySelector('[aria-label="上下文压缩摘要内容"]');
      if (!target) return null;
      target.scrollTop = target.scrollHeight;
      const scrolled = target.scrollTop > 0;
      const result = {
        clientHeight: target.clientHeight,
        scrollHeight: target.scrollHeight,
        maxHeight: getComputedStyle(target).maxHeight,
        scrolled
      };
      target.scrollTop = 0;
      return result;
    })()`
  )
  assert.ok(metrics, `${label}未找到压缩摘要内容区`)
  assert.equal(metrics.maxHeight, '320px', `${label}压缩摘要最大高度不正确`)
  assert.equal(metrics.scrollHeight > metrics.clientHeight, true, `${label}长摘要没有内部溢出`)
  assert.equal(metrics.scrolled, true, `${label}压缩摘要不能独立滚动`)
}

async function assertToolDetailScrollable(client, ariaLabel, label, requireHorizontal = false) {
  const metrics = await evaluate(
    client,
    `(() => {
      const target = document.querySelector(${JSON.stringify(`[aria-label="${ariaLabel}"]`)});
      if (!target) return null;
      target.scrollTop = target.scrollHeight;
      const result = {
        clientHeight: target.clientHeight,
        scrollHeight: target.scrollHeight,
        maxHeight: getComputedStyle(target).maxHeight,
        scrolled: target.scrollTop > 0,
        horizontalOverflow: target.scrollWidth > target.clientWidth
      };
      target.scrollTop = 0;
      return result;
    })()`
  )
  assert.ok(metrics, `${label}未找到详情区域：${ariaLabel}`)
  assert.equal(metrics.maxHeight, '320px', `${label}详情最大高度不正确`)
  assert.equal(metrics.scrollHeight > metrics.clientHeight, true, `${label}长详情没有内部溢出`)
  assert.equal(metrics.scrolled, true, `${label}详情不能独立滚动`)
  if (requireHorizontal) {
    assert.equal(metrics.horizontalOverflow, true, `${label}长代码没有保留内部横向滚动`)
  }
}

async function readIndexedDbMessage(client, index) {
  return evaluate(
    client,
    `(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pi-desk-chat');
        request.addEventListener('success', () => resolve(request.result), { once: true });
        request.addEventListener('error', () => reject(request.error), { once: true });
      });
      return new Promise((resolve, reject) => {
        const transaction = database.transaction('messages', 'readonly');
        const request = transaction.objectStore('messages').get([${JSON.stringify(sessionId)}, 'v1:main', ${index}]);
        request.addEventListener('success', () => resolve(request.result ?? null), { once: true });
        request.addEventListener('error', () => reject(request.error), { once: true });
      });
    })()`
  )
}

async function waitForIndexedDbMessage(client, index) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const record = await readIndexedDbMessage(client, index)
    if (record) return record
    await delay(100)
  }
  throw new Error(`等待 IndexedDB 消息超时：${index}`)
}

async function screenshot(client) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  return Buffer.from(result.data, 'base64')
}

async function setViewport(client, width, height, mobile) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile
  })
}

async function waitForPortReleased(port) {
  const deadline = Date.now() + 10_000
  let lastError
  while (Date.now() < deadline) {
    try {
      await assertPortReleased(port)
      return
    } catch (error) {
      lastError = error
      await delay(100)
    }
  }
  throw lastError ?? new Error(`端口未释放：${port}`)
}

async function stopBrowser() {
  if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    const exited = once(browserProcess, 'exit').catch(() => undefined)
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(browserProcess.pid), '/T', '/F'], {
        windowsHide: true
      })
    } catch {
      // 进程可能已经退出。
    }
    await Promise.race([exited, delay(10_000)])
  }
  if (cdpPort > 0) await waitForPortReleased(cdpPort)
}

async function publishScreenshots(screenshots) {
  for (const [path, content] of screenshots) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
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
    await waitForHttp(`http://127.0.0.1:${appPort}/api/health`, 30_000, 'Pi Desk')

    browserProcess = spawn(
      edgePath,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${join(testRoot, 'edge-profile')}`,
        '--window-size=1440,900',
        'about:blank'
      ],
      { stdio: 'ignore', windowsHide: true }
    )
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge CDP')
    client = await createCdpPage('about:blank')
    await navigate(client, `http://127.0.0.1:${appPort}/login`)

    const login = await evaluate(
      client,
      `fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': 'a736206f-1064-4b76-a977-61fbc3b9d7c4' },
        body: JSON.stringify({ password: ${JSON.stringify(password)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(login.ok, true, login.body?.msg)

    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await setViewport(client, 1440, 900, false)
    await waitFor(client, `document.body.innerText.includes('默认聊天视觉项目')`, '工作会话出现')
    await clickText(client, '默认聊天视觉项目')
    await waitFor(
      client,
      `document.body.innerText.includes('默认聊天基线已确认') && document.body.innerText.includes('处理过程 · 5 次工具调用') && document.body.innerText.includes('上下文压缩完成') && !document.body.innerText.includes('验证上下文压缩摘要只在用户主动展开后显示。') && !document.body.innerText.includes('模型响应流意外中断：连接在回答完成前被关闭。')`,
      '默认聊天消息、压缩提示和错误处理过程折叠'
    )
    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach((element) => { element.style.display = 'none' })`
    )

    const assistantBeforeOpen = await waitForIndexedDbMessage(client, 1)
    const readBeforeOpen = await waitForIndexedDbMessage(client, 2)
    const editBeforeOpen = await waitForIndexedDbMessage(client, 3)
    const writeBeforeOpen = await waitForIndexedDbMessage(client, 4)
    const imageBeforeOpen = await waitForIndexedDbMessage(client, 5)
    const bashBeforeOpen = await waitForIndexedDbMessage(client, 6)
    const compactionBeforeOpen = await waitForIndexedDbMessage(client, 9)
    const errorBeforeOpen = await waitForIndexedDbMessage(client, 11)
    assert.equal(Object.hasOwn(assistantBeforeOpen, 'detail'), false)
    assert.equal(Object.hasOwn(readBeforeOpen, 'detail'), false)
    assert.equal(Object.hasOwn(editBeforeOpen, 'detail'), false)
    assert.equal(Object.hasOwn(writeBeforeOpen, 'detail'), false)
    assert.equal(Object.hasOwn(imageBeforeOpen, 'detail'), false)
    assert.equal(imageBeforeOpen.fixed.hasDetail, false)
    assert.equal(imageBeforeOpen.fixed.viewKey, 'pi-desk/read')
    assert.equal(imageBeforeOpen.summary.path, join(projectDir, 'assets', 'pixel.png'))
    assert.equal(Object.hasOwn(bashBeforeOpen, 'detail'), false)
    assert.equal(Object.hasOwn(compactionBeforeOpen, 'detail'), false)
    assert.equal(compactionBeforeOpen.fixed.type, 'custom')
    assert.equal(compactionBeforeOpen.fixed.viewKey, 'pi-desk/compaction')
    assert.equal(compactionBeforeOpen.fixed.hasDetail, true)
    assert.deepEqual(compactionBeforeOpen.summary, {})
    assert.equal(Object.hasOwn(errorBeforeOpen, 'detail'), false)
    assert.equal(errorBeforeOpen.fixed.status, 'error')
    assert.equal(errorBeforeOpen.fixed.hasDetail, false)
    assert.deepEqual(errorBeforeOpen.summary, { text: '', errorMessage: 'terminated' })
    assert.equal(await evaluate(client, `document.body.innerText.includes('查看错误详情')`), false)
    assert.equal(
      await evaluate(
        client,
        `document.body.innerText.includes('模型响应流意外中断：连接在回答完成前被关闭。')`
      ),
      false
    )
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      '桌面端默认折叠动画完成'
    )
    await centerAriaLabel(client, '展开上下文压缩摘要')

    const desktopDefault = await screenshot(client)
    await setViewport(client, 390, 844, true)
    await waitFor(
      client,
      `document.body.innerText.includes('处理过程') && !document.body.innerText.includes('模型响应流意外中断：连接在回答完成前被关闭。')`,
      '移动端错误处理过程默认折叠'
    )
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      '移动端默认折叠动画完成'
    )
    await centerAriaLabel(client, '展开上下文压缩摘要')
    const mobileDefault = await screenshot(client)

    await setViewport(client, 1440, 900, false)
    await clickText(client, '处理过程 · 5 次工具调用')
    await waitFor(
      client,
      `document.body.innerText.includes('确认 Read 范围') && document.body.innerText.includes('确认 Edit Diff') && document.body.innerText.includes('确认 Write 正文') && document.body.innerText.includes('确认图片 Read')`,
      '文件工具处理过程展开'
    )
    const imageReadHasNoDisclosure = await evaluate(
      client,
      `(() => {
        const preview = [...document.querySelectorAll('[aria-label]')].find((element) => element.getAttribute('aria-label') === ${JSON.stringify(`预览当前文件 ${join(projectDir, 'assets', 'pixel.png')}`)});
        const card = preview?.closest('[data-message-id]');
        return Boolean(card) && ![...card.querySelectorAll('[aria-label]')].some((element) => element.getAttribute('aria-label')?.includes('read 工具结果'));
      })()`
    )
    assert.equal(imageReadHasNoDisclosure, true, '图片 Read 不应展示普通文本下拉')
    const fileActionOrder = await evaluate(
      client,
      `(() => {
        const preview = [...document.querySelectorAll('[aria-label]')].find((element) => element.getAttribute('aria-label') === ${JSON.stringify(`预览当前文件 ${join(projectDir, 'src', 'edit-example.ts')}`)});
        const disclosure = preview?.closest('[data-message-id]')?.querySelector('[data-tool-disclosure]');
        if (!preview || !disclosure) return null;
        return {
          previewLeft: preview.getBoundingClientRect().left,
          disclosureLeft: disclosure.getBoundingClientRect().left
        };
      })()`
    )
    assert.ok(fileActionOrder, 'Edit Item 缺少预览或下拉动作')
    assert.equal(
      fileActionOrder.previewLeft < fileActionOrder.disclosureLeft,
      true,
      '文件预览按钮必须位于下拉箭头左侧'
    )
    assert.equal(
      fileActionOrder.disclosureLeft - fileActionOrder.previewLeft <= 32,
      true,
      '文件预览按钮与下拉箭头必须紧邻'
    )

    await clickText(client, '思考过程')
    await waitFor(
      client,
      `document.body.innerText.includes('先确认 Summary，再按需读取 canonical Detail。')`,
      'Assistant Detail 加载'
    )
    const assistantAfterOpen = await waitForIndexedDbMessage(client, 1)
    assert.deepEqual(assistantAfterOpen.detail, {
      thinking: '先确认 Summary，再按需读取 canonical Detail。'
    })

    await clickAriaLabel(client, '展开 read 工具结果')
    await clickAriaLabel(client, '展开 edit 工具结果')
    await clickAriaLabel(client, '展开 write 工具结果')
    await clickAriaLabel(client, '展开 bash 工具结果')
    await waitFor(
      client,
      `document.body.innerText.includes('readValue34') && document.body.innerText.includes("value17 = 'new'") && document.body.innerText.includes('writeValue34') && document.body.innerText.includes('TypeScript 基线检查通过')`,
      '文件工具 Detail 加载'
    )
    const readAfterOpen = await waitForIndexedDbMessage(client, 2)
    const editAfterOpen = await waitForIndexedDbMessage(client, 3)
    const writeAfterOpen = await waitForIndexedDbMessage(client, 4)
    const imageAfterOpen = await waitForIndexedDbMessage(client, 5)
    const bashAfterOpen = await waitForIndexedDbMessage(client, 6)
    assert.deepEqual(readAfterOpen.detail, { content: readDetailContent })
    assert.deepEqual(editAfterOpen.detail, { kind: 'diff', content: editDiffContent })
    assert.deepEqual(writeAfterOpen.detail, { kind: 'content', content: writeDetailContent })
    assert.equal(Object.hasOwn(imageAfterOpen, 'detail'), false)
    assert.deepEqual(bashAfterOpen.detail, { output: 'TypeScript 基线检查通过。' })
    await assertToolDetailScrollable(client, 'read 读取内容', '桌面端 Read', true)
    await assertToolDetailScrollable(client, 'edit 文件差异', '桌面端 Edit')
    await assertToolDetailScrollable(client, 'write 写入内容', '桌面端 Write', true)
    const diffColors = await evaluate(
      client,
      `(() => {
        const lines = [...document.querySelectorAll('[aria-label="edit 文件差异"] > span')];
        const added = lines.find((line) => line.textContent?.startsWith('+'));
        const removed = lines.find((line) => line.textContent?.startsWith('-'));
        if (!added || !removed) return null;
        return {
          added: getComputedStyle(added).backgroundColor,
          removed: getComputedStyle(removed).backgroundColor
        };
      })()`
    )
    assert.ok(diffColors)
    assert.notEqual(diffColors.added, diffColors.removed, 'Edit 增删行应有不同背景色')

    await clickAriaLabel(client, '展开上下文压缩摘要')
    await waitFor(
      client,
      `document.body.innerText.includes('验证上下文压缩摘要只在用户主动展开后显示。')`,
      '压缩摘要 Detail 加载'
    )
    const compactionAfterOpen = await waitForIndexedDbMessage(client, 9)
    assert.deepEqual(compactionAfterOpen.detail, { text: compactionSummary })
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      '桌面端压缩摘要动画完成'
    )
    await assertCompactionDetailScrollable(client, '桌面端')
    await clickAriaLabelIfPresent(client, '收起上下文压缩摘要')
    await centerAriaLabel(client, 'edit 文件差异')
    const desktopDetail = await screenshot(client)

    const externalReadPreviewLabel = `预览当前文件 ${externalReadPath}`
    await centerAriaLabel(client, externalReadPreviewLabel)
    await clickAriaLabel(client, externalReadPreviewLabel)
    await waitFor(
      client,
      `(() => {
        const workspace = document.querySelector('[data-testid="file-workspace"]');
        const code = workspace?.querySelector('.monaco-editor .view-lines');
        return Boolean(workspace?.textContent?.includes('session-preview.jsonl')) && Boolean(code?.textContent?.includes('longReadLine'));
      })()`,
      '桌面端文件预览'
    )
    const desktopPreview = await screenshot(client)
    await clickAriaLabel(client, '收起文件')

    await setViewport(client, 390, 844, true)
    const mobileProcessNeedsOpen = await evaluate(
      client,
      `!document.body.innerText.includes('确认 Read 范围')`
    )
    if (mobileProcessNeedsOpen) await clickText(client, '处理过程 · 5 次工具调用')
    await waitFor(
      client,
      `document.body.innerText.includes('确认 Read 范围') && document.body.innerText.includes('确认 Edit Diff') && document.body.innerText.includes('确认 Write 正文')`,
      '移动端处理过程展开'
    )
    await clickAriaLabelIfPresent(client, '展开 read 工具结果')
    await clickAriaLabelIfPresent(client, '展开 edit 工具结果')
    await clickAriaLabelIfPresent(client, '展开 write 工具结果')
    await clickAriaLabelIfPresent(client, '展开 bash 工具结果')
    await waitFor(
      client,
      `document.body.innerText.includes('readValue34') && document.body.innerText.includes("value17 = 'new'") && document.body.innerText.includes('writeValue34')`,
      '移动端文件工具详情显示'
    )
    await assertToolDetailScrollable(client, 'read 读取内容', '移动端 Read', true)
    await assertToolDetailScrollable(client, 'edit 文件差异', '移动端 Edit')
    await assertToolDetailScrollable(client, 'write 写入内容', '移动端 Write', true)
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      '移动端工具详情动画完成'
    )
    await centerAriaLabel(client, 'edit 文件差异')
    await evaluate(
      client,
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    )
    await centerAriaLabel(client, 'edit 文件差异')
    const mobileDetail = await screenshot(client)

    const compactionNeedsOpen = await evaluate(
      client,
      `document.querySelector('[aria-label="展开上下文压缩摘要"]') !== null`
    )
    if (compactionNeedsOpen) await clickAriaLabel(client, '展开上下文压缩摘要')
    await waitFor(
      client,
      `document.body.innerText.includes('验证上下文压缩摘要只在用户主动展开后显示。')`,
      '移动端压缩摘要展开'
    )
    await assertCompactionDetailScrollable(client, '移动端')
    await clickAriaLabelIfPresent(client, '收起上下文压缩摘要')

    const imagePreviewLabel = `预览当前文件 ${join(projectDir, 'assets', 'pixel.png')}`
    await centerAriaLabel(client, imagePreviewLabel)
    await clickAriaLabel(client, imagePreviewLabel)
    await waitFor(
      client,
      `(() => {
        const root = document.querySelector('[data-testid="file-workspace"]');
        const image = root?.querySelector('.viewer-canvas img');
        const rect = image?.getBoundingClientRect();
        return root?.querySelector('[aria-label="返回聊天"]') !== null && Boolean(image?.complete) && image.naturalWidth === 320 && Boolean(rect && rect.width > 100 && rect.height > 50);
      })()`,
      '移动端图片预览'
    )
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      '移动端图片预览动画完成'
    )
    const mobilePreview = await screenshot(client)
    await clickAriaLabel(client, '返回聊天')

    await publishScreenshots([
      [desktopDefaultOutput, desktopDefault],
      [desktopDetailOutput, desktopDetail],
      [desktopPreviewOutput, desktopPreview],
      [mobileDefaultOutput, mobileDefault],
      [mobileDetailOutput, mobileDetail],
      [mobilePreviewOutput, mobilePreview]
    ])
    console.log(`desktopDefault=${desktopDefaultOutput}`)
    console.log(`desktopDetail=${desktopDetailOutput}`)
    console.log(`desktopPreview=${desktopPreviewOutput}`)
    console.log(`mobileDefault=${mobileDefaultOutput}`)
    console.log(`mobileDetail=${mobileDetailOutput}`)
    console.log(`mobilePreview=${mobilePreviewOutput}`)
  } finally {
    client?.close()
    await stopBrowser()
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
