import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, relative, resolve } from 'node:path'
import WebSocket from 'ws'
import {
  assertPortReleased,
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'
import {
  clickText,
  createCdpPage,
  evaluate,
  navigate,
  reservePort,
  screenshot,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'

const projectRoot = resolve('.')
const runId = `hot-update-${Date.now()}-${process.pid}`
const runRoot = join(projectRoot, 'temp/pi/l1-plugin-apply', runId)
const nextDirectory = process.env.PI_PLUGIN_APPLY_E2E_NEXT_DIR
  ? resolve(process.env.PI_PLUGIN_APPLY_E2E_NEXT_DIR)
  : join(runRoot, 'next')
const agentDir = join(runRoot, 'agent')
const workspace = join(runRoot, 'workspace')
const pluginRoot = join(agentDir, 'extensions/hot-fixture')
const removableRoot = join(runRoot, 'removable-package')
const evidence = join(projectRoot, 'temp/run/plugin-hot-update', runId)
const clientId = randomUUID()
const frames = []
const browserErrors = []
const outcomes = []
const operationEvents = []
const lastOperations = new Map()
const cleanupErrors = []
let app
let browser
let page
let socket
let model
let modelPort
let port
let cdpPort
let held
let repairSent = false
let repairToolFailure = null
let logs = ''
let stage = 'prepare'
let failure
let tsconfigBefore
let nextEnvBefore
const modelRequests = []
const started = Date.now()

async function bounded(promise, label, milliseconds = 30000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时`)), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until(predicate, label, milliseconds = 45000) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) {
    if (await predicate()) return
    if (app && app.child.exitCode !== null) throw new Error(`${label}期间服务退出`)
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`${label}超时`)
}

async function write(path, text) {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

function modelReply(call, tool = false) {
  if (call.response.destroyed || call.response.writableEnded) return
  const base = {
    id: `chatcmpl-${call.index}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'local-model'
  }
  if (!call.response.headersSent)
    call.response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `repair-${call.index}`,
            type: 'function',
            function: {
              name: 'pidesk',
              arguments: JSON.stringify({
                args: ['plugins', 'install', 'hot-fixture', '--scope', 'global']
              })
            }
          }
        ]
      }
    : { role: 'assistant', content: `隔离模型回复 ${call.index}` }
  call.response.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
  )
  call.response.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 } })}\n\n`
  )
  call.response.end('data: [DONE]\n\n')
}

async function startModel() {
  model = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const call = { body: JSON.parse(body), response, index: modelRequests.length + 1 }
      modelRequests.push(call)
      for (const message of call.body.messages ?? []) {
        if (message.role !== 'tool' || !message.tool_call_id?.startsWith('repair-')) continue
        try {
          if (JSON.parse(message.content).mode !== 'async') repairToolFailure = message.content
        } catch {
          repairToolFailure = message.content
        }
      }
      if (call.index === 1) {
        held = call
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(
          `data: ${JSON.stringify({ id: 'held', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'local-model', choices: [{ index: 0, delta: { role: 'assistant', content: '持续运行中的旧会话。' }, finish_reason: null }] })}\n\n`
        )
      } else if (!repairSent && body.includes('repair-via-pidesk')) {
        repairSent = true
        modelReply(call, true)
      } else modelReply(call)
    })
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  modelPort = model.address().port
}

async function writePlugin(version, broken = false) {
  await write(
    join(pluginRoot, 'package.json'),
    JSON.stringify({
      name: 'hot-fixture',
      version: `1.0.${version}`,
      type: 'module',
      pi: { extensions: ['./native.mjs'] },
      piDesk: { entry: './node.mjs' }
    })
  )
  await write(join(pluginRoot, 'helper.mjs'), `export const version = ${version}`)
  await write(
    join(pluginRoot, 'native.mjs'),
    broken
      ? `export default () => { throw new Error('broken-native-fixture') }`
      : `
    import { version } from './helper.mjs'
    export default (pi) => {
      pi.registerTool({ name: 'fixture_tool_v${version}', label: 'Fixture', description: 'Isolated fixture',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ content: [{ type: 'text', text: String(version) }], details: {} })
      })
    }
  `
  )
  await write(
    join(pluginRoot, 'node.mjs'),
    `
    import { version } from './helper.mjs'
    export default { name: 'hot-fixture', setup(plugin) {
      plugin.registerMethod('version', async () => ({ version }))
      plugin.registerBrowserEntry('./browser/entry.js')
      return () => { ${version === 1 ? "throw new Error('old-cleanup-fixture')" : ''} }
    } }
  `
  )
  await write(
    join(pluginRoot, 'browser/entry.js'),
    `export default plugin => {
    plugin.registerContribution('application', 'demo', {
      label: '热更新验收应用', title: '热更新验收应用', icon: { type: 'builtin', name: 'plugin' },
      load: () => import('./panel.js').then(module => module.default)
    })
  }`
  )
  await write(
    join(pluginRoot, 'browser/panel.js'),
    `export default {
    mount({ container, host }) {
      const panel = document.createElement('section')
      panel.style.cssText = 'padding:24px;width:420px;max-width:100%;color:var(--foreground);background:var(--background)'
      const title = document.createElement('h2')
      title.style.cssText = 'font-size:18px;font-weight:600;margin:0 0 12px'
      title.textContent = '外层界面 v${version}'
      const service = document.createElement('p')
      service.setAttribute('role', 'status')
      service.textContent = '查询插件服务…'
      const hint = document.createElement('p')
      hint.style.cssText = 'font-size:14px;color:var(--muted-foreground);margin-top:16px'
      hint.textContent = '外层允许替换，旧 Pi 会话继续运行；新会话使用新版扩展。'
      panel.append(title, service, hint)
      container.append(panel)
      void host.piDesk.invokeGlobal('version', {}).then(result => { service.textContent = '服务版本 v' + result.version })
      return async () => {
        ${version === 1 ? 'await new Promise(resolve => { globalThis.releaseOldHotView = resolve })' : ''}
        container.replaceChildren()
      }
    }
  }`
  )
}

async function post(path, body) {
  const response = await bounded(
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pi-Desk-Client-Id': clientId,
        Origin: `http://127.0.0.1:${port}`
      },
      body: JSON.stringify(body)
    }),
    path
  )
  const envelope = await response.json()
  assert.equal(envelope.code, 0, `${path}: ${envelope.msg}`)
  if (path === '/api/plugins/list') {
    for (const plugin of envelope.data.plugins) {
      const value = JSON.stringify(plugin.operation)
      if (lastOperations.get(plugin.source) === value) continue
      lastOperations.set(plugin.source, value)
      operationEvents.push({
        elapsedMs: Date.now() - started,
        source: plugin.source,
        operation: plugin.operation
      })
    }
  }
  return envelope.data
}

async function rpc(path, body = {}) {
  const requestId = randomUUID()
  let receive
  const promise = new Promise((done) => {
    receive = (data) => {
      const frame = JSON.parse(data.toString())
      if (frame.head?.op === 'resp' && frame.head.requestId === requestId) done(frame.body)
    }
    socket.on('message', receive)
  })
  socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
  try {
    const result = await bounded(promise, path, 45000)
    assert.equal(result.code, 0, `${path}: ${result.msg}`)
    return result.data
  } finally {
    socket.off('message', receive)
  }
}

async function newSession() {
  const { workSession } = await post('/api/work-sessions/add', { cwd: workspace })
  const source = {
    workId: workSession.workId,
    sessionId: workSession.sessionId,
    branchId: workSession.branchId
  }
  await rpc('chat/subscribe', { subscriptions: [{ source, cursor: null }] })
  return source
}

async function tools(source) {
  return (await rpc('pi/tools/list', { source })).tools.map((tool) => tool.name)
}

async function idle(source) {
  await until(async () => {
    const list = await rpc('work-sessions/list')
    return !['main_running', 'background_running'].includes(
      list.workSessions.find((item) => item.workId === source.workId)?.status
    )
  }, '会话结束执行')
}

async function applied(source, expected = 'complete') {
  let last
  await until(async () => {
    const snapshot = await post('/api/plugins/list', {})
    last = snapshot.plugins.find((item) => item.source === source)
    if (last?.operation?.phase === 'failed' && expected !== 'failed')
      throw new Error(last.operation.message)
    if (expected === 'failed') return last?.operation?.phase === 'failed'
    assert.equal(snapshot.restartRequired, false)
    return last && last.operation === null
  }, `插件应用 ${expected}`)
  return last
}

async function run() {
  await mkdir(evidence, { recursive: true })
  tsconfigBefore = await readFile('tsconfig.json', 'utf8')
  nextEnvBefore = await readFile('next-env.d.ts', 'utf8')
  await prepareIsolatedPiDirectory(agentDir)
  await mkdir(workspace, { recursive: true })
  await startModel()
  await writePlugin(1)
  await write(
    join(removableRoot, 'package.json'),
    JSON.stringify({
      name: 'removable-package',
      type: 'module',
      pi: { extensions: ['./native.mjs'] }
    })
  )
  await write(
    join(removableRoot, 'native.mjs'),
    `export default pi => pi.registerTool({
    name: 'removable_tool', label: 'Removable', description: 'Package remove fixture',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'old package' }], details: {} })
  })`
  )
  await write(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      packages: [removableRoot],
      defaultProvider: 'loopback',
      defaultModel: 'local-model',
      defaultThinkingLevel: 'off',
      retry: { enabled: false },
      compaction: { enabled: false }
    })
  )
  await write(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        loopback: {
          api: 'openai-completions',
          apiKey: 'fixture-only',
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          models: [
            {
              id: 'local-model',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 256
            }
          ]
        }
      }
    })
  )
  const unrelated = join(agentDir, 'extensions/unrelated')
  await write(
    join(unrelated, 'package.json'),
    JSON.stringify({ name: 'unrelated', piDesk: { entry: './entry.mjs' } })
  )
  await write(
    join(unrelated, 'entry.mjs'),
    `export default { name: 'unrelated', setup(plugin) {
    plugin.registerMethod('ping', async () => ({ ok: true }))
    plugin.registerBrowserEntry('./browser/entry.js')
  } }`
  )
  await write(join(unrelated, 'browser/entry.js'), 'export default () => undefined')
  port = await reservePort()
  stage = 'service-startup'
  app = spawnE2eServer({
    projectRoot,
    agentDir,
    port,
    development: true,
    nextDirectory,
    onOutput: (text) => {
      logs += text
    }
  })
  await waitForHttp(`http://127.0.0.1:${port}/api/health`, 120000, '隔离服务', () =>
    logs.slice(-4000)
  )
  await until(() => logs.includes('开发服务已启动'), '开发服务就绪', 120000)
  const pid = app.child.pid
  socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?clientId=${clientId}`, 'pi-desk.v1')
  socket.on('message', (data) => {
    frames.push(JSON.parse(data.toString()))
  })
  await bounded(once(socket, 'open'), '应用连接')
  await rpc('work-sessions/list')
  await bounded(
    fetch(`http://127.0.0.1:${port}`).then((response) => response.text()),
    '工作台编译预热',
    120000
  )
  await until(
    async () =>
      (await post('/api/plugins/list', {})).plugins.some(
        (item) => item.pluginName === 'hot-fixture' && item.status === 'ready'
      ),
    '外层插件初始化'
  )
  const listed = await post('/api/plugins/list', {})
  const source = listed.plugins.find((item) => item.pluginName === 'hot-fixture').source
  const removableSource = listed.plugins.find(
    (item) => item.kind === 'package' && item.source.endsWith('removable-package')
  ).source
  const before = (await rpc('plugins/browser-entries/list')).entries
  let a = await newSession()
  assert.ok((await tools(a)).includes('fixture_tool_v1'))
  assert.ok((await tools(a)).includes('removable_tool'))
  for (const entry of before) {
    await bounded(
      fetch(`http://127.0.0.1:${port}${entry.url}`).then((response) => response.text()),
      'Browser资源预热'
    )
  }

  stage = 'browser-startup'
  cdpPort = await reservePort()
  browser = spawnEdge(
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    cdpPort,
    join(runRoot, 'edge-profile')
  )
  await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 30000, '隔离浏览器')
  page = await createCdpPage(cdpPort)
  page.events.set('Runtime.exceptionThrown', new Set([(event) => browserErrors.push(event)]))
  page.events.set(
    'Runtime.consoleAPICalled',
    new Set([
      (event) => {
        if (event.type === 'error') browserErrors.push(event)
      }
    ])
  )
  await bounded(navigate(page, `http://127.0.0.1:${port}`), '工作台页面', 120000)
  await waitFor(
    page,
    `document.body.innerText.includes('热更新验收应用')`,
    '插件应用入口',
    () => logs.slice(-2000),
    45000
  )
  await clickText(page, '热更新验收应用')
  await waitFor(
    page,
    `document.body.innerText.includes('外层界面 v1') && document.body.innerText.includes('服务版本 v1')`,
    'v1活动应用'
  )

  stage = 'mixed-plugin-hot-update'
  const inputA = await rpc('chat/send', {
    source: a,
    mode: 'auto',
    text: 'hold-running-chat',
    images: []
  })
  await until(() => Boolean(held), 'A模型请求运行中')
  await writePlugin(2)
  await post('/api/plugins/apply', { sources: [source] })
  await applied(source)
  assert.equal(held.response.destroyed, false, '外层升级不能中止A的模型请求')
  assert.equal(app.child.pid, pid)
  assert.equal(app.child.exitCode, null)
  assert.equal(socket.readyState, WebSocket.OPEN)
  assert.ok((await tools(a)).includes('fixture_tool_v1'))
  await post('/api/plugins/del', { source: removableSource })
  await until(async () => {
    const snapshot = await post('/api/plugins/list', {})
    assert.equal(snapshot.restartRequired, false)
    const item = snapshot.plugins.find((plugin) => plugin.source === removableSource)
    if (item?.operation?.phase === 'failed') throw new Error(item.operation.message)
    return !item
  }, '运行中卸载Package')
  assert.equal(held.response.destroyed, false)
  assert.ok((await tools(a)).includes('removable_tool'), '已运行会话保留已卸载包的扩展')
  const b = await newSession()
  assert.ok((await tools(b)).includes('fixture_tool_v2'))
  assert.equal((await tools(b)).includes('removable_tool'), false)
  outcomes.push('真实Package卸载不等待A结束；A保留旧工具，新会话不加载已移除包')
  const after = (await rpc('plugins/browser-entries/list')).entries
  assert.notEqual(
    after.find((item) => item.pluginName === 'hot-fixture').url,
    before.find((item) => item.pluginName === 'hot-fixture').url
  )
  assert.equal(
    after.find((item) => item.pluginName === 'unrelated').url,
    before.find((item) => item.pluginName === 'unrelated').url
  )
  assert.deepEqual(
    await rpc('plugins/invoke', {
      scope: 'global',
      pluginName: 'unrelated',
      method: 'ping',
      input: {}
    }),
    { ok: true }
  )
  await waitFor(
    page,
    `document.body.innerText.includes('外层界面 v2') && document.body.innerText.includes('服务版本 v2')`,
    '活动应用自动重挂v2'
  )
  await evaluate(page, `globalThis.releaseOldHotView?.()`)
  await waitFor(page, `document.body.innerText.includes('外层界面 v2')`, '旧清理未删除新界面')
  await writeFile(join(evidence, '应用热更新__运行中.png'), await screenshot(page))
  outcomes.push('A持续运行且保留v1；B使用v2；服务和活动界面实时v2；旧清理与其他插件隔离')

  stage = 'session-branch-and-reload'
  modelReply(held)
  await idle(a)
  const userCommit = frames.find(
    (frame) =>
      frame.body?.source?.workId === a.workId &&
      frame.body?.event?.type === 'message_commit' &&
      frame.body.event.location?.tempId === inputA.tempId
  )
  assert.ok(userCommit, '应有真实用户消息持久化提交')
  await post('/api/work-sessions/branch', {
    workId: a.workId,
    sessionId: a.sessionId,
    entryId: userCommit.body.event.durable.entryId,
    action: 'tree'
  })
  const changed = (await rpc('work-sessions/list')).workSessions.find(
    (item) => item.workId === a.workId
  )
  a = { workId: changed.workId, sessionId: changed.sessionId, branchId: changed.branchId }
  await rpc('chat/subscribe', { subscriptions: [{ source: a, cursor: null }] })
  assert.ok((await tools(a)).includes('fixture_tool_v1'), '分支重建必须保持旧代码')
  await rpc('chat/reload', { source: a })
  assert.ok((await tools(a)).includes('fixture_tool_v2'))
  assert.ok((await tools(b)).includes('fixture_tool_v2'))
  outcomes.push('同会话分支重建保留v1；手动reload只将A切换v2')

  stage = 'basic-session-repair'
  await writePlugin(3, true)
  await post('/api/plugins/apply', { sources: [source] })
  await applied(source, 'failed')
  assert.deepEqual(
    await rpc('plugins/invoke', {
      scope: 'global',
      pluginName: 'hot-fixture',
      method: 'version',
      input: {}
    }),
    { version: 2 }
  )
  const c = await newSession()
  const basicTools = await tools(c)
  assert.ok(basicTools.includes('pidesk'))
  assert.equal(
    basicTools.some((name) => name.startsWith('fixture_tool_')),
    false
  )
  assert.ok(
    frames.some(
      (frame) =>
        frame.body?.source?.workId === c.workId &&
        frame.body?.event?.runtime?.extensionMode === 'basic'
    )
  )
  await writePlugin(3)
  await rpc('chat/send', { source: c, mode: 'auto', text: 'repair-via-pidesk', images: [] })
  await until(
    () => {
      if (repairToolFailure) throw new Error(`pidesk工具执行失败：${repairToolFailure}`)
      return modelRequests.some((call) => JSON.stringify(call.body.messages).includes('外层已更新'))
    },
    '无扩展会话收到pidesk成功通知',
    60000
  )
  const repaired = await applied(source)
  assert.equal(repaired.error, null, '成功修复后不能继续使用旧Native失败诊断')
  await waitFor(
    page,
    `document.body.innerText.includes('外层界面 v3') && document.body.innerText.includes('服务版本 v3')`,
    'AI命令应用后视图实时v3'
  )
  await idle(c)
  await rpc('chat/reload', { source: c, mode: 'normal' })
  assert.ok((await tools(c)).includes('fixture_tool_v3'))
  assert.ok((await tools(a)).includes('fixture_tool_v2'))
  assert.equal(app.child.pid, pid)
  assert.equal(app.child.exitCode, null)
  await writeFile(join(evidence, '应用热更新__修复完成.png'), await screenshot(page))
  outcomes.push(
    '坏Native候选不影响外层旧版和运行会话；基础会话通过真实模型pidesk调用修复，再手动启用新版'
  )
}

try {
  await bounded(run(), '定向热更新E2E', 300000)
} catch (error) {
  failure = error
  console.error(`[${stage}]`, error)
  if (page) {
    try {
      await writeFile(
        join(evidence, 'failure.png'),
        await bounded(screenshot(page), '失败截图', 5000)
      )
      await writeFile(
        join(evidence, 'failure-dom.txt'),
        await bounded(evaluate(page, 'document.body.innerText'), '失败DOM', 5000)
      )
    } catch (captureError) {
      console.error('采集失败现场失败', captureError)
    }
  }
} finally {
  page?.close()
  socket?.terminate()
  const clean = async (label, action) => {
    try {
      await action()
    } catch (error) {
      cleanupErrors.push(`${label}: ${String(error)}`)
    }
  }
  if (browser) await clean('浏览器进程树', () => stopBrowserTree(browser, cdpPort))
  if (app) await clean('服务进程树', () => stopE2eServerTree(app))
  if (model)
    await clean('模拟模型端口', async () => {
      model.closeAllConnections()
      await new Promise((done, reject) => model.close((error) => (error ? reject(error) : done())))
      await assertPortReleased(modelPort)
    })
  await clean('Next生成配置', async () => {
    const current = await readFile('tsconfig.json', 'utf8')
    const marker = `${relative(projectRoot, nextDirectory).replaceAll('\\', '/')}/`
    const restored = current
      .split('\n')
      .filter((line) => !line.includes(marker))
      .join('\n')
    if (restored !== current) {
      const normalized = restored.replace(/,(\s*[\]}])/g, '$1')
      const original = tsconfigBefore.replace(/,(\s*[\]}])/g, '$1')
      await writeFile(
        'tsconfig.json',
        JSON.stringify(JSON.parse(normalized)) === JSON.stringify(JSON.parse(original))
          ? tsconfigBefore
          : restored
      )
    }
    const nextEnv = await readFile('next-env.d.ts', 'utf8')
    if (nextEnv.includes(marker) && nextEnvBefore) await writeFile('next-env.d.ts', nextEnvBefore)
    if (!tsconfigBefore) throw new Error('未读取初始tsconfig')
  })
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'server.log'), logs)
  await writeFile(join(evidence, 'browser-errors.json'), JSON.stringify(browserErrors, null, 2))
  if (failure)
    await writeFile(
      join(evidence, 'source-events.json'),
      JSON.stringify(
        frames.filter((frame) => frame.head?.path === 'chat/source-event'),
        null,
        2
      )
    )
  await writeFile(
    join(evidence, 'report.json'),
    JSON.stringify(
      {
        success: !failure && cleanupErrors.length === 0,
        stage,
        nextDirectory,
        outcomes,
        operationEvents,
        error: failure?.stack ?? null,
        cleanupErrors,
        durationMs: Date.now() - started,
        port,
        cdpPort,
        modelPort
      },
      null,
      2
    )
  )
  console.info(`验收记录：${evidence}`)
  if (failure || cleanupErrors.length) process.exitCode = 1
}
