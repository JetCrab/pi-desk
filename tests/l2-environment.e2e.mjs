import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
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
  waitForBrowserReady,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const taskId = `selective-restore-${process.pid}`
const testRoot = join(projectRoot, 'temp/pi/environment-e2e', taskId)
const agentDir = join(testRoot, 'agent')
const sourceAgent = join(testRoot, 'source/agent')
const sourceProject = join(testRoot, 'projects/source-project')
const targetProject = join(testRoot, 'projects/target-project')
const evidence = join(projectRoot, 'temp/run/environment-backup', taskId)
const archivePath = join(evidence, 'fixture.pdesk')
const keyPath = join(testRoot, 'test-key')
const password = 'test-only-backup-password-93'
const clientId = randomUUID()
let server
let browser
let client
let origin = ''
let output = ''
let success = false
let sourceSessionId = ''
let childSessionId = ''
let existingSessionFile = ''

async function put(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data
  )
}

async function post(path, body, allowError = false) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  })
  const envelope = await response.json()
  if (!allowError) {
    assert.equal(response.ok, true, `${path}: ${envelope.msg}\n${output.slice(-12000)}`)
    assert.equal(envelope.code, 0, `${path}: ${envelope.msg}`)
  }
  return { response, envelope, data: envelope.data }
}

async function waitOperation(id, expected) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    let response
    try {
      response = await fetch(`${origin}/api/environment/get-operation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(15000)
      })
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200))
      continue
    }
    if (response.status === 503) {
      await response.body?.cancel()
      await new Promise((resolveWait) => setTimeout(resolveWait, 200))
      continue
    }
    const envelope = await response.json()
    assert.equal(response.ok, true, envelope.msg)
    assert.equal(envelope.code, 0, envelope.msg)
    if (envelope.data.status === 'failed')
      throw new Error(`${envelope.data.error}\n${output.slice(-18000)}`)
    if (envelope.data.status === expected) return envelope.data
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  throw new Error(`环境维护未到达 ${expected}\n${output.slice(-18000)}`)
}

async function upload() {
  const response = await fetch(`${origin}/api/environment/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Pi-Desk-Client-Id': clientId },
    body: await readFile(archivePath)
  })
  const envelope = await response.json()
  assert.equal(response.ok, true, envelope.msg)
  assert.equal(envelope.code, 0, envelope.msg)
  return envelope.data.id
}

async function sessionsBelow(directory) {
  const files = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) files.push(...(await sessionsBelow(path)))
    else if (item.name.endsWith('.jsonl')) files.push(path)
  }
  return files
}

async function setup() {
  await mkdir(evidence, { recursive: true })
  await mkdir(targetProject, { recursive: true })
  await mkdir(sourceProject, { recursive: true })
  await put(keyPath, randomBytes(32))
  // 原生 Pi 还会发现 HOME/.agents/skills，AgentDir 隔离之外也绑定测试 HOME。
  process.env.HOME = join(testRoot, 'home')
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  process.env.TSX_TSCONFIG_PATH = join(projectRoot, 'tsconfig.json')
  process.env.PI_OFFLINE = '1'
  process.env.PI_DESK_SECRET_KEY_FILE = keyPath
  for (const key of [
    'PI_DESK_DESKTOP_ENVIRONMENT_VERSION',
    'PI_DESK_DESKTOP_EXECUTABLE',
    'PI_DESK_DESKTOP_CONFIG'
  ])
    delete process.env[key]
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: '隔离验收历史，不调用模型。' }],
    api: 'openai-responses',
    provider: 'fixture',
    model: 'fixture-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  }
  function populate(session, text) {
    session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: Date.now()
    })
    session.appendMessage(assistant)
  }
  const existing = SessionManager.create(targetProject)
  populate(existing, '目标机器原有会话')
  existingSessionFile = existing.getSessionFile()
  const parent = SessionManager.create(sourceProject, join(sourceAgent, 'sessions/source-project'))
  populate(parent, '需要恢复的项目会话')
  sourceSessionId = parent.getSessionId()
  const child = SessionManager.create(
    sourceProject,
    join(parent.getSessionDir(), 'subagents', sourceSessionId),
    { parentSession: parent.getSessionFile() }
  )
  populate(child, '关联子代理会话')
  childSessionId = child.getSessionId()
  parent.appendMessage({
    ...assistant,
    stopReason: 'toolUse',
    content: [
      {
        type: 'toolCall',
        id: 'fixture-agent-call',
        name: 'agent',
        arguments: { description: '隔离子会话', subagent_type: 'dev', prompt: 'fixture' }
      }
    ]
  })
  parent.appendMessage({
    role: 'toolResult',
    toolCallId: 'fixture-agent-call',
    toolName: 'agent',
    content: [{ type: 'text', text: '子代理已完成。' }],
    details: { sessionFile: child.getSessionFile() },
    isError: false,
    timestamp: Date.now()
  })
  parent.appendMessage(assistant)
  await put(join(agentDir, 'settings.json'), { packages: [], enableInstallTelemetry: false })
  await put(join(agentDir, 'config/pi-desk-settings.json'), {
    region: { locale: 'zh-CN', timeZone: 'UTC' }
  })
  await put(join(agentDir, 'config/e2e-setting.json'), { value: 'target-original' })
  await put(join(agentDir, 'pi-desk/work-sessions.json'), {
    workSessions: [
      { workId: 'existing-work', cwd: targetProject, sessionId: existing.getSessionId() }
    ],
    pinnedCount: 1
  })
  await put(join(agentDir, 'trust.json'), {})
  await put(join(agentDir, 'models-store.json'), {})
  await put(join(sourceAgent, 'settings.json'), { packages: [], enableInstallTelemetry: false })
  await put(join(sourceAgent, 'config/e2e-setting.json'), { value: 'source-restored' })
  await put(join(sourceAgent, 'pi-desk/work-sessions.json'), {
    workSessions: [{ workId: 'imported-work', cwd: sourceProject, sessionId: sourceSessionId }],
    pinnedCount: 1
  })
  const jiti = createJiti(import.meta.url, {
    tsconfigPaths: join(projectRoot, 'tsconfig.json'),
    nativeModules: [
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai'
    ]
  })
  const { collectL4Environment } = await jiti.import(
    '../src/server/l4_foundation/environment/l4-environment-collect.ts'
  )
  const { writeEnvironmentArchive } = await jiti.import(
    '../src/server/l4_foundation/environment/l4-environment-archive.ts'
  )
  const collection = await collectL4Environment({
    agentDir: sourceAgent,
    cwd: sourceProject,
    includeSessions: true,
    includePluginData: false
  })
  await writeEnvironmentArchive({
    outputPath: archivePath,
    password,
    entries: collection.entries()
  })
}

async function capturePreview() {
  const executable =
    process.env.PI_DESK_E2E_BROWSER ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  assert.ok(existsSync(executable), '需要可用的隔离验收浏览器')
  const cdpPort = await reservePort()
  browser = spawnEdge(executable, cdpPort, join(testRoot, 'browser'))
  await waitForBrowserReady(browser, cdpPort)
  client = await createCdpPage(cdpPort)
  await setViewport(client, 1440, 960, false)
  await navigate(client, origin)
  await waitFor(
    client,
    `document.querySelector('[aria-label="设置"]') !== null`,
    '设置入口',
    () => output.slice(-12000),
    60000
  )
  await clickAriaLabel(client, '设置')
  await clickAriaLabel(client, '设置分类：环境备份与恢复')
  await waitFor(
    client,
    `document.querySelector('#environment-package')?.disabled === false`,
    '环境设置可操作',
    () => output.slice(-12000),
    60000
  )
  const dom = await client.send('DOM.getDocument')
  const node = await client.send('DOM.querySelector', {
    nodeId: dom.root.nodeId,
    selector: '#environment-package'
  })
  await client.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [archivePath] })
  await evaluate(client, `document.querySelector('#environment-import-password').focus()`)
  await client.send('Input.insertText', { text: password })
  await waitFor(
    client,
    `[...document.querySelectorAll('button')].some(e => e.textContent.trim() === '解密并预览' && !e.disabled)`,
    '备份文件与密码已进入表单状态',
    () => output.slice(-12000)
  )
  const clicked = await evaluate(
    client,
    `(() => { const button = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '解密并预览'); if (!button || button.disabled) return false; button.click(); return true })()`
  )
  assert.equal(clicked, true)
  await waitFor(
    client,
    `document.querySelector('#environment-title')?.closest('section')?.textContent.includes(${JSON.stringify(sourceSessionId)})`,
    '真实加密包预览',
    () => output.slice(-12000),
    60000
  )
  await evaluate(
    client,
    `document.documentElement.classList.remove('dark'); document.querySelector('#environment-import-title').scrollIntoView({block:'start'})`
  )
  await put(join(evidence, 'preview-light.png'), await screenshot(client))
  await evaluate(client, `document.documentElement.classList.add('dark')`)
  await put(join(evidence, 'preview-dark.png'), await screenshot(client))
  await setViewport(client, 390, 844, true)
  await evaluate(
    client,
    `document.documentElement.classList.remove('dark'); document.querySelector('#environment-import-title').scrollIntoView({block:'start'})`
  )
  await put(join(evidence, 'preview-mobile.png'), await screenshot(client))
  assert.equal(
    await evaluate(client, `document.documentElement.scrollWidth <= window.innerWidth + 1`),
    true,
    '移动界面不可横向溢出'
  )
  await setViewport(client, 1440, 960, false)
  assert.equal(
    await evaluate(
      client,
      `(() => { const button = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '仅会话'); if (!button || button.disabled) return false; button.click(); return true })()`
    ),
    true
  )
  await waitFor(
    client,
    `document.querySelector('[aria-label="选择全部配置"]')?.getAttribute('aria-checked') === 'false' && document.querySelector('#environment-target-0') !== null`,
    '仅选择会话并显示目录映射'
  )
  await evaluate(client, `document.querySelector('#environment-target-0').focus()`)
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65
  })
  await client.send('Input.insertText', { text: targetProject })
  await waitFor(
    client,
    `[...document.querySelectorAll('button')].some(e => e.textContent.trim() === '更新预览' && !e.disabled)`,
    '目录映射可以重新核对'
  )
  await evaluate(
    client,
    `[...document.querySelectorAll('button')].find(e => e.textContent.trim() === '更新预览').click()`
  )
  await waitFor(
    client,
    `[...document.querySelectorAll('button')].some(e => e.textContent.trim() === '核对并应用' && !e.disabled)`,
    '实际映射与冲突核对完成',
    () => output.slice(-12000),
    60000
  )
  await evaluate(
    client,
    `document.querySelector('[aria-label="本地目录映射"]').scrollIntoView({block:'center'})`
  )
  await put(join(evidence, 'mapping-light.png'), await screenshot(client))
  await evaluate(client, `document.documentElement.classList.add('dark')`)
  await put(join(evidence, 'mapping-dark.png'), await screenshot(client))
  await setViewport(client, 390, 844, true)
  await evaluate(
    client,
    `document.documentElement.classList.remove('dark'); document.querySelector('[aria-label="本地目录映射"]').scrollIntoView({block:'center'})`
  )
  await put(join(evidence, 'mapping-mobile.png'), await screenshot(client))
}

try {
  await setup()
  const port = await reservePort()
  origin = `http://127.0.0.1:${port}`
  server = spawnE2eServer({
    projectRoot,
    agentDir,
    port,
    managed: true,
    development: true,
    nextDirectory: join(projectRoot, 'temp/build/environment-e2e', taskId, '.next'),
    environment: {
      PI_DESK_SECRET_KEY_FILE: keyPath,
      PI_OFFLINE: '1',
      PI_DESK_DESKTOP_ENVIRONMENT_VERSION: '',
      PI_DESK_DESKTOP_EXECUTABLE: '',
      PI_DESK_DESKTOP_CONFIG: ''
    },
    onOutput(text) {
      output = (output + text).slice(-500000)
    }
  })
  await waitForHttp(`${origin}/api/health`, 120000, '受管开发服务', () => output)
  assert.equal((await post('/api/environment/get', {})).data.canRestart, true)
  const exported = (
    await post('/api/environment/export', {
      password,
      includeSessions: false,
      includePluginData: false
    })
  ).data
  await waitOperation(exported.id, 'ready')
  const downloaded = await fetch(`${origin}/api/environment/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
    body: JSON.stringify({ id: exported.id })
  })
  assert.equal(downloaded.ok, true)
  assert.match(downloaded.headers.get('content-type') ?? '', /octet-stream/)
  assert.ok((await downloaded.arrayBuffer()).byteLength > 100)
  await post('/api/environment/cancel', { id: exported.id })
  const firstId = await upload()
  const beforeConfig = await readFile(join(agentDir, 'config/e2e-setting.json'))
  const wrong = await post(
    '/api/environment/preview',
    { id: firstId, password: 'wrong-password' },
    true
  )
  assert.notEqual(wrong.envelope.code, 0)
  assert.deepEqual(await readFile(join(agentDir, 'config/e2e-setting.json')), beforeConfig)
  const preview = (await post('/api/environment/preview', { id: firstId, password })).data
  assert.equal(preview.items.filter((item) => item.category === 'session').length, 1)
  assert.equal(preview.items.find((item) => item.sessionId === sourceSessionId).files, 2)
  await capturePreview()
  const originalSession = await readFile(existingSessionFile)
  const originalPiSettings = await readFile(join(agentDir, 'settings.json'))
  const configItem = preview.items.find(
    (item) => item.category === 'config' && item.title.endsWith('e2e-setting.json')
  )
  assert.ok(configItem)
  await post('/api/environment/import', {
    id: firstId,
    selectedIds: [configItem.id],
    mappings: [],
    overwrite: true
  })
  await waitOperation(firstId, 'completed')
  assert.equal(
    JSON.parse(await readFile(join(agentDir, 'config/e2e-setting.json'), 'utf8')).value,
    'source-restored'
  )
  assert.deepEqual(await readFile(existingSessionFile), originalSession)
  assert.deepEqual(await readFile(join(agentDir, 'settings.json')), originalPiSettings)
  const secondId = await upload()
  const mapped = (
    await post('/api/environment/preview', {
      id: secondId,
      password,
      mappings: [{ from: sourceProject, to: targetProject }]
    })
  ).data
  const rootSession = mapped.items.find((item) => item.sessionId === sourceSessionId)
  assert.ok(rootSession)
  const retainedConfig = await readFile(join(agentDir, 'config/e2e-setting.json'))
  await post('/api/environment/import', {
    id: secondId,
    selectedIds: [rootSession.id],
    mappings: [{ from: sourceProject, to: targetProject }],
    overwrite: false
  })
  await waitOperation(secondId, 'completed')
  assert.deepEqual(await readFile(join(agentDir, 'config/e2e-setting.json')), retainedConfig)
  const found = new Map()
  for (const path of await sessionsBelow(join(agentDir, 'sessions'))) {
    const content = await readFile(path, 'utf8')
    const header = JSON.parse(content.split(/\r?\n/)[0])
    found.set(header.id, { path, header, content })
  }
  assert.equal(found.get(sourceSessionId)?.header.cwd, targetProject)
  assert.equal(found.get(childSessionId)?.header.cwd, targetProject)
  assert.equal(found.get(childSessionId)?.header.parentSession, found.get(sourceSessionId)?.path)
  assert.ok(
    found.get(sourceSessionId).content.includes(JSON.stringify(found.get(childSessionId).path))
  )
  assert.match(found.get(childSessionId).path.replaceAll('\\', '/'), /\/subagents\//)
  const binding = JSON.parse(await readFile(join(agentDir, 'pi-desk/work-sessions.json'), 'utf8'))
  assert.equal(binding.pinnedCount, 1)
  assert.deepEqual(
    binding.workSessions.map((item) => item.workId),
    ['existing-work', 'imported-work']
  )
  assert.equal(output.includes(password), false, '日志不得包含导出密码')
  await put(join(evidence, 'result.json'), {
    status: 'passed',
    exportId: exported.id,
    configImportId: firstId,
    sessionImportId: secondId,
    screenshots: [
      'preview-light.png',
      'preview-dark.png',
      'preview-mobile.png',
      'mapping-light.png',
      'mapping-dark.png',
      'mapping-mobile.png'
    ]
  })
  success = true
  console.info('真实受管导出、密码拒绝、配置/会话独立导入及路径映射通过；截图待主代理人眼验收。')
} catch (error) {
  if (client) {
    try {
      await put(
        join(evidence, 'ui-diagnostics.json'),
        await evaluate(
          client,
          `({ text: document.body.innerText.slice(0, 20000), inputs: [...document.querySelectorAll('input')].map(e => ({ id: e.id, disabled: e.disabled, length: e.value.length })) })`
        )
      )
      await put(join(evidence, 'failure.png'), await screenshot(client))
    } catch {
      // 浏览器断开时保留服务日志和最初错误。
    }
  }
  throw error
} finally {
  await put(join(evidence, 'server.log'), output)
  client?.close()
  if (browser) await stopBrowserTree(browser)
  if (server) await stopE2eServerTree(server)
  if (success) await rm(testRoot, { recursive: true, force: true })
  else console.error(`失败现场：${evidence}`)
}
