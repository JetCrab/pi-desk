import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

import { assertPortReleased, spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const testRoot = join(projectRoot, 'temp', 'pi', 'plugin-host-visual', String(process.pid))
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, '插件平台视觉项目')
const pluginPackageDir = join(testRoot, 'ui-fixture-package')
const deliverablesPackageDir = join(projectRoot, 'plugins', 'pi-desk-deliverables')
const brokenPluginPackageDir = join(testRoot, 'broken-fixture-package')
const installCandidatePackageDir = join(testRoot, 'install-candidate-package')
const failedInstallCandidatePackageDir = join(testRoot, 'failed-install-candidate-package')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const workId = 'plugin-host-visual-work-session'
const desktopSidebarOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '插件平台__应用入口.png'
)
const desktopDeliverablesOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '插件平台__交付物列表.png'
)
const desktopDeliverablesMenuOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '插件平台__交付物右键菜单.png'
)
const desktopSidebarPreviewOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '插件平台__SessionSidebar文件预览.png'
)
const desktopStandaloneDeliverableOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '插件平台__交付物独立HTML.png'
)
const mobileStandaloneDeliverableOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '插件平台__交付物独立HTML.png'
)
const desktopApplicationOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '插件平台__Application.png'
)
const desktopManagementOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '插件管理__加载失败隔离.png'
)
const desktopCapabilitiesOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '插件管理__能力详情.png'
)
const desktopPanelOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '插件平台__ComposerPanel.png'
)
const desktopSettingsOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_桌面',
  '插件平台__SettingsPage.png'
)
const mobileSidebarOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '快捷入口__六项均衡.png'
)
const mobileApplicationOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '插件平台__Application.png'
)
const mobileManagementOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '插件管理__加载失败隔离.png'
)
const mobileCapabilitiesOutput = join(
  projectRoot,
  'temp',
  '验收',
  '客户端_移动端',
  '插件管理__能力详情.png'
)
const password = 'Qq.445566'
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
  await mkdir(dirname(workSessionStorePath), { recursive: true })
  await mkdir(projectDir, { recursive: true })
  await writeFile(
    join(projectDir, 'artifact.html'),
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>交付物 HTML 预览</title>
    <style>
      body { margin: 0; padding: 32px; background: #f8fafc; color: #0f172a; font: 16px/1.5 system-ui, sans-serif; }
      main { max-width: 680px; padding: 28px; border-radius: 18px; background: #ffffff; box-shadow: 0 12px 32px rgb(15 23 42 / 12%); }
      h1 { margin: 0; color: #1d4ed8; font-size: 28px; }
      p { margin: 12px 0 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>交付物 HTML 预览</h1>
      <p id="status">正在初始化预览…</p>
    </main>
    <script>
      document.body.dataset.scriptRan = 'true'
      document.getElementById('status').textContent = '内联脚本已运行'
    </script>
  </body>
</html>
`,
    'utf8'
  )
  await writeFile(
    join(projectDir, 'artifact.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9YQAAAABJRU5ErkJggg==',
      'base64'
    )
  )
  await mkdir(join(pluginPackageDir, 'browser'), { recursive: true })
  await mkdir(join(pluginPackageDir, 'skills', 'fixture-audit'), { recursive: true })
  await mkdir(join(pluginPackageDir, 'prompts'), { recursive: true })
  await mkdir(brokenPluginPackageDir, { recursive: true })
  await mkdir(installCandidatePackageDir, { recursive: true })
  await mkdir(failedInstallCandidatePackageDir, { recursive: true })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      packages: [pluginPackageDir, deliverablesPackageDir, brokenPluginPackageDir]
    }),
    'utf8'
  )
  await writeFile(
    join(pluginPackageDir, 'package.json'),
    JSON.stringify({
      name: 'ui-fixture-package',
      version: '1.0.0',
      type: 'module',
      pi: {
        extensions: ['./extension.mjs'],
        skills: ['./skills'],
        prompts: ['./prompts']
      },
      piDesk: { entry: './entry.mjs' }
    }),
    'utf8'
  )
  await writeFile(
    join(pluginPackageDir, 'extension.mjs'),
    `import { Type } from 'typebox'

export default function fixtureAuditExtension(pi) {
  pi.registerCommand('fixture-audit', {
    description: '查看 Fixture 插件能力',
    async handler() {}
  })
  pi.on('before_agent_start', () => undefined)
  pi.on('context', () => undefined)
  pi.on('session_start', () => {
    pi.registerTool({
      name: 'fixture_audit',
      label: 'Fixture Audit',
      description: '检查 Fixture Package 的能力与上下文影响。',
      promptSnippet: 'Inspect Fixture plugin capabilities',
      promptGuidelines: [
        'Use fixture_audit only for the plugin capability visual fixture.',
        'Never use fixture_audit for unrelated production work.'
      ],
      parameters: Type.Object({
        focus: Type.Optional(Type.String({ description: 'Capability category to inspect' }))
      }),
      async execute() {
        return { content: [{ type: 'text', text: 'fixture audited' }], details: {} }
      }
    })
  })
}
`,
    'utf8'
  )
  await writeFile(
    join(pluginPackageDir, 'skills', 'fixture-audit', 'SKILL.md'),
    `---
name: fixture-audit
description: Fixture Skill 描述，用于验证插件能力清单。
---

# Fixture Audit
`,
    'utf8'
  )
  await writeFile(
    join(pluginPackageDir, 'prompts', 'fixture-review.md'),
    `---
description: Fixture Prompt 描述
---
请审查 Fixture 插件。
`,
    'utf8'
  )
  await writeFile(
    join(failedInstallCandidatePackageDir, 'package.json'),
    JSON.stringify({
      name: 'failed-install-candidate-package',
      version: '3.0.0',
      type: 'module',
      piDesk: { entry: './entry.mjs' }
    }),
    'utf8'
  )
  await writeFile(
    join(failedInstallCandidatePackageDir, 'entry.mjs'),
    `export default {
  name: 'failed-during-e2e',
  setup() {
    throw new Error('候选插件预检失败')
  }
}
`,
    'utf8'
  )
  await writeFile(
    join(installCandidatePackageDir, 'package.json'),
    JSON.stringify({
      name: 'install-candidate-package',
      version: '2.0.0',
      type: 'module',
      piDesk: { entry: './entry.mjs' }
    }),
    'utf8'
  )
  await writeFile(
    join(installCandidatePackageDir, 'entry.mjs'),
    `export default {
  name: 'installed-during-e2e',
  setup() {
    return { dispose() {} }
  }
}
`,
    'utf8'
  )
  await writeFile(
    join(brokenPluginPackageDir, 'package.json'),
    JSON.stringify({
      name: 'broken-fixture-package',
      version: '9.9.9',
      type: 'module',
      piDesk: { entry: './entry.mjs' }
    }),
    'utf8'
  )
  await writeFile(
    join(brokenPluginPackageDir, 'entry.mjs'),
    `export default {
  name: 'broken-fixture',
  setup() {
    throw new Error('Fixture 插件初始化失败')
  }
}
`,
    'utf8'
  )
  await writeFile(
    join(pluginPackageDir, 'entry.mjs'),
    `export default {
  name: 'ui-fixture',
  setup(plugin) {
    plugin.registerMethod('state-get', async () => ({ status: 'ready', activity: '等待发布' }))
    plugin.registerBrowserEntry('./browser/entry.js')
    plugin.declareMessage('fixture-status', {
      priority: 40,
      match() { return false },
      project() {
        return { viewKey: 'ui-fixture/status', summary: { text: 'Fixture' }, detail: null }
      }
    })
  }
}
`,
    'utf8'
  )
  await writeFile(
    join(pluginPackageDir, 'browser', 'entry.js'),
    `export default function browserEntry(plugin) {
  window.__uiFixtureFactoryCount = (window.__uiFixtureFactoryCount ?? 0) + 1
  const loadView = () => import('./view.js')
  const visible = ({ workSessions }) => workSessions.length > 0
  plugin.registerContribution('application', 'release-center', {
    label: 'Fixture 应用',
    title: 'Fixture 自定义应用',
    icon: { type: 'builtin', name: 'rocket' },
    chrome: 'none',
    resolve: visible,
    load: () => loadView().then((module) => module.releaseCenter)
  })
  for (let index = 1; index <= 4; index += 1) {
    plugin.registerContribution('application', 'zz-fixture-entry-' + String(index).padStart(2, '0'), {
      label: '入口 ' + index,
      title: 'Fixture 入口 ' + index,
      icon: { type: 'builtin', name: 'rocket' },
      chrome: 'host',
      resolve: visible,
      load: () => loadView().then((module) => module.overflowApplication(index))
    })
  }
  plugin.registerContribution('composer-panel', 'quick-panel', {
    label: 'Fixture Panel',
    icon: { type: 'builtin', name: 'panel' },
    load: () => loadView().then((module) => module.quickPanel)
  })
  plugin.registerContribution('settings-page', 'fixture-settings', {
    label: 'Fixture 设置',
    icon: { type: 'builtin', name: 'settings' },
    load: () => loadView().then((module) => module.fixtureSettings)
  })
  for (let index = 1; index <= 4; index += 1) {
    plugin.registerContribution('settings-page', 'fixture-extra-settings-' + index, {
      label: 'Fixture 附加设置 ' + index,
      icon: { type: 'builtin', name: 'settings' },
      load: () => loadView().then((module) => module.fixtureSettings)
    })
  }
  plugin.registerContribution('message-view', 'fixture-status', {
    viewKey: 'ui-fixture/status',
    priority: 40,
    load: () => loadView().then((module) => module.quickPanel)
  })
  plugin.registerContribution('session-sidebar-tab', 'fixture-deliverables', {
    label: 'Fixture Tab',
    icon: { type: 'builtin', name: 'file' },
    load: () => loadView().then((module) => module.sessionSidebarTab)
  })
}
`,
    'utf8'
  )
  await writeFile(
    join(pluginPackageDir, 'browser', 'view.js'),
    `function shell(title, subtitle) {
  const root = document.createElement('div')
  root.style.cssText = 'box-sizing:border-box;min-height:100%;padding:24px;color:inherit;font:14px/1.5 Inter,system-ui,sans-serif;background:linear-gradient(135deg,color-mix(in srgb,var(--primary) 8%,transparent),transparent 42%)'
  const heading = document.createElement('h2')
  heading.textContent = title
  heading.style.cssText = 'margin:0;font-size:22px;font-weight:700'
  const description = document.createElement('p')
  description.textContent = subtitle
  description.style.cssText = 'margin:6px 0 20px;color:var(--muted-foreground)'
  root.append(heading, description)
  return root
}

function card(label, value) {
  const element = document.createElement('div')
  element.style.cssText = 'min-width:0;overflow-wrap:anywhere;border:1px solid var(--border);border-radius:14px;padding:16px;background:color-mix(in srgb,var(--card) 92%,transparent);box-shadow:0 8px 24px rgba(0,0,0,.08)'
  element.innerHTML = '<div style="font-size:12px;color:var(--muted-foreground)">' + label + '</div><div style="margin-top:6px;font-size:16px;font-weight:600" data-value></div>'
  element.querySelector('[data-value]').textContent = value
  return element
}

export const releaseCenter = {
  mount({ container, target, host, signal }) {
      const root = shell('Fixture 发布中心', '无 Host Chrome · Browser Module 已按需加载')
      root.style.width = 'min(760px, calc(100dvw - 3rem))'
      root.style.height = 'min(520px, calc(100dvh - 3rem))'
      root.style.overflow = 'auto'
      root.style.border = '1px solid var(--border)'
      root.style.borderRadius = '18px'
      root.style.boxShadow = '0 24px 70px rgba(0,0,0,.35)'
      const close = document.createElement('button')
      close.type = 'button'
      close.setAttribute('aria-label', '关闭 Fixture 应用')
      close.textContent = '关闭'
      close.style.cssText = 'float:right;min-height:36px;padding:0 12px;border:1px solid var(--border);border-radius:9px;background:var(--background);color:inherit;cursor:pointer'
      close.addEventListener('click', target.close)
      root.prepend(close)
      const grid = document.createElement('div')
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px'
      const project = card('初始项目', target.initialContext?.cwd ?? '纯全局')
      const status = card('运行状态', '正在读取…')
      grid.append(project, status)
      const action = document.createElement('button')
      action.type = 'button'
      action.textContent = '刷新状态'
      action.style.cssText = 'margin-top:16px;min-height:40px;padding:0 16px;border:1px solid var(--border);border-radius:10px;background:var(--primary);color:var(--primary-foreground);font-weight:600;cursor:pointer'
      const refresh = async () => {
        const state = await host.piDesk.invokeGlobal('state-get', {})
        status.querySelector('[data-value]').textContent = state.activity + ' · ' + state.status
      }
      action.addEventListener('click', refresh)
      root.append(grid, action)
      container.append(root)
      void refresh()
      signal.addEventListener('abort', () => action.removeEventListener('click', refresh), { once: true })
      return () => {
        close.removeEventListener('click', target.close)
        root.remove()
      }
    }
}

export function overflowApplication(index) {
  return {
    mount({ container }) {
      const root = shell('Fixture 入口 ' + index, '快捷入口溢出菜单验收')
      root.style.width = 'min(420px, calc(100dvw - 3rem))'
      root.style.minHeight = '180px'
      root.style.border = '1px solid var(--border)'
      root.style.borderRadius = '18px'
      container.append(root)
      return () => root.remove()
    }
  }
}

export const quickPanel = {
  mount({ container, target }) {
      const root = shell('Fixture 快速面板', 'Composer Panel 精确绑定当前 Source')
      root.tabIndex = 0
      root.setAttribute('aria-label', 'Fixture 快速面板内容')
      root.append(card('workId', target.source.workId), card('branchId', target.source.branchId))
      container.append(root)
      return () => root.remove()
    }
}

export const fixtureSettings = {
  mount({ container, target }) {
      const root = shell('Fixture 设置', '未保存草稿会阻止正常离开')
      const input = document.createElement('input')
      input.setAttribute('data-fixture-settings-input', '')
      input.placeholder = '输入配置草稿'
      input.style.cssText = 'box-sizing:border-box;width:100%;height:42px;border:1px solid var(--border);border-radius:10px;padding:0 12px;background:var(--background);color:inherit'
      const save = document.createElement('button')
      save.type = 'button'
      save.textContent = '保存 Fixture 设置'
      save.style.cssText = 'margin-top:12px;min-height:40px;padding:0 16px;border:0;border-radius:10px;background:var(--primary);color:var(--primary-foreground);font-weight:600;cursor:pointer'
      let dirty = false
      const updateGuard = () => target.setBeforeLeave(() => !dirty)
      const handleInput = () => {
        dirty = true
        updateGuard()
      }
      const handleSave = () => {
        dirty = false
        updateGuard()
        save.textContent = '已保存'
      }
      input.addEventListener('input', handleInput)
      save.addEventListener('click', handleSave)
      updateGuard()
      root.append(input, save)
      container.append(root)
      return () => {
        target.setBeforeLeave(null)
        input.removeEventListener('input', handleInput)
        save.removeEventListener('click', handleSave)
        root.remove()
      }
    }
}

export const sessionSidebarTab = {
  mount({ container, target }) {
    window.__fixtureSidebarMounts = (window.__fixtureSidebarMounts ?? 0) + 1
    const root = shell('Fixture 交付物', 'Session Sidebar Tab 精确绑定当前 Source')
    root.append(card('workId', target.source.workId), card('branchId', target.source.branchId))
    const preview = document.createElement('button')
    preview.type = 'button'
    preview.textContent = '预览验收文件'
    preview.setAttribute('data-fixture-preview-mode', 'session')
    preview.style.cssText = 'margin-top:14px;min-height:40px;padding:0 14px;border:0;border-radius:10px;background:var(--primary);color:var(--primary-foreground);font-weight:600;cursor:pointer'
    const openPreview = () => target.files.preview('artifact.html')
    preview.addEventListener('click', openPreview)
    const expanded = document.createElement('button')
    expanded.type = 'button'
    expanded.textContent = '放大预览验收文件'
    expanded.setAttribute('data-fixture-preview-mode', 'expanded')
    expanded.style.cssText = preview.style.cssText
    const openExpandedPreview = () => target.files.preview('artifact.html', { mode: 'expanded' })
    expanded.addEventListener('click', openExpandedPreview)
    root.append(preview, expanded)
    container.append(root)
    return () => {
      window.__fixtureSidebarDisposes = (window.__fixtureSidebarDisposes ?? 0) + 1
      preview.removeEventListener('click', openPreview)
      expanded.removeEventListener('click', openExpandedPreview)
      root.remove()
    }
  }
}
`,
    'utf8'
  )

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  const timestamp = Date.now()
  const usage = {
    input: 120,
    output: 45,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 165,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '请保持这条聊天状态，打开并关闭插件应用。' }],
    timestamp
  })
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '聊天状态会在插件 Application 打开期间保持。' }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp + 1
  })
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'deliverable-visual-tool-call',
    toolName: 'deliverable',
    content: [{ type: 'text', text: '已登记交付物。' }],
    details: {
      items: [
        { path: 'artifact.png', title: '桌面端图片最终验收' },
        { path: 'artifact.html', title: '桌面端 HTML 最终验收' }
      ]
    },
    isError: false,
    timestamp: timestamp + 2
  })
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '聊天状态会在插件 Application 打开期间保持。' }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp + 3
  })
  manager.appendSessionInfo('插件平台视觉基线')
  sessionId = manager.getSessionId()
  await writeFile(
    workSessionStorePath,
    `${JSON.stringify(
      { workSessions: [{ workId, cwd: projectDir, sessionId }], pinnedCount: 0 },
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
      const target = [...document.querySelectorAll('button, summary, [role="button"], [role="menuitem"], [role="option"]')].reverse().find((element) => element.textContent?.trim().includes(${JSON.stringify(text)}));
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
      const target = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
      if (!target) return false;
      target.click();
      return true;
    })()`
  )
  assert.equal(clicked, true, `未找到操作：${label}`)
}

async function clickSelector(client, selector) {
  const clicked = await evaluate(
    client,
    `(() => {
      const target = document.querySelector(${JSON.stringify(selector)})
      if (!(target instanceof HTMLElement)) return false
      target.click()
      return true
    })()`
  )
  assert.equal(clicked, true, `未找到操作：${selector}`)
}

async function rightClickAriaLabel(client, label) {
  const target = await evaluate(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  )
  assert.ok(target, `未找到右键目标：${label}`)
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: target.x,
    y: target.y,
    button: 'right',
    clickCount: 1
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: target.x,
    y: target.y,
    button: 'right',
    clickCount: 1
  })
}

async function refreshFixtureWorkSessionSnapshot(client) {
  const created = await evaluate(
    client,
    `fetch('/api/work-sessions/add', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '70d47bb7-df7f-43ce-a65a-d99d5a387052' },
      body: JSON.stringify({ cwd: ${JSON.stringify(projectDir)} })
    }).then(async response => ({ ok: response.ok, body: await response.json() }))`
  )
  assert.equal(created.ok, true, created.body?.msg)
  await waitFor(
    client,
    `document.querySelectorAll('[data-testid^="work-session-delete-"]').length === 2`,
    '新增会话 Snapshot 已应用'
  )

  const deleted = await evaluate(
    client,
    `fetch('/api/work-sessions/del', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '70d47bb7-df7f-43ce-a65a-d99d5a387052' },
      body: JSON.stringify({ workId: ${JSON.stringify(created.body.data.workSession.workId)} })
    }).then(async response => ({ ok: response.ok, body: await response.json() }))`
  )
  assert.equal(deleted.ok, true, deleted.body?.msg)
  await waitFor(
    client,
    `document.querySelectorAll('[data-testid^="work-session-delete-"]').length === 1`,
    '删除会话 Update 已应用'
  )
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

async function assertFilePreviews(client) {
  const standaloneSelector = '[data-testid="plugin-standalone-file-preview"]'
  const sessionFileState = () =>
    evaluate(
      client,
      `(() => {
        const column = document.querySelector('[data-work-id="${workId}"]')
        return {
          workspaceCount: column?.querySelectorAll('[data-testid="file-workspace"]').length ?? 0,
          tabCount: column?.querySelectorAll('[data-file-tab]').length ?? 0,
          entryText: column?.querySelector('[data-testid="session-files-entry"]')?.textContent ?? null
        }
      })()`
    )
  const pressEscape = async () => {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    })
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    })
  }
  const assertStandaloneChrome = async () => {
    assert.deepEqual(
      await evaluate(
        client,
        `(() => {
          const root = document.querySelector(${JSON.stringify(standaloneSelector)})
          if (!(root instanceof HTMLElement)) return null
          return {
            hasFileTabs: root.querySelector('[data-testid="file-tabs"]') !== null,
            hasProjectDirectory: root.querySelector('[aria-label="预览项目目录"]') !== null,
            hasProjectFiles: root.querySelector('[data-testid^="project-file-"]') !== null,
            hasDisplayMode: root.querySelector('[aria-label="HTML 显示方式"]') !== null,
            hasSessionWorkspace: root.querySelector('[data-testid="file-workspace"]') !== null
          }
        })()`
      ),
      {
        hasFileTabs: false,
        hasProjectDirectory: false,
        hasProjectFiles: false,
        hasDisplayMode: false,
        hasSessionWorkspace: false
      },
      'standalone 不得带入会话文件Chrome'
    )
  }

  await clickAriaLabel(client, '显示交付物')
  await waitFor(
    client,
    `document.body.innerText.includes('桌面端 HTML 最终验收')`,
    '交付物列表恢复'
  )
  const beforeDesktopStandalone = await sessionFileState()
  await clickText(client, '桌面端 HTML 最终验收')
  const standaloneHtmlVisible = `document.querySelector(${JSON.stringify(`${standaloneSelector} iframe[title="artifact.html HTML 预览"]`)}) !== null`
  await waitFor(client, standaloneHtmlVisible, '交付物进入独立HTML预览')
  await assertStandaloneChrome()
  assert.deepEqual(
    await sessionFileState(),
    beforeDesktopStandalone,
    'standalone 不得改变来源会话文件状态'
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelector(${JSON.stringify(`${standaloneSelector} iframe[title="artifact.html HTML 预览"]`)}).sandbox.contains('allow-scripts')`
    ),
    true,
    'standalone HTML允许脚本运行'
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelector(${JSON.stringify(`${standaloneSelector} iframe[title="artifact.html HTML 预览"]`)}).sandbox.contains('allow-same-origin')`
    ),
    false,
    'standalone HTML不允许same-origin'
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelector(${JSON.stringify(`${standaloneSelector} iframe[title="artifact.html HTML 预览"]`)}).srcdoc.includes('内联脚本已运行')`
    ),
    true,
    'standalone HTML使用既有预览构建器'
  )
  const desktopStandaloneMetrics = await evaluate(
    client,
    `(() => {
      const dialog = document.querySelector('[data-slot="app-dialog-content"]')
      const root = document.querySelector(${JSON.stringify(standaloneSelector)})
      if (!(dialog instanceof HTMLElement) || !(root instanceof HTMLElement)) return null
      const dialogRect = dialog.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      return {
        dialogWidth: dialogRect.width,
        dialogHeight: dialogRect.height,
        rootWidth: rootRect.width,
        rootHeight: rootRect.height,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight
      }
    })()`
  )
  assert.ok(desktopStandaloneMetrics)
  assert.ok(desktopStandaloneMetrics.dialogWidth >= 1200, JSON.stringify(desktopStandaloneMetrics))
  assert.ok(desktopStandaloneMetrics.dialogHeight >= 800, JSON.stringify(desktopStandaloneMetrics))
  await waitFor(
    client,
    `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
    '桌面独立HTML布局稳定'
  )
  const desktopStandalone = await screenshot(client)
  assert.equal(
    await evaluate(
      client,
      `(() => {
        const frame = document.querySelector(${JSON.stringify(`${standaloneSelector} iframe[title="artifact.html HTML 预览"]`)})
        if (!(frame instanceof HTMLIFrameElement)) return false
        frame.focus()
        return document.activeElement === frame
      })()`
    ),
    true,
    '桌面独立HTML iframe获得Escape焦点'
  )
  await pressEscape()
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(standaloneSelector)}) === null`,
    '桌面独立HTML由iframe Escape关闭'
  )
  assert.deepEqual(
    await sessionFileState(),
    beforeDesktopStandalone,
    '关闭standalone后来源状态保持不变'
  )

  await clickAriaLabel(client, '打开图片：桌面端图片最终验收')
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(`${standaloneSelector} .viewer-canvas img`)})?.complete === true`,
    '桌面独立图片预览加载'
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelector(${JSON.stringify(`${standaloneSelector} .viewer-canvas img`)}).naturalWidth > 0`
    ),
    true,
    '独立图片查看器加载图片'
  )
  await assertStandaloneChrome()
  assert.deepEqual(
    await sessionFileState(),
    beforeDesktopStandalone,
    '独立图片不得改变来源会话文件状态'
  )
  await clickAriaLabel(client, '关闭弹窗')
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(standaloneSelector)}) === null`,
    '桌面独立图片关闭'
  )

  await clickAriaLabel(client, '显示Fixture Tab')
  await waitFor(client, `document.body.innerText.includes('Fixture 交付物')`, 'Sidebar插件挂载')
  await clickSelector(client, '[data-fixture-preview-mode="session"]')
  const sessionHtmlVisible = `document.querySelector('[data-file-work-id="${workId}"] iframe[title="artifact.html HTML 预览"]') !== null`
  await waitFor(client, sessionHtmlVisible, 'Sidebar默认session预览')
  assert.equal(
    await evaluate(
      client,
      `document.querySelector(${JSON.stringify(standaloneSelector)}) === null`
    ),
    true,
    'session模式不打开独立Dialog'
  )
  assert.equal(
    await evaluate(client, `document.querySelectorAll('[data-testid="file-workspace"]').length`),
    1
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelectorAll('[data-testid="file-tab-artifact.html"]').length`
    ),
    1
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelector('[data-work-id="${workId}"] [data-testid="session-files-entry"]').textContent.includes('1')`
    ),
    true,
    'session模式更新来源文件入口'
  )
  await clickSelector(client, '[data-fixture-preview-mode="expanded"]')
  await waitFor(
    client,
    `document.querySelector('[data-slot="app-dialog-content"] [data-file-work-id="${workId}"] iframe[title="artifact.html HTML 预览"]') !== null`,
    'Sidebar显式expanded预览'
  )
  assert.equal(
    await evaluate(client, `document.querySelectorAll('[data-slot="app-dialog-content"]').length`),
    1
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelector(${JSON.stringify(standaloneSelector)}) === null`
    ),
    true,
    'expanded复用来源会话文件Dialog'
  )
  await pressEscape()
  await waitFor(client, sessionHtmlVisible, 'expanded关闭后保留session文件')
  await clickAriaLabel(client, '收起文件')

  await setViewport(client, 390, 844, true)
  await clickAriaLabel(client, '显示工作会话菜单')
  await clickAriaLabel(client, '显示交付物')
  await waitFor(
    client,
    `document.body.innerText.includes('桌面端 HTML 最终验收')`,
    '手机交付物列表恢复'
  )
  const beforeMobileStandalone = await sessionFileState()
  await clickText(client, '桌面端 HTML 最终验收')
  await waitFor(client, standaloneHtmlVisible, '手机交付物进入独立HTML预览')
  await assertStandaloneChrome()
  assert.deepEqual(
    await sessionFileState(),
    beforeMobileStandalone,
    '手机standalone不得改变来源状态'
  )
  const mobileStandaloneMetrics = await evaluate(
    client,
    `(() => {
      const dialog = document.querySelector('[data-slot="app-dialog-content"]')
      const root = document.querySelector(${JSON.stringify(standaloneSelector)})
      if (!(dialog instanceof HTMLElement) || !(root instanceof HTMLElement)) return null
      const dialogRect = dialog.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      return {
        dialogWidth: dialogRect.width,
        dialogHeight: dialogRect.height,
        rootWidth: rootRect.width,
        rootHeight: rootRect.height
      }
    })()`
  )
  assert.ok(mobileStandaloneMetrics, '手机独立HTML尺寸读取失败')
  assert.ok(
    mobileStandaloneMetrics.dialogWidth >= 388 &&
      mobileStandaloneMetrics.dialogHeight >= 840 &&
      mobileStandaloneMetrics.rootWidth >= 388 &&
      mobileStandaloneMetrics.rootHeight >= 840,
    `手机独立HTML使用全屏Dialog：${JSON.stringify(mobileStandaloneMetrics)}`
  )
  await waitFor(
    client,
    `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
    '手机独立HTML布局稳定'
  )
  const mobileStandalone = await screenshot(client)
  await clickAriaLabel(client, '关闭弹窗')
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(standaloneSelector)}) === null`,
    '手机独立HTML关闭'
  )
  assert.deepEqual(
    await sessionFileState(),
    beforeMobileStandalone,
    '手机关闭standalone后来源状态保持不变'
  )
  await clickAriaLabel(client, '显示工作会话菜单')
  await waitFor(
    client,
    `document.body.innerText.includes('桌面端 HTML 最终验收')`,
    '来源失效测试前恢复移动交付物侧栏'
  )

  await clickText(client, '桌面端 HTML 最终验收')
  await waitFor(client, standaloneHtmlVisible, '来源失效前重新打开独立HTML')
  const replaceResult = await evaluate(
    client,
    `fetch('/api/work-sessions/replace', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': 'd2ae6534-5091-4fb9-9863-1e67952377e2' },
      body: JSON.stringify({ workId: ${JSON.stringify(workId)} })
    }).then(async response => ({ ok: response.ok, body: await response.json() }))`
  )
  assert.equal(replaceResult.ok, true, replaceResult.body?.msg)
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(standaloneSelector)}) === null`,
    'Source变化自动关闭standalone'
  )
  await waitFor(
    client,
    `!document.body.innerText.includes('桌面端 HTML 最终验收')`,
    'Source变化清理旧交付物视图'
  )
  assert.equal(
    await evaluate(
      client,
      `document.querySelector('iframe[title="artifact.html HTML 预览"]') === null`
    ),
    true,
    '来源失效后旧HTML不可继续显示'
  )
  await publishScreenshots([
    [desktopStandaloneDeliverableOutput, desktopStandalone],
    [mobileStandaloneDeliverableOutput, mobileStandalone]
  ])
  console.log(`desktopStandaloneDeliverable=${desktopStandaloneDeliverableOutput}`)
  console.log(`mobileStandaloneDeliverable=${mobileStandaloneDeliverableOutput}`)
  console.log('插件文件预览定向验收通过：standalone、session、expanded、图片、双端关闭和来源失效。')
}

async function main() {
  let client
  try {
    await createFixture()
    appPort = await reservePort()
    cdpPort = await reservePort()
    process.env.PI_DESK_MANAGED_RESTART = '1'
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
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '7829c657-8526-4c59-b027-10c2ca112a33' },
        body: JSON.stringify({ password: ${JSON.stringify(password)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(login.ok, true, login.body?.msg)

    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await setViewport(client, 1440, 900, false)
    await waitFor(client, `document.body.innerText.includes('Fixture 应用')`, '插件应用入口显示')
    await clickText(client, '插件平台视觉项目')
    await waitFor(client, `document.body.innerText.includes('聊天状态会在插件')`, '聊天显示')
    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach((element) => { element.style.display = 'none' })`
    )
    if (process.argv.includes('--files-only')) {
      await assertFilePreviews(client)
      return
    }
    const startupBrowserRequests = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/plugins/browser-resources/')).length`
    )
    const startupEntryRequests = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/plugins/browser-resources/') && entry.name.endsWith('/entry.js')).length`
    )
    const startupUiChunkRequests = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/plugins/browser-resources/') && entry.name.includes('/chunks/browser-')).length`
    )
    assert.equal(startupEntryRequests, 2)
    assert.equal(startupUiChunkRequests, 0)
    assert.ok(startupBrowserRequests >= startupEntryRequests)
    assert.equal(await evaluate(client, `window.__uiFixtureFactoryCount`), 1)
    const desktopShortcutLayout = await evaluate(
      client,
      `(() => {
        const footer = document.querySelector('[aria-label="快捷入口"]');
        const buttons = [...footer.querySelectorAll('button')];
        const rowItemCounts = new Map();
        for (const button of buttons) {
          const top = Math.round(button.getBoundingClientRect().top);
          rowItemCounts.set(top, (rowItemCounts.get(top) ?? 0) + 1);
        }
        return {
          labels: buttons.map((button) => button.textContent.trim()),
          rowItemCounts: [...rowItemCounts.values()],
          widths: buttons.map((button) => button.getBoundingClientRect().width),
          heights: buttons.map((button) => button.getBoundingClientRect().height)
        };
      })()`
    )
    assert.deepEqual(desktopShortcutLayout.labels, [
      '设置',
      'Fixture 应用',
      '入口 1',
      '入口 2',
      '入口 3',
      '入口 4'
    ])
    assert.deepEqual(desktopShortcutLayout.rowItemCounts, [3, 3])
    assert.ok(desktopShortcutLayout.widths.every((width) => Math.abs(width - 56) < 0.1))
    assert.ok(desktopShortcutLayout.heights.every((height) => Math.abs(height - 56) < 0.1))
    const desktopSidebar = await screenshot(client)

    await clickAriaLabel(client, '显示交付物')
    await waitFor(
      client,
      `document.body.innerText.includes('桌面端图片最终验收') && document.body.innerText.includes('artifact.png') && document.body.innerText.includes('桌面端 HTML 最终验收') && document.body.innerText.includes('artifact.html')`,
      '真实交付物历史恢复'
    )
    assert.equal(
      await evaluate(
        client,
        `(() => {
          const items = [...document.querySelectorAll('button[aria-label^="打开"]')]
          return (
            items.length === 2 &&
            items.some((item) => item.getAttribute('aria-label') === '打开图片：桌面端图片最终验收') &&
            items.some((item) => item.getAttribute('aria-label') === '打开HTML：桌面端 HTML 最终验收') &&
            items.every((item) =>
              item.querySelector('svg') !== null &&
              !item.textContent.includes('查看') &&
              item.getBoundingClientRect().height >= 44 &&
              item.getBoundingClientRect().height <= 48
            )
          )
        })()`
      ),
      true,
      '交付物列表应显示紧凑类型图标，并由整行直接打开'
    )
    const desktopDeliverables = await screenshot(client)
    await rightClickAriaLabel(client, '打开图片：桌面端图片最终验收')
    await waitFor(
      client,
      `(() => {
        const menu = document.querySelector('[role="menu"]');
        return menu?.textContent?.includes('打开所在文件夹') === true && !menu.hasAttribute('data-starting-style');
      })()`,
      '交付物右键菜单打开'
    )
    const deliverablesMenuState = await evaluate(
      client,
      `(() => {
        const items = [...document.querySelectorAll('[role="menuitem"]')];
        return {
          texts: items.map((item) => item.textContent?.trim()),
          heights: items.map((item) => item.getBoundingClientRect().height)
        };
      })()`
    )
    assert.deepEqual(deliverablesMenuState.texts, ['复制地址', '打开所在文件夹'])
    assert.ok(
      deliverablesMenuState.heights.every((height) => height >= 31.5),
      `交付物菜单高度不足：${JSON.stringify(deliverablesMenuState.heights)}`
    )
    const desktopDeliverablesMenu = await screenshot(client)
    await clickText(client, '复制地址')
    await waitFor(
      client,
      `document.body.innerText.includes('已复制文件地址') && document.body.innerText.includes(${JSON.stringify(join(projectDir, 'artifact.png'))})`,
      '复制交付物绝对地址反馈'
    )
    const afterDeliverablesRequests = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/plugins/browser-resources/')).length`
    )
    assert.ok(afterDeliverablesRequests > startupBrowserRequests)
    await clickText(client, '桌面端 HTML 最终验收')
    await waitFor(
      client,
      `document.querySelector('iframe[title="artifact.html HTML 预览"]') !== null`,
      '宿主 HTML 文件预览打开'
    )
    assert.equal(
      await evaluate(
        client,
        `document.querySelector('[data-testid="file-workspace"] [aria-label="HTML 显示方式"] [aria-pressed="true"]')?.textContent === '预览'`
      ),
      true,
      'HTML 文件默认展示预览，可切换源码'
    )
    assert.equal(
      await evaluate(
        client,
        `(() => {
          const preview = document.querySelector('iframe[title="artifact.html HTML 预览"]')
          return (
            preview instanceof HTMLIFrameElement &&
            document.querySelectorAll('[data-testid="file-workspace"]').length === 1 &&
            preview.sandbox.contains('allow-scripts') &&
            preview.srcdoc.includes('交付物 HTML 预览') &&
            preview.srcdoc.includes('内联脚本已运行')
          )
        })()`
      ),
      true,
      'HTML 文档和内联脚本应传入隔离预览'
    )
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      'HTML 预览弹窗动画完成'
    )
    const desktopSidebarPreview = await screenshot(client)
    await clickAriaLabel(client, '收起文件')
    await clickAriaLabel(client, '打开会话文件')
    await waitFor(
      client,
      `document.querySelector('iframe[title="artifact.html HTML 预览"]') !== null`,
      '插件文件从会话入口恢复'
    )
    await clickAriaLabel(client, '收起文件')

    await clickAriaLabel(client, '显示Fixture Tab')
    await waitFor(
      client,
      `document.body.innerText.includes('Fixture 交付物')`,
      'Session Sidebar mount'
    )
    assert.equal(await evaluate(client, `window.__fixtureSidebarMounts`), 1)
    await clickSelector(client, '[data-fixture-preview-mode="session"]')
    await waitFor(
      client,
      `document.querySelector('iframe[title="artifact.html HTML 预览"]') !== null`,
      'Session Sidebar 调用相同宿主文件预览'
    )
    assert.equal(
      await evaluate(
        client,
        `document.querySelectorAll('[data-testid="file-tab-artifact.html"]').length`
      ),
      1,
      '重复插件打开复用已有文件标签'
    )
    await clickAriaLabel(client, '收起文件')
    const browserRequestsAfterSidebar = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/plugins/browser-resources/')).length`
    )
    assert.ok(browserRequestsAfterSidebar > afterDeliverablesRequests)
    await clickAriaLabel(client, '显示工作会话')
    await waitFor(client, `window.__fixtureSidebarDisposes === 1`, 'Session Sidebar dispose')

    await waitFor(
      client,
      `document.querySelector('[aria-label="设置，有扩展异常"]') !== null`,
      '设置入口扩展异常红点'
    )
    await clickAriaLabel(client, '设置，有扩展异常')
    await clickAriaLabel(client, '设置分类：插件')
    await waitFor(
      client,
      `document.body.innerText.includes('Fixture 插件初始化失败')`,
      '设置内插件管理故障详情'
    )
    assert.equal(
      await evaluate(client, `document.body.innerText.includes('聊天状态会在插件')`),
      true
    )
    const desktopManagement = await screenshot(client)
    await waitFor(
      client,
      `['工具 1', '固定提示 4', '动态影响 2', '手动提示 1', 'Pi Desk 15', '交互 1'].every((label) => document.body.innerText.includes(label))`,
      '插件能力类别标签'
    )
    await clickAriaLabel(client, '查看插件详情：ui-fixture')
    await waitFor(
      client,
      `document.body.innerText.includes('工具能力') && document.body.innerText.includes('调用参数 · 1') && document.body.innerText.includes('Inspect Fixture plugin capabilities') && document.body.innerText.includes('Use fixture_audit only for the plugin capability visual fixture.') && document.body.innerText.includes('Never use fixture_audit for unrelated production work.')`,
      '插件完整提示词详情'
    )
    await waitFor(
      client,
      `document.body.innerText.includes('调用参数 · 1') && document.body.innerText.includes('动态上下文能力') && document.body.innerText.includes('before_agent_start')`,
      '插件工具与动态能力详情'
    )
    await waitFor(
      client,
      `document.body.innerText.includes('focus') && document.body.innerText.includes('Capability category to inspect')`,
      'Tool 参数 Schema 详情'
    )
    await clickText(client, '查看 Skill 正文')
    await clickText(client, '查看 Prompt 正文')
    await waitFor(
      client,
      `document.body.innerText.includes('# Fixture Audit') && document.body.innerText.includes('请审查 Fixture 插件。')`,
      'Skill 与 Prompt 完整正文'
    )
    const desktopCapabilities = await screenshot(client)
    await clickAriaLabel(client, '关闭弹窗')

    await clickText(client, 'Fixture 应用')
    await waitFor(
      client,
      `document.body.innerText.includes('Fixture 发布中心')`,
      'Application mount'
    )
    await waitFor(
      client,
      `document.body.innerText.includes('等待发布 · ready')`,
      'Application Interface 恢复'
    )
    assert.equal(await evaluate(client, `window.__uiFixtureFactoryCount`), 1)
    const firstViewRequests = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/plugins/browser-resources/')).length`
    )
    assert.equal(firstViewRequests, browserRequestsAfterSidebar)
    const desktopApplicationMetrics = await evaluate(
      client,
      `(() => {
        const dialog = document.querySelector('[data-slot="app-dialog-content"]');
        const root = document.querySelector('[data-pi-desk-contribution="release-center"] > :first-child');
        const dialogRect = dialog.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        return {
          dialogWidth: dialogRect.width,
          dialogHeight: dialogRect.height,
          rootWidth: rootRect.width,
          rootHeight: rootRect.height,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          backgroundChatMounted: document.body.innerText.includes('聊天状态会在插件')
        };
      })()`
    )
    assert.equal(desktopApplicationMetrics.backgroundChatMounted, true)
    assert.ok(desktopApplicationMetrics.rootWidth >= 700)
    assert.ok(desktopApplicationMetrics.rootWidth <= 770)
    const fixtureScale = desktopApplicationMetrics.rootWidth / 760
    assert.ok(
      Math.abs(desktopApplicationMetrics.rootHeight - 520 * fixtureScale) <= 6,
      JSON.stringify(desktopApplicationMetrics)
    )
    assert.ok(
      desktopApplicationMetrics.dialogWidth < desktopApplicationMetrics.viewportWidth * 0.85
    )
    assert.ok(
      desktopApplicationMetrics.dialogHeight < desktopApplicationMetrics.viewportHeight * 0.9
    )
    const desktopApplication = await screenshot(client)
    assert.equal(
      await evaluate(
        client,
        `(() => {
          const button = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === '刷新状态');
          if (!button) return false;
          button.focus();
          return document.activeElement === button;
        })()`
      ),
      true
    )
    await refreshFixtureWorkSessionSnapshot(client)
    assert.equal(
      await evaluate(client, `document.activeElement?.textContent?.trim() === '刷新状态'`),
      true,
      'WorkSession 数据更新不应重挂载 Application'
    )

    await clickAriaLabel(client, '关闭 Fixture 应用')
    await waitFor(
      client,
      `document.body.innerText.includes('聊天状态会在插件')`,
      '关闭 Application 返回聊天'
    )
    await clickAriaLabel(client, '更多操作')
    await waitFor(client, `document.body.innerText.includes('Fixture Panel')`, 'Composer 插件菜单')
    await clickText(client, 'Fixture Panel')
    await waitFor(
      client,
      `document.body.innerText.includes('Fixture 快速面板')`,
      'Composer Panel mount'
    )
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      'Composer Panel 动画完成'
    )
    const desktopPanel = await screenshot(client)
    assert.equal(
      await evaluate(
        client,
        `(() => {
          const panel = document.querySelector('[aria-label="Fixture 快速面板内容"]');
          if (!panel) return false;
          panel.focus();
          return document.activeElement === panel;
        })()`
      ),
      true
    )
    await refreshFixtureWorkSessionSnapshot(client)
    assert.equal(
      await evaluate(
        client,
        `document.activeElement?.getAttribute('aria-label') === 'Fixture 快速面板内容'`
      ),
      true,
      'WorkSession 数据更新不应重挂载 Composer Panel'
    )
    assert.equal(await evaluate(client, `window.__uiFixtureFactoryCount`), 1)
    await clickAriaLabel(client, '关闭弹窗')

    await clickText(client, '设置')
    await clickAriaLabel(client, '展开或收起插件设置')
    await waitFor(client, `document.body.innerText.includes('Fixture 设置')`, '插件设置导航')
    await clickText(client, 'Fixture 设置')
    await waitFor(
      client,
      `document.querySelector('[data-fixture-settings-input]') !== null`,
      'Settings Page mount'
    )
    const desktopSettings = await screenshot(client)
    await evaluate(
      client,
      `(() => {
        const input = document.querySelector('[data-fixture-settings-input]');
        input.value = '未保存配置';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`
    )
    await clickText(client, '关于')
    await waitFor(
      client,
      `document.querySelector('[data-fixture-settings-input]') !== null`,
      'beforeLeave 阻止切换'
    )
    await clickText(client, '保存 Fixture 设置')
    await clickText(client, '关于')
    await waitFor(client, `document.body.innerText.includes('当前版本')`, '保存后允许切换')
    await clickAriaLabel(client, '关闭弹窗')

    await clickAriaLabel(client, '更多操作')
    await clickText(client, 'Fixture Panel')
    await waitFor(
      client,
      `document.body.innerText.includes('Fixture 快速面板')`,
      '替换前 Panel 打开'
    )
    const replaceResult = await evaluate(
      client,
      `fetch('/api/work-sessions/replace', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': 'd2ae6534-5091-4fb9-9863-1e67952377e2' },
        body: JSON.stringify({ workId: ${JSON.stringify(workId)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(replaceResult.ok, true, replaceResult.body?.msg)
    await waitFor(
      client,
      `document.querySelector('[data-slot="app-dialog-content"]') === null`,
      'Source 变化自动关闭 Composer Panel'
    )

    await setViewport(client, 210, 700, true)
    await waitFor(
      client,
      `document.querySelector('[aria-label="显示工作会话菜单"]') !== null`,
      '极窄移动端工作会话布局'
    )
    await clickAriaLabel(client, '显示工作会话菜单')
    await waitFor(
      client,
      `document.querySelector('[aria-label="更多快捷入口"]') !== null`,
      '极窄移动端更多入口'
    )
    await clickAriaLabel(client, '更多快捷入口')
    await waitFor(client, `document.body.innerText.includes('入口 4')`, '更多入口菜单显示')
    await clickText(client, '入口 4')
    await waitFor(
      client,
      `document.body.innerText.includes('快捷入口溢出菜单验收')`,
      '更多入口可正常打开'
    )
    await clickAriaLabel(client, '关闭 Fixture 入口 4')
    await waitFor(
      client,
      `document.querySelector('[data-slot="app-dialog-content"]') === null`,
      '关闭更多入口 Application'
    )

    await setViewport(client, 390, 844, true)
    await waitFor(
      client,
      `document.querySelector('[aria-label="显示工作会话菜单"]') !== null`,
      '移动端工作会话布局'
    )
    await clickAriaLabel(client, '显示工作会话菜单')
    await waitFor(client, `document.body.innerText.includes('Fixture 应用')`, '移动端插件应用入口')
    await clickText(client, '新会话')
    await waitFor(
      client,
      `document.querySelector('[aria-label="显示工作会话菜单"]') !== null`,
      '移动端恢复当前会话'
    )
    await clickAriaLabel(client, '显示工作会话菜单')
    await waitFor(
      client,
      `document.querySelector('[aria-label="显示Fixture Tab"]:not(:disabled)') !== null`,
      '移动端插件 Tab 可用'
    )
    await clickAriaLabel(client, '显示Fixture Tab')
    await waitFor(client, `window.__fixtureSidebarMounts === 2`, '移动端 Sidebar mount')
    await clickAriaLabel(client, '关闭工作会话菜单')
    await waitFor(client, `window.__fixtureSidebarDisposes === 2`, '移动端 Drawer 关闭 dispose')
    await clickAriaLabel(client, '显示工作会话菜单')
    await waitFor(client, `window.__fixtureSidebarMounts === 3`, '移动端 Sidebar 重新 mount')
    await clickAriaLabel(client, '显示工作会话')
    await waitFor(client, `window.__fixtureSidebarDisposes === 3`, '移动端切换 Tab dispose')
    const mobileShortcutLayout = await evaluate(
      client,
      `(() => {
        const footer = document.querySelector('[aria-label="快捷入口"]');
        const buttons = [...footer.querySelectorAll('button')];
        const rowItemCounts = new Map();
        for (const button of buttons) {
          const top = Math.round(button.getBoundingClientRect().top);
          rowItemCounts.set(top, (rowItemCounts.get(top) ?? 0) + 1);
        }
        return {
          labels: buttons.map((button) => button.textContent.trim()),
          rowItemCounts: [...rowItemCounts.values()],
          widths: buttons.map((button) => button.getBoundingClientRect().width),
          heights: buttons.map((button) => button.getBoundingClientRect().height)
        };
      })()`
    )
    assert.deepEqual(mobileShortcutLayout.labels, [
      '设置',
      'Fixture 应用',
      '入口 1',
      '入口 2',
      '入口 3',
      '入口 4'
    ])
    assert.deepEqual(mobileShortcutLayout.rowItemCounts, [3, 3])
    assert.ok(mobileShortcutLayout.widths.every((width) => Math.abs(width - 56) < 0.1))
    assert.ok(mobileShortcutLayout.heights.every((height) => Math.abs(height - 56) < 0.1))
    const mobileSidebar = await screenshot(client)
    await clickAriaLabel(client, '设置，有扩展异常')
    await clickAriaLabel(client, '当前设置分类')
    await clickText(client, '插件')
    await waitFor(
      client,
      `document.body.innerText.includes('Fixture 插件初始化失败')`,
      '移动端设置内插件管理故障详情'
    )
    assert.equal(
      await evaluate(
        client,
        `(() => {
          const trigger = document.querySelector('[aria-label="当前设置分类"]');
          if (!trigger) return false;
          const rect = trigger.getBoundingClientRect();
          const desktopItem = document.querySelector('[aria-label="设置分类：外观"]');
          return rect.height >= 40 && rect.height <= 44 && (!desktopItem || desktopItem.getClientRects().length === 0);
        })()`
      ),
      true,
      '移动端设置导航应保持单行固定高度'
    )
    const mobileManagement = await screenshot(client)
    await clickAriaLabel(client, '查看插件详情：ui-fixture')
    await waitFor(
      client,
      `document.body.innerText.includes('工具能力') && document.body.innerText.includes('调用参数 · 1') && document.body.innerText.includes('focus') && document.body.innerText.includes('Inspect Fixture plugin capabilities') && document.body.innerText.includes('Never use fixture_audit for unrelated production work.')`,
      '移动端完整提示词详情'
    )
    const mobileCapabilities = await screenshot(client)

    if (process.env.PI_DESK_PLUGIN_SETTINGS_VISUAL_ONLY === '1') {
      await publishScreenshots([
        [desktopManagementOutput, desktopManagement],
        [desktopCapabilitiesOutput, desktopCapabilities],
        [mobileManagementOutput, mobileManagement],
        [mobileCapabilitiesOutput, mobileCapabilities]
      ])
      console.log(`desktopManagement=${desktopManagementOutput}`)
      console.log(`desktopCapabilities=${desktopCapabilitiesOutput}`)
      console.log(`mobileManagement=${mobileManagementOutput}`)
      console.log(`mobileCapabilities=${mobileCapabilitiesOutput}`)
      return
    }

    await clickAriaLabel(client, '关闭弹窗')
    await clickAriaLabel(client, '显示工作会话菜单')
    await clickText(client, 'Fixture 应用')
    await waitFor(
      client,
      `document.body.innerText.includes('Fixture 发布中心')`,
      '移动端 Application'
    )
    await waitFor(
      client,
      `[...document.getAnimations()].every((animation) => animation.playState !== 'running')`,
      '移动端 Application 动画完成'
    )
    const mobileApplicationMetrics = await evaluate(
      client,
      `(() => {
        const dialog = document.querySelector('[data-slot="app-dialog-content"]');
        const root = document.querySelector('[data-pi-desk-contribution="release-center"] > :first-child');
        const dialogRect = dialog.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        return {
          dialogWidth: dialogRect.width,
          dialogHeight: dialogRect.height,
          rootWidth: rootRect.width,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight
        };
      })()`
    )
    assert.ok(mobileApplicationMetrics.rootWidth <= mobileApplicationMetrics.viewportWidth - 16)
    assert.ok(mobileApplicationMetrics.dialogWidth < mobileApplicationMetrics.viewportWidth)
    assert.ok(mobileApplicationMetrics.dialogHeight < mobileApplicationMetrics.viewportHeight)
    const mobileApplication = await screenshot(client)
    assert.equal(await evaluate(client, `window.__uiFixtureFactoryCount`), 1)
    const finalBrowserRequests = await evaluate(
      client,
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/plugins/browser-resources/')).length`
    )
    assert.equal(finalBrowserRequests, browserRequestsAfterSidebar)

    const failedAddPluginResult = await evaluate(
      client,
      `fetch('/api/plugins/add', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '91df5cc7-e852-46fd-a299-30bb5ef2d4fd' },
        body: JSON.stringify({ source: ${JSON.stringify(failedInstallCandidatePackageDir)} })
      }).then(async response => ({ status: response.status, body: await response.json() }))`
    )
    assert.equal(failedAddPluginResult.status, 400)
    assert.match(failedAddPluginResult.body.msg, /候选插件预检失败/)
    const afterRejectedCandidate = await evaluate(
      client,
      `fetch('/api/plugins/list', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '91df5cc7-e852-46fd-a299-30bb5ef2d4fd' },
        body: '{}'
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(afterRejectedCandidate.ok, true, afterRejectedCandidate.body?.msg)
    assert.equal(
      afterRejectedCandidate.body.data.plugins.some(
        (plugin) => plugin.pluginName === 'failed-during-e2e'
      ),
      false
    )

    const settingsBeforeAdd = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    assert.equal(
      settingsBeforeAdd.packages.some((source) =>
        String(source).includes('install-candidate-package')
      ),
      false
    )

    const addPluginResult = await evaluate(
      client,
      `fetch('/api/plugins/add', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': 'dc17ac27-af00-47bd-a5de-eabf5c1d2a77' },
        body: JSON.stringify({ source: ${JSON.stringify(installCandidatePackageDir)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(addPluginResult.ok, true, addPluginResult.body?.msg)
    assert.equal(addPluginResult.body.data.restartRequired, true)
    const settingsAfterAdd = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    assert.equal(
      settingsAfterAdd.packages.some((source) =>
        String(source).includes('install-candidate-package')
      ),
      true,
      '在线安装成功后应立即写入隔离测试 Settings'
    )
    assert.equal(
      await evaluate(client, `fetch('/api/health').then(response => response.ok)`),
      true,
      'Package 下载期间服务保持可用'
    )

    const installingRuntime = serverRuntime
    const installReloadResult = await evaluate(
      client,
      `fetch('/api/plugins/reload', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': 'dc17ac27-af00-47bd-a5de-eabf5c1d2a77' },
        body: '{}'
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(installReloadResult.ok, true, installReloadResult.body?.msg)
    const [installExitCode, installExitSignal] = await Promise.race([
      installingRuntime.exit,
      delay(30_000).then(() => {
        throw new Error(`等待在线安装后的快速重启超时\n${serverOutput}`)
      })
    ])
    assert.equal(installExitCode, 75, serverOutput)
    assert.equal(installExitSignal, null)
    await waitForPortReleased(appPort)

    serverRuntime = spawnE2eServer({
      projectRoot,
      agentDir,
      port: appPort,
      development: true,
      onOutput: (output) => {
        serverOutput += output
      }
    })
    await waitForHttp(`http://127.0.0.1:${appPort}/api/health`, 60_000, '安装重启后 Pi Desk')
    await waitFor(
      client,
      `fetch('/api/plugins/list', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': 'dc17ac27-af00-47bd-a5de-eabf5c1d2a77' },
        body: '{}'
      }).then(async response => {
        if (!response.ok) return false;
        const body = await response.json();
        return body.data?.plugins?.some(plugin => plugin.pluginName === 'installed-during-e2e' && plugin.status === 'ready');
      }).catch(() => false)`,
      '安装重启后权威插件列表',
      60_000
    )

    const installedSource = settingsAfterAdd.packages.find((source) =>
      String(source).includes('install-candidate-package')
    )
    assert.equal(typeof installedSource, 'string')
    const deletePluginResult = await evaluate(
      client,
      `fetch('/api/plugins/del', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '57e6d5a7-77ab-4817-9fe2-dd98f44cfec8' },
        body: JSON.stringify({ source: ${JSON.stringify(installedSource)} })
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(deletePluginResult.ok, true, deletePluginResult.body?.msg)
    assert.equal(deletePluginResult.body.data.restartRequired, true)
    assert.equal(
      deletePluginResult.body.data.plugins.some(
        (plugin) => plugin.pluginName === 'installed-during-e2e'
      ),
      false,
      '在线删除成功后 Package 立即从 Settings 快照消失'
    )
    const settingsAfterDelete = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    assert.equal(
      settingsAfterDelete.packages.some((source) =>
        String(source).includes('install-candidate-package')
      ),
      false
    )

    const removingRuntime = serverRuntime
    const deleteReloadResult = await evaluate(
      client,
      `fetch('/api/plugins/reload', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '57e6d5a7-77ab-4817-9fe2-dd98f44cfec8' },
        body: '{}'
      }).then(async response => ({ ok: response.ok, body: await response.json() }))`
    )
    assert.equal(deleteReloadResult.ok, true, deleteReloadResult.body?.msg)
    const [deleteExitCode, deleteExitSignal] = await Promise.race([
      removingRuntime.exit,
      delay(30_000).then(() => {
        throw new Error(`等待在线删除后的快速重启超时\n${serverOutput}`)
      })
    ])
    assert.equal(deleteExitCode, 75, serverOutput)
    assert.equal(deleteExitSignal, null)
    await waitForPortReleased(appPort)

    serverRuntime = spawnE2eServer({
      projectRoot,
      agentDir,
      port: appPort,
      development: true,
      onOutput: (output) => {
        serverOutput += output
      }
    })
    await waitForHttp(`http://127.0.0.1:${appPort}/api/health`, 60_000, '删除重启后 Pi Desk')
    await waitFor(
      client,
      `fetch('/api/plugins/list', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '57e6d5a7-77ab-4817-9fe2-dd98f44cfec8' },
        body: '{}'
      }).then(async response => {
        if (!response.ok) return false;
        const body = await response.json();
        return !body.data?.plugins?.some(plugin => plugin.pluginName === 'installed-during-e2e');
      }).catch(() => false)`,
      '删除重启后权威插件列表',
      60_000
    )

    await publishScreenshots([
      [desktopSidebarOutput, desktopSidebar],
      [desktopDeliverablesOutput, desktopDeliverables],
      [desktopDeliverablesMenuOutput, desktopDeliverablesMenu],
      [desktopSidebarPreviewOutput, desktopSidebarPreview],
      [desktopApplicationOutput, desktopApplication],
      [desktopManagementOutput, desktopManagement],
      [desktopCapabilitiesOutput, desktopCapabilities],
      [desktopPanelOutput, desktopPanel],
      [desktopSettingsOutput, desktopSettings],
      [mobileSidebarOutput, mobileSidebar],
      [mobileApplicationOutput, mobileApplication],
      [mobileManagementOutput, mobileManagement],
      [mobileCapabilitiesOutput, mobileCapabilities]
    ])
    console.log(`desktopSidebar=${desktopSidebarOutput}`)
    console.log(`desktopDeliverables=${desktopDeliverablesOutput}`)
    console.log(`desktopDeliverablesMenu=${desktopDeliverablesMenuOutput}`)
    console.log(`desktopSidebarPreview=${desktopSidebarPreviewOutput}`)
    console.log(`desktopApplication=${desktopApplicationOutput}`)
    console.log(`desktopManagement=${desktopManagementOutput}`)
    console.log(`desktopCapabilities=${desktopCapabilitiesOutput}`)
    console.log(`desktopPanel=${desktopPanelOutput}`)
    console.log(`desktopSettings=${desktopSettingsOutput}`)
    console.log(`mobileSidebar=${mobileSidebarOutput}`)
    console.log(`mobileApplication=${mobileApplicationOutput}`)
    console.log(`mobileManagement=${mobileManagementOutput}`)
    console.log(`mobileCapabilities=${mobileCapabilitiesOutput}`)
  } finally {
    client?.close()
    await stopBrowser()
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
