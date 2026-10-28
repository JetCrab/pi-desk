import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
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
import { assertPortReleased, spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const taskId = `message-resend-${process.pid}`
const runRoot = join(projectRoot, 'temp/run/message-resend', taskId)
const fixtureRoot = join(projectRoot, 'temp/pi/message-resend-e2e', taskId)
const agentDir = join(fixtureRoot, 'agent')
const buildRoot = join(projectRoot, 'temp/build/message-resend', taskId)
const cwd = join(fixtureRoot, 'project')
const workId = 'resend-work'
const provider = 'resend-fixture'
const model = 'resend-model'
const image = (
  await sharp({ create: { width: 120, height: 80, channels: 3, background: '#999999' } })
    .png()
    .toBuffer()
).toString('base64')
const cancellationFlag = join(fixtureRoot, 'cancel-resend')
const originalText = '检查这张图片。\n保留这行文字并重新分析。'
const draftText = '尚未发送的下一条草稿'
const selectedMessage = `[...document.querySelectorAll('[data-chat-user-message]')].find(node => node.textContent.includes(${JSON.stringify(originalText)}))`
const usage = {
  input: 10,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
const requests = []
let serverOutput = ''
let holdResponse = false
let heldResponse
let modelError

function assistant(text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider,
    model,
    usage,
    stopReason: 'stop',
    timestamp: Date.now()
  }
}

async function fixture(modelPort) {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  await mkdir(join(cwd, '.pi'), { recursive: true })
  await mkdir(join(agentDir, 'extensions'), { recursive: true })
  await writeFile(
    join(agentDir, 'extensions/cancel-resend.ts'),
    `import { existsSync } from 'node:fs'
export default function(pi) {
  pi.on('session_before_tree', () => existsSync(${JSON.stringify(cancellationFlag)}) ? { cancel: true } : undefined)
}
`
  )
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      packages: [],
      extensions: [],
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: 'medium'
    })
  )
  await writeFile(
    join(agentDir, 'pi-desk-settings.json'),
    JSON.stringify({ region: { locale: 'zh-CN', timeZone: 'UTC' } })
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
              name: '重发验证',
              reasoning: true,
              input: ['text', 'image'],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const session = SessionManager.create(cwd)
  const root = session.appendMessage({
    role: 'user',
    content: '最初的问题。',
    timestamp: Date.now()
  })
  const parent = session.appendMessage(assistant('最初的回答。'))
  const selected = session.appendMessage({
    role: 'user',
    content: [
      { type: 'text', text: originalText },
      { type: 'image', mimeType: 'image/png', data: image }
    ],
    timestamp: Date.now()
  })
  const oldReply = session.appendMessage(assistant('旧回复：原有建议。'))
  session.appendMessage({ role: 'user', content: '继续补充细节。', timestamp: Date.now() })
  const oldTail = session.appendMessage(assistant('后续回复：历史内容保留。'))
  const tail = SessionManager.create(cwd)
  tail.appendModelChange(provider, model)
  const tailParent = tail.appendThinkingLevelChange('medium')
  const tailUser = tail.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '尚未收到回答的末尾消息。' }],
    timestamp: Date.now()
  })
  await mkdir(dirname(tail.getSessionFile()), { recursive: true })
  await writeFile(
    tail.getSessionFile(),
    [tail.getHeader(), ...tail.getEntries()].map((value) => JSON.stringify(value)).join('\n') + '\n'
  )
  await writeFile(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({
      workSessions: [
        { workId, cwd, sessionId: session.getSessionId() },
        { workId: 'resend-tail', cwd, sessionId: tail.getSessionId() }
      ],
      pinnedCount: 0
    })
  )
  return {
    sessionId: session.getSessionId(),
    file: session.getSessionFile(),
    root,
    parent,
    selected,
    oldReply,
    oldTail,
    original: session.getEntries(),
    tailSessionId: tail.getSessionId(),
    tailUser,
    tailParent,
    tailFile: tail.getSessionFile()
  }
}

function chunk(response, delta, finishReason = null) {
  response.write(
    `data: ${JSON.stringify({ id: 'resend-response', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
  )
}

async function waitUntil(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`等待超时：${label}；${modelError ?? ''}`)
}

async function entries(file) {
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== 'session')
}

function conversationPath(records, entryId) {
  const path = []
  for (
    let entry = records.find((value) => value.id === entryId);
    entry;
    entry = records.find((value) => value.id === entry.parentId)
  ) {
    if (
      entry.type === 'message' &&
      ['user', 'assistant', 'toolResult'].includes(entry.message.role)
    )
      path.unshift(entry.id)
  }
  return path
}

async function main() {
  let server, browser, page, modelServer, modelPort, cdpPort
  let succeeded = false
  const results = []
  try {
    await mkdir(runRoot, { recursive: true })
    modelPort = await reservePort()
    modelServer = createServer(async (request, response) => {
      try {
        assert.equal(request.url, '/v1/chat/completions')
        let body = ''
        for await (const part of request) body += part
        const input = JSON.parse(body)
        assert.equal(input.model, model)
        requests.push(input)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.flushHeaders()
        chunk(response, { role: 'assistant' })
        if (holdResponse) {
          heldResponse = response
          chunk(response, { content: '正在等待模型继续输出。' })
        } else {
          chunk(response, { content: `重发结果 ${requests.length}：图片和上下文已经重新分析。` })
          chunk(response, {}, 'stop')
          response.end('data: [DONE]\n\n')
        }
      } catch (error) {
        modelError = String(error)
        response.destroy(error)
      }
    })
    modelServer.listen(modelPort, '127.0.0.1')
    await once(modelServer, 'listening')
    const data = await fixture(modelPort)
    const appPort = await reservePort()
    const origin = `http://127.0.0.1:${appPort}`
    const api = async (path, body) => {
      const response = await fetch(`${origin}/api/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Pi-Desk-Client-Id': 'e1a51619-9715-408a-84b9-e55fe94c6782'
        },
        body: JSON.stringify(body)
      })
      return { status: response.status, ...(await response.json()) }
    }
    const branch = (entryId, action = 'resend', binding = { workId, sessionId: data.sessionId }) =>
      api('work-sessions/branch', { ...binding, entryId, action })
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
    await waitForHttp(`${origin}/api/health`, 60000, 'Pi Desk', () => serverOutput)
    cdpPort = await reservePort()
    browser = spawnEdge(
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      cdpPort,
      join(runRoot, 'browser'),
      '1280,900',
      ['--edge-skip-compat-layer-relaunch']
    )
    await waitForBrowserReady(browser, cdpPort)
    page = await createCdpPage(cdpPort)
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('pi-super:workbench-layout', JSON.stringify({ primaryWorkId: '${workId}' }));`
    })
    await setViewport(page, 1280, 900, false)
    await navigate(page, origin)
    await waitFor(
      page,
      `(${selectedMessage})?.querySelector('button') && [...document.querySelectorAll('textarea')].some(input => !input.disabled)`,
      '消息和输入框就绪',
      () => serverOutput,
      90000
    )
    await evaluate(page, `document.querySelector('textarea').focus()`)
    await page.send('Input.insertText', { text: draftText })
    await evaluate(
      page,
      `(async () => {
      const file = new File([Uint8Array.from(atob('${image}'), c => c.charCodeAt(0))], 'draft.png', {type:'image/png'});
      const transfer = new DataTransfer(); transfer.items.add(file);
      const input = document.querySelector('input[type="file"]');
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles:true }));
    })()`
    )
    await waitFor(
      page,
      `document.querySelector('[aria-label="发送消息"]')?.disabled === false && document.querySelector('textarea')?.value === '${draftText}' && document.querySelector('footer img')?.naturalWidth === 120`,
      '草稿图片准备好'
    )
    await evaluate(
      page,
      `(() => {
      const message = ${selectedMessage};
      const button = [...message.querySelectorAll('button')].find(item => item.textContent.trim() === '重发' || item.getAttribute('aria-label') === '重发');
      if (!button) throw new Error('重发按钮不存在');
      button.click(); button.click();
    })()`
    )
    await waitFor(
      page,
      `document.querySelector('[role="log"]')?.innerText.includes('重发结果 1')`,
      '自动重发并产生新回复',
      () => serverOutput
    )
    await waitUntil(
      async () =>
        (await entries(data.file)).some(
          (entry) =>
            entry.message?.role === 'assistant' &&
            JSON.stringify(entry.message.content).includes('重发结果 1')
        ),
      '新回复落盘'
    )
    assert.equal(requests.length, 1, '连续点击不能发送两次')
    assert.equal(await evaluate(page, `document.querySelector('textarea')?.value`), draftText)
    assert.equal(await evaluate(page, `document.querySelector('footer img')?.naturalWidth`), 120)
    const newEntries = await entries(data.file)
    for (const old of data.original)
      assert.deepEqual(
        newEntries.find((entry) => entry.id === old.id),
        old
      )
    const newUser = newEntries.find(
      (entry) => entry.message?.role === 'user' && !data.original.some((old) => old.id === entry.id)
    )
    assert.ok(newUser)
    assert.deepEqual(conversationPath(newEntries, newUser.id), [data.root, data.parent, newUser.id])
    assert.deepEqual(
      newUser.message.content,
      data.original.find((entry) => entry.id === data.selected).message.content
    )
    const providerUser = requests[0].messages.filter((message) => message.role === 'user').at(-1)
    assert.ok(JSON.stringify(providerUser).includes(originalText.replaceAll('\n', '\\n')))
    assert.ok(JSON.stringify(providerUser).includes(image))
    assert.ok(!JSON.stringify(requests[0].messages).includes('继续补充细节'))
    assert.ok(!JSON.stringify(requests[0].messages).includes(draftText))
    results.push('文字和图片重发、旧分支完整、模型上下文正确、重复点击仅发送一次、文字草稿保留')

    const returned = await branch(data.oldTail, 'tree')
    assert.equal(returned.code, 0, returned.msg)
    assert.equal(returned.data.workSessions.length, 2)
    assert.equal(returned.data.targetWorkId, workId)
    await waitFor(
      page,
      `document.querySelector('[role="log"]')?.innerText.includes('后续回复：历史内容保留')`,
      '旧分支恢复'
    )
    const actionStyles = `(() => {
      const message = ${selectedMessage};
      return [...message.querySelectorAll('button')]
        .filter(button => ['重发', '复制消息'].includes(button.textContent.trim()))
        .map(button => ({
          label: button.textContent.trim(),
          opacity: getComputedStyle(button).opacity,
          pointerEvents: getComputedStyle(button).pointerEvents
        }));
    })()`
    const expectedActions = (visible) =>
      ['重发', '复制消息'].map((label) => ({
        label,
        opacity: visible ? '1' : '0',
        pointerEvents: visible ? 'auto' : 'none'
      }))
    for (const [name, width, height, mobile, theme] of [
      ['desktop-light', 1280, 900, false, 'light'],
      ['desktop-dark', 1280, 900, false, 'dark'],
      ['mobile-light', 390, 844, true, 'light'],
      ['mobile-dark', 390, 844, true, 'dark']
    ]) {
      await setViewport(page, width, height, mobile)
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
      await evaluate(
        page,
        `document.documentElement.classList.toggle('dark', '${theme}' === 'dark');
        document.querySelector('textarea').focus({ preventScroll: true });
        (${selectedMessage})?.scrollIntoView({ block:'center' });`
      )
      await waitFor(
        page,
        `(${selectedMessage})?.getBoundingClientRect().top > 0`,
        '消息操作栏位于视口内'
      )
      await waitFor(
        page,
        `JSON.stringify(${actionStyles}) === ${JSON.stringify(JSON.stringify(expectedActions(mobile)))}`,
        `${name}默认显示状态`
      )
      if (!mobile) {
        await evaluate(
          page,
          `[...(${selectedMessage}).querySelectorAll('button')].find(button => button.textContent.trim() === '重发').focus()`
        )
        await waitFor(
          page,
          `JSON.stringify(${actionStyles}) === ${JSON.stringify(JSON.stringify(expectedActions(true)))}`,
          `${name}键盘聚焦显示`
        )
        await evaluate(page, `document.querySelector('textarea').focus({ preventScroll: true })`)
        const point = await evaluate(
          page,
          `(() => {
          const rect = (${selectedMessage}).getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + 8 };
        })()`
        )
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
        await waitFor(
          page,
          `(${actionStyles}).every(action => action.opacity === '1' && action.pointerEvents === 'auto')`,
          '悬停同时显示重发和复制'
        )
        assert.deepEqual(
          await evaluate(page, actionStyles),
          expectedActions(true),
          `${name}悬停显示`
        )
      }
      await writeFile(join(runRoot, `${name}.png`), await screenshot(page))
    }
    results.push('旧分支可恢复；桌面重发与复制默认隐藏、悬停和聚焦显示，窄屏常驻；明暗主题截图')
    await setViewport(page, 1280, 900, false)
    const leafBefore = await api('work-session-tree/get', { workId, sessionId: data.sessionId })
    for (const [entry, binding, status] of [
      [data.oldReply, undefined, 400],
      ['missing-entry', undefined, 404],
      [data.selected, { workId, sessionId: '00000000-0000-4000-8000-000000000000' }, 409]
    ]) {
      const result = await branch(entry, 'resend', binding)
      assert.equal(result.status, status, JSON.stringify(result))
    }
    assert.equal(requests.length, 1)
    const unchanged = await api('work-session-tree/get', { workId, sessionId: data.sessionId })
    assert.equal(unchanged.data.leafEntryId, leafBefore.data.leafEntryId)
    results.push('非用户节点、缺失节点和过期会话绑定均拒绝，不发送')

    await writeFile(cancellationFlag, '')
    await evaluate(
      page,
      `[...(${selectedMessage}).querySelectorAll('button')].find(button => button.textContent.trim() === '重发').click()`
    )
    await waitFor(page, `document.body.innerText.includes('分支切换已取消')`, '导航取消错误可见')
    const cancelledTail = await branch(data.tailUser, 'resend', {
      workId: 'resend-tail',
      sessionId: data.tailSessionId
    })
    assert.equal(cancelledTail.status, 409, JSON.stringify(cancelledTail))
    assert.equal(requests.length, 1)
    const afterCancel = await api('work-session-tree/get', { workId, sessionId: data.sessionId })
    assert.equal(afterCancel.data.leafEntryId, unchanged.data.leafEntryId)
    await rm(cancellationFlag)
    results.push('普通节点与末尾节点导航钩子取消均不发送，界面显示错误')

    const rootResult = await branch(data.root)
    assert.equal(rootResult.code, 0, rootResult.msg)
    await waitFor(
      page,
      `document.querySelector('[role="log"]')?.innerText.includes('重发结果 2')`,
      '首条消息重发'
    )
    await waitUntil(
      async () =>
        (await entries(data.file)).some(
          (entry) =>
            entry.message?.role === 'assistant' &&
            JSON.stringify(entry.message.content).includes('重发结果 2')
        ),
      '首条重发落盘'
    )
    const rootRecords = await entries(data.file)
    const newRoot = rootRecords.filter((entry) => entry.message?.role === 'user').at(-1)
    assert.notEqual(newRoot.id, data.root)
    assert.deepEqual(conversationPath(rootRecords, newRoot.id), [newRoot.id])
    assert.deepEqual(
      requests[1].messages
        .filter((message) => message.role === 'user')
        .map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
        ),
      ['最初的问题。']
    )
    const tailResult = await branch(data.tailUser, 'resend', {
      workId: 'resend-tail',
      sessionId: data.tailSessionId
    })
    assert.equal(tailResult.code, 0, tailResult.msg)
    await waitUntil(
      async () =>
        (await entries(data.tailFile)).filter((entry) => entry.message?.role === 'user').length ===
        2,
      '末尾用户消息重发'
    )
    const tailRecords = await entries(data.tailFile)
    const tailUsers = tailRecords.filter((entry) => entry.message?.role === 'user')
    assert.equal(tailUsers[0].parentId, data.tailParent)
    assert.deepEqual(conversationPath(tailRecords, tailUsers[1].id), [tailUsers[1].id])
    await waitUntil(
      async () =>
        (await entries(data.tailFile)).some(
          (entry) =>
            entry.message?.role === 'assistant' &&
            JSON.stringify(entry.message.content).includes('重发结果 3')
        ),
      '末尾重发回复落盘'
    )
    results.push('无父节点首条及当前末尾用户消息均生成兄弟分支')

    holdResponse = true
    const running = await branch(data.selected)
    assert.equal(running.code, 0, running.msg)
    await waitFor(
      page,
      `document.querySelector('[role="log"]')?.innerText.includes('正在等待模型继续输出')`,
      '模型运行中'
    )
    const count = requests.length
    const busy = await branch(data.selected)
    assert.equal(busy.status, 409, JSON.stringify(busy))
    await evaluate(
      page,
      `(() => {
      const buttons = [...document.querySelectorAll('[data-chat-user-message] button')];
      buttons.find(button => button.textContent.trim() === '重发')?.click();
    })()`
    )
    await waitFor(
      page,
      `document.body.innerText.includes('确认并继续') && document.body.innerText.includes('从这条消息重新发送')`,
      '运行中重发确认'
    )
    holdResponse = false
    await evaluate(
      page,
      `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '确认并继续').click()`
    )
    await waitFor(
      page,
      `document.querySelector('[role="log"]')?.innerText.includes('重发结果 ${count + 1}')`,
      '停止旧响应后重发',
      () => serverOutput
    )
    assert.equal(requests.length, count + 1)
    results.push('运行中 API 拒绝；界面确认后停止旧响应并重发')
    assert.equal(modelError, undefined)
    succeeded = true
    await writeFile(
      join(runRoot, 'result.json'),
      JSON.stringify({ results, requests: requests.length }, null, 2)
    )
    console.log(JSON.stringify({ results, runRoot }, null, 2))
  } catch (error) {
    await writeFile(join(runRoot, 'server.log'), serverOutput)
    if (page)
      await Promise.race([
        screenshot(page).then((bytes) => writeFile(join(runRoot, 'failure.png'), bytes)),
        new Promise((resolveWait) => setTimeout(resolveWait, 3000))
      ]).catch(() => undefined)
    throw error
  } finally {
    page?.close()
    if (browser) await stopBrowserTree(browser, cdpPort)
    if (server) await stopE2eServerTree(server)
    heldResponse?.destroy()
    if (modelServer) {
      modelServer.closeAllConnections()
      await new Promise((resolveClose) => modelServer.close(resolveClose))
      await assertPortReleased(modelPort)
    }
    if (succeeded) {
      await rm(fixtureRoot, { recursive: true, force: true })
      await rm(buildRoot, { recursive: true, force: true })
      await rm(join(runRoot, 'browser'), { recursive: true, force: true })
    }
  }
}

await main()
