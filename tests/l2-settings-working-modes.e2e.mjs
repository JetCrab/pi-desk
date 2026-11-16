import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
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
const runId = `working-modes-${Date.now()}`
const isolatedRoot = join(projectRoot, 'temp/pi/settings-working-modes', runId)
const agentDir = join(isolatedRoot, 'agent')
const cwd = join(isolatedRoot, 'project')
const output = join(projectRoot, 'temp/run/settings-working-modes', runId)
const buildRoot = join(projectRoot, 'temp/build/settings-working-modes', runId)
const pluginRoot = join(buildRoot, 'tibo-fixture')
const browserHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const requestClientId = randomUUID()
const workId = 'settings-working-mode'
const password = 'Qq.settings-445566'
let runtime, browser, page, provider, cdpPort, port, providerPort, source
let serverOutput = '',
  success = false
const browserErrors = [],
  requests = [],
  captures = []
const cleanupErrors = []

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
async function fixture() {
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
    HOME: join(agentDir, 'home'),
    USERPROFILE: join(agentDir, 'home'),
    PI_OFFLINE: '1',
    NEXT_TELEMETRY_DISABLED: '1'
  })
  await mkdir(join(agentDir, 'home'), { recursive: true })
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(join(cwd, '.git'), { recursive: true })
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  await put(
    join(agentDir, 'config/pi-desk.yaml'),
    stringify({
      'pi-desk': {
        auth: { passwordHash: `scrypt:${salt.toString('hex')}:${hash.toString('hex')}` }
      }
    })
  )
  await put(join(agentDir, 'pi-desk/auth-session-key'), randomBytes(32).toString('hex'))
  providerPort = await reservePort()
  provider = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    for (const [content, finish] of [
      ['验证请求已完成。', null],
      ['', 'stop']
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'settings-fixture', choices: [{ index: 0, delta: content ? { role: 'assistant', content } : {}, finish_reason: finish }] })}\n\n`
      )
    }
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolveListen, reject) => {
    provider.once('error', reject)
    provider.listen(providerPort, '127.0.0.1', resolveListen)
  })
  const require = createRequire(join(projectRoot, 'plugins/pi-desk-tibo-monitor/package.json'))
  const { build } = require('esbuild')
  await build({
    entryPoints: [join(projectRoot, 'plugins/pi-desk-tibo-monitor/src/l2-browser-entry.ts')],
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    define: { 'process.env.NODE_ENV': '"production"' },
    external: [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      '@jetcrab/pi-desk-sdk/react/base'
    ],
    outdir: join(pluginRoot, 'browser'),
    entryNames: 'entry',
    chunkNames: 'chunks/[name]-[hash]'
  })
  // 浏览器使用真实插件源码；Node 侧只替代外部动态与翻译响应。
  await put(
    join(pluginRoot, 'package.json'),
    JSON.stringify({
      name: '@settings-fixture/tibo-monitor',
      version: '1.0.0',
      type: 'module',
      piDesk: { entry: './entry.mjs' }
    })
  )
  await put(
    join(pluginRoot, 'entry.mjs'),
    `import { definePiDeskPlugin } from '@jetcrab/pi-desk-sdk/entry'

export default definePiDeskPlugin({
  name: 'tibo-monitor',
  setup(plugin) {
    let settings = { enabled: false, intervalSeconds: 60, retentionCount: 100, model: null }
    const record = {
      id: 'settings-fixture-post',
      title: '浏览器验收内容',
      text: 'This is a controlled settings fixture.',
      link: 'https://x.com/fixture/status/1',
      publishedAt: 1794787200000,
      analysis: {
        translation: '设置验收使用受控动态，未连接外部服务。',
        reset: { level: 'none', reason: '不包含重置信息' },
        times: []
      }
    }
    const snapshot = () => ({
      settings,
      status: { polling: false, translating: false, lastCheckedAt: null, lastSuccessAt: null, sourceUrl: null, error: null },
      records: settings.model ? [{
        id: record.id, title: record.title, link: record.link, publishedAt: record.publishedAt,
        preview: record.analysis.translation, quotePreview: null, resetLevel: 'none', translated: true
      }] : []
    })
    plugin.registerMethod('state-get', async () => snapshot())
    plugin.registerMethod('models-list', async () => ({
      models: [{ provider: 'settings-fixture', modelId: 'settings-fixture', name: 'Settings fixture' }]
    }))
    plugin.registerMethod('settings-save', async (value) => {
      settings = value
      return snapshot()
    })
    plugin.registerMethod('record-get', async () => ({ record }))
    plugin.registerMethod('record-translate', async () => ({ record }))
    plugin.registerBrowserEntry('./browser/entry.js')
  }
})`
  )
  await put(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      packages: [{ source: pluginRoot, extensions: [], skills: [], prompts: [], themes: [] }],
      defaultProjectTrust: 'always',
      enableInstallTelemetry: false
    })
  )
  await put(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'settings-fixture': {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          api: 'openai-completions',
          apiKey: 'offline-fixture-key',
          models: [
            {
              id: 'settings-fixture',
              name: 'Settings fixture',
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
  await put(
    join(cwd, '.pi/settings.json'),
    JSON.stringify({
      defaultProvider: 'settings-fixture',
      defaultModel: 'settings-fixture',
      defaultThinkingLevel: 'off'
    })
  )
  await put(
    join(agentDir, 'config/system-prompts/global-append.md'),
    '# 全局约定\n\n使用中文交流。\n'
  )
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const session = SessionManager.create(cwd)
  session.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '设置工作区验收' }],
    timestamp: Date.now()
  })
  session.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '已准备工作区。' }],
    api: 'openai-completions',
    provider: 'settings-fixture',
    model: 'settings-fixture',
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
  })
  source = { workId, sessionId: session.getSessionId(), branchId: 'v1:main' }
  await put(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({ workSessions: [{ workId, cwd, sessionId: source.sessionId }], pinnedCount: 0 })
  )
}
const js = (code) => evaluate(page, `(() => eval(${JSON.stringify(code)}))()`)
const visible = 'e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0'
async function wait(expression, label, timeout = 45000) {
  await waitFor(page, `Boolean(${expression})`, label, () => serverOutput.slice(-8000), timeout)
}
async function click(label, prefix = false) {
  await wait(
    `(() => { const list=[...document.querySelectorAll('button,[role="option"],[role="radio"],summary')];const e=list.reverse().find(e=>${visible} && !e.disabled && (e.getAttribute('aria-label')===${JSON.stringify(label)} || ${prefix ? `e.textContent.replace(/\\s+/g,' ').trim().startsWith(${JSON.stringify(label)})` : `e.textContent.replace(/\\s+/g,' ').trim()===${JSON.stringify(label)}`}));if(!e)return false;e.click();return true })()`,
    '可操作：' + label
  )
}
async function input(label, text) {
  const expression = `(() => {const direct=[...document.querySelectorAll('input,textarea')].find(e=>${visible} && e.getAttribute('aria-label')===${JSON.stringify(label)});if(direct)return direct;const l=[...document.querySelectorAll('label')].find(e=>${visible} && e.textContent.trim()===${JSON.stringify(label)});return l?(l.htmlFor?document.getElementById(l.htmlFor):l.querySelector('input,textarea')):null})()`
  await wait(`!!(${expression})`, '输入字段：' + label)
  await js(`const e=${expression};e.focus();e.select()`)
  await page.send('Input.insertText', { text })
}
async function capture(name) {
  await wait(
    `(() => { const notices=[...document.querySelectorAll('[data-pi-desk-toast]')].filter(e=>${visible});for(const notice of notices) notice.querySelector('button')?.click();return notices.length===0 })()`,
    '临时通知已关闭'
  )
  await wait(
    `([...document.querySelectorAll('[role="dialog"]')].filter(e=>${visible})).every(e=>Number(getComputedStyle(e).opacity)===1&&e.getAnimations().every(a=>a.playState!=='running'))`,
    '展示稳定'
  )
  const file = join(output, name + '.png')
  await put(file, await screenshot(page))
  captures.push(file)
}
async function api(path, body) {
  return js(
    `fetch(${JSON.stringify(path)},{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':${JSON.stringify(requestClientId)}},body:JSON.stringify(${JSON.stringify(body)})}).then(async response=>({status:response.status,body:await response.json()}))`
  )
}
async function scenario() {
  await click('设置')
  await click('设置分类：模式')
  await wait(
    `document.querySelector('textarea[aria-label="全局提示词"]')?.value.includes('使用中文')`,
    '全局正文加载'
  )
  assert.equal(await js('window.__settingsCatalogRequests'), 0, '全局页面不得隐式读取候选目录')
  await capture('global-prompt-dark')
  await js('window.__settingsFailCatalog = true')
  await click('刷新能力选项')
  await wait(
    `document.querySelector('[aria-label="模式"] [role=alert]')?.textContent.includes('候选目录暂不可用')`,
    '候选依赖故障'
  )
  assert.equal(
    await js('document.querySelector(\'textarea[aria-label="全局提示词"]\').disabled'),
    false
  )
  await capture('global-catalog-failure-dark')
  await input('全局提示词', '# 全局约定\n\nGLOBAL_SETTINGS_E2E\n')
  await click('保存全局提示词')
  await wait(
    `document.querySelector('[aria-label="模式"]').textContent.includes('已保存')`,
    '全局保存反馈'
  )
  assert.equal(
    await readFile(join(agentDir, 'config/system-prompts/global-append.md'), 'utf8'),
    '# 全局约定\n\nGLOBAL_SETTINGS_E2E\n'
  )
  await js('window.__settingsFailCatalog = false')
  const initialModes = (await api('/api/capability-modes/get', {})).body.data.modes
  assert.equal(Object.keys(initialModes).length, 0)
  await click('新增模式')
  await input('模式名称', '代码审阅')
  await click('自定义')
  await wait(
    `document.querySelector('textarea[aria-label="模式追加提示词"]') !== null`,
    '专属正文编辑器'
  )
  await input('模式追加提示词', '# 审阅要求\n\nCUSTOM_SETTINGS_E2E\n')
  await click('保存模式')
  await wait(
    `document.querySelector('[aria-label="模式"]').textContent.includes('已保存')`,
    '模式保存反馈'
  )
  const modeData = (await api('/api/capability-modes/get', {})).body.data
  const modeKey = Object.keys(modeData.modes).find((key) => modeData.modes[key].name === '代码审阅')
  assert.ok(modeKey)
  assert.equal(modeData.modes[modeKey].promptSource, 'custom')
  const yaml = await readFile(join(agentDir, 'config/pi-desk.yaml'), 'utf8')
  assert.ok(!yaml.includes('CUSTOM_SETTINGS_E2E'))
  assert.equal(parse(yaml)['pi-desk']['capability-modes'].modes[modeKey].promptSource, 'custom')
  assert.equal(
    await readFile(
      join(
        agentDir,
        'config/system-prompts/modes',
        createHash('sha256').update(modeKey).digest('hex') + '.md'
      ),
      'utf8'
    ),
    '# 审阅要求\n\nCUSTOM_SETTINGS_E2E\n'
  )
  await capture('mode-custom-dark')
  await click('不追加')
  await click('自定义')
  assert.equal(
    await js('document.querySelector(\'textarea[aria-label="模式追加提示词"]\').value'),
    '# 审阅要求\n\nCUSTOM_SETTINGS_E2E\n'
  )
  await click('Pi 原有提示词', true)
  await wait(
    `document.querySelector('[aria-label="模式"] details[open] pre') || document.querySelector('[aria-label="模式"] details[open] [role=alert]')`,
    '原有提示词查询'
  )
  assert.equal(requests.length, 0, '只读预览不得发送模型请求')
  await click('全文预览')
  await wait(
    `[...document.querySelectorAll('[role="dialog"] pre')].some(e=>${visible} && e.textContent.includes('CUSTOM_SETTINGS_E2E'))`,
    '真实基线与草稿全文预览'
  )
  const previewText = await js(
    "[...document.querySelectorAll('[role=dialog] pre')].at(-1).textContent"
  )
  assert.ok(!previewText.includes('GLOBAL_SETTINGS_E2E'))
  await capture('prompt-preview-dark')
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await wait(
    `![...document.querySelectorAll('[role=heading],h2')].some(e=>${visible} && e.textContent==='全文预览')`,
    '预览关闭'
  )
  const unavailable = await api('/api/chat/context/get', {
    source: { ...source, branchId: 'v1:invalid' },
    previewAppendSystemPrompt: ''
  })
  assert.equal(unavailable.status, 409)
  const setGlobal = await api('/api/capability-mode-defaults/replace', {
    cwd: null,
    defaultMode: modeKey
  })
  assert.equal(setGlobal.status, 200)
  assert.deepEqual((await api('/api/capability-mode-defaults/get', { cwd: null })).body.data, {
    defaultMode: modeKey
  })
  assert.equal(
    (await api('/api/capability-mode-defaults/replace', { cwd, defaultMode: null })).status,
    200
  )
  assert.deepEqual((await api('/api/capability-mode-defaults/get', { cwd })).body.data, {
    defaultMode: null
  })
  assert.equal((await api('/api/capability-mode-defaults/replace', { cwd })).status, 200)
  assert.deepEqual((await api('/api/capability-mode-defaults/get', { cwd })).body.data, {})
  await click('设置分类：项目默认')
  await wait(`document.body.textContent.includes('Pi 全局参照')`, '独立项目默认')
  await wait(
    `document.querySelector('[aria-label="项目列表"]')?.textContent.includes(${JSON.stringify(cwd)})`,
    '项目列表读取完成'
  )
  await click('project', true)
  await wait(
    `!!document.querySelector('button[aria-label="模式"]:not([disabled])')`,
    '项目模式选择就绪'
  )
  await click('模式')
  await click('代码审阅')
  await click('保存默认配置')
  await wait(
    `[...document.querySelectorAll('[aria-label="项目默认"] footer [role=status]')].some(e=>e.textContent.includes('已保存：'))`,
    '项目保存结束'
  )
  assert.deepEqual((await api('/api/capability-mode-defaults/get', { cwd })).body.data, {
    defaultMode: modeKey
  })
  await capture('project-defaults-dark')
  await click('设置分类：模型')
  await wait(`document.body.textContent.includes('Settings fixture')`, '原模型目录')
  await capture('models-original-dark')
  await click('常用组合')
  await capture('presets-original-dark')
  await js('window.__settingsMockPluginRows = true')
  await click('设置分类：插件')
  await wait(
    `document.body.innerText.includes('下载源') && document.body.innerText.includes('从来源安装') && !document.body.innerText.includes('正在读取插件')`,
    '插件维护列表'
  )
  await wait(
    `document.querySelectorAll('article[aria-label$="-layout-fixture"]').length === 3`,
    '受控插件列表状态'
  )
  const columns = await js(`(() => {
    const update = document.querySelector('article[aria-label="update-layout-fixture"] [aria-label="版本"]')
    const current = document.querySelector('article[aria-label="current-layout-fixture"] [aria-label="版本"]')
    const unknown = document.querySelector('article[aria-label="native-layout-fixture"] [aria-label="版本"]')
    const numbers = [...update.querySelectorAll('span')].filter(e=>e.textContent.startsWith('v'))
    return {
      current: numbers[0].getBoundingClientRect().left,
      target: numbers[1].getBoundingClientRect().left,
      other: [...current.querySelectorAll('span')].find(e=>e.textContent.startsWith('v')).getBoundingClientRect().left,
      unknown: unknown.textContent.trim()
    }
  })()`)
  assert.ok(Math.abs(columns.current - columns.target) < 1)
  assert.ok(Math.abs(columns.current - columns.other) < 1)
  assert.equal(columns.unknown, '')
  await capture('plugins-layout-fixture-dark')
  await js('window.__settingsMockPluginRows = false')
  await click('Tibo 动态')
  await wait(
    `document.querySelector('[aria-label="检查间隔（秒）"]') !== null || [...document.querySelectorAll('label')].some(e=>e.textContent==='检查间隔（秒）')`,
    '真实Tibo首次配置'
  )
  assert.ok(await js("document.body.textContent.includes('开始监听')"))
  assert.equal(
    await js("[...document.querySelectorAll('summary')].some(e=>e.textContent==='更多设置')"),
    false
  )
  await capture('tibo-setup-dark')
  await input('检查间隔（秒）', '90')
  await input('保留动态（条）', '20')
  // Base UI 模型选择器保持真实页面行为。
  await click('选择翻译模型', true)
  await click('settings-fixture / Settings fixture', true)
  await click('开始监听')
  await wait(`document.body.textContent.includes('设置验收使用受控动态')`, '真实页面展示受控动态')
  await capture('tibo-reading-dark')
  assert.equal(requests.length, 0)
  await click('设置', false)
  await wait(`document.body.textContent.includes('保留动态（条）')`, 'Tibo独立设置')
  await capture('tibo-settings-dark')
  await click('取消')
  await click('设置分类：系统与数据')
  await capture('system-dark')
  await click('设置分类：通用偏好')
  await click('浅色')
  await wait(`!document.documentElement.classList.contains('dark')`, '切换浅色主题')
  await click('Tibo 动态')
  await capture('tibo-reading-light')
  await click('设置分类：项目默认')
  await wait(
    `document.querySelector('[aria-label="项目列表"]')?.textContent.includes(${JSON.stringify(cwd)})`,
    '浅色项目列表'
  )
  await click('project', true)
  await wait(
    `!!document.querySelector('button[aria-label="模式"]:not([disabled])')`,
    '浅色项目详情'
  )
  await capture('project-defaults-light')
  await click('设置分类：模式')
  await wait(`!!document.querySelector('textarea[aria-label="全局提示词"]')`, '浅色模式编辑')
  await capture('global-prompt-light')
  await setViewport(page, 1280, 850, false)
  await js("document.documentElement.style.fontSize = '20px'")
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true)
  assert.equal(
    await js(
      'document.querySelector(\'[aria-label="模式"] footer\').getBoundingClientRect().bottom <= innerHeight'
    ),
    true
  )
  await capture('global-prompt-large-text')
  await js("document.documentElement.style.removeProperty('font-size')")
  await setViewport(page, 390, 844, true)
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true)
  await capture('modes-mobile-list')
  await click('全局提示词', true)
  await wait(
    `document.querySelector('textarea[aria-label="全局提示词"]')?.getBoundingClientRect().width > 0`,
    '手机模式详情'
  )
  await capture('modes-mobile-editor')
  await setViewport(page, 1440, 900, false)
  await click('关闭弹窗')
  await wait(
    `!!document.querySelector('[data-work-id="${workId}"] [aria-label="能力模式：全开"]')`,
    '既有会话不被默认设置切换'
  )
  assert.equal((await api('/api/capability-mode-defaults/replace', { cwd })).status, 200)
  const inherited = await api('/api/work-sessions/add', { cwd })
  assert.equal(inherited.status, 201)
  const inheritedId = inherited.body.data.workSession.workId
  await wait(
    `!!document.querySelector('[data-testid="work-session-row-${inheritedId}"]')`,
    '新增继承会话'
  )
  await js(`document.querySelector('[data-testid="work-session-row-${inheritedId}"]').click()`)
  await wait(
    `!!document.querySelector('[data-work-id="${inheritedId}"] [aria-label="能力模式：代码审阅"]')`,
    '新会话采用全局默认'
  )
  await wait(
    `!!document.querySelector('[data-work-id="${inheritedId}"] textarea:not([disabled])')`,
    '新会话输入就绪'
  )
  await js(`document.querySelector('[data-work-id="${inheritedId}"] textarea').focus()`)
  await page.send('Input.insertText', { text: '确认当前模式可以运行。' })
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  await wait(
    `document.querySelector('[data-work-id="${inheritedId}"]').textContent.includes('验证请求已完成')`,
    '真实 Provider 响应'
  )
  assert.equal(requests.length, 1)
  const requestText = JSON.stringify(requests[0].messages)
  assert.ok(requestText.includes('CUSTOM_SETTINGS_E2E'), '实际请求使用模式专属正文')
  assert.ok(!requestText.includes('GLOBAL_SETTINGS_E2E'), '专属正文不得再叠全局')
  assert.equal(
    (await api('/api/capability-mode-defaults/replace', { cwd, defaultMode: null })).status,
    200
  )
  assert.ok(
    await js(
      `!!document.querySelector('[data-work-id="${inheritedId}"] [aria-label="能力模式：代码审阅"]')`
    )
  )
  const explicitAll = await api('/api/work-sessions/add', { cwd })
  assert.equal(explicitAll.status, 201)
  const allId = explicitAll.body.data.workSession.workId
  await wait(
    `!!document.querySelector('[data-testid="work-session-row-${allId}"]')`,
    '新增明确全开会话'
  )
  await js(`document.querySelector('[data-testid="work-session-row-${allId}"]').click()`)
  await wait(
    `!!document.querySelector('[data-work-id="${allId}"] [aria-label="能力模式：全开"]')`,
    '项目明确全开覆盖全局'
  )
  assert.deepEqual(browserErrors, [])
  console.log(
    '通过：真实设置装配、独立Markdown保存、Source预览、默认层继承、冻结模型入口、真实Tibo浏览器包与受控动态'
  )
}
try {
  await mkdir(output, { recursive: true })
  await fixture()
  port = await reservePort()
  cdpPort = await reservePort()
  runtime = spawnE2eServer({
    projectRoot,
    agentDir,
    port,
    development: true,
    nextDirectory: join(buildRoot, 'next'),
    onOutput: (text) => {
      serverOutput = (serverOutput + text).slice(-300000)
    }
  })
  await waitForHttp(`http://127.0.0.1:${port}/api/health`, 120000, '隔离Pi Desk', () =>
    serverOutput.slice(-8000)
  )
  // Pi 服务已取得隔离环境；Chromium 的 Windows 目录解析需要真实系统环境。
  for (const [key, value] of Object.entries(browserHome)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  browser = spawnEdge(
    process.env.PI_DESK_E2E_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    cdpPort,
    join(isolatedRoot, 'browser')
  )
  await waitForBrowserReady(browser, cdpPort)
  page = await createCdpPage(cdpPort)
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__settingsCatalogRequests = 0
      window.__settingsFailCatalog = false
      window.__settingsMockPluginRows = false
      const originalFetch = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url
        if (url.endsWith('/api/capability-modes/get')) {
          window.__settingsCatalogRequests += 1
          if (window.__settingsFailCatalog) {
            return Promise.resolve(new Response(JSON.stringify({ code: 500, msg: '候选目录暂不可用（受控测试）', data: null }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
          }
        }
        if (window.__settingsMockPluginRows && url.endsWith('/api/plugins/list')) {
          return originalFetch(input, init).then(async response => {
            const envelope = await response.clone().json()
            const base = envelope.data?.plugins?.[0]
            if (!base) return response
            envelope.data.plugins = [
              { ...base, source: 'npm:update-layout-fixture@1.0.0', pluginName: 'update-layout-fixture', version: '1.0.0', availableVersion: '1.1.0', updateAvailable: true, updateTag: 'latest' },
              { ...base, source: 'npm:current-layout-fixture@2.0.0', pluginName: 'current-layout-fixture', version: '2.0.0', availableVersion: null, updateAvailable: false, updateTag: 'latest' },
              { ...base, source: '/fixture/native-layout-fixture.ts', pluginName: 'native-layout-fixture', kind: 'extension', version: null, availableVersion: null, updateAvailable: false, updateTag: null }
            ]
            return new Response(JSON.stringify(envelope), { status: response.status, headers: { 'Content-Type': 'application/json' } })
          })
        }
        return originalFetch(input, init)
      }
    `
  })
  page.events.set(
    'Runtime.exceptionThrown',
    new Set([
      (event) =>
        browserErrors.push(
          event.exceptionDetails?.exception?.description || event.exceptionDetails?.text
        )
    ])
  )
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  await setViewport(page, 1440, 900, false)
  await navigate(page, `http://127.0.0.1:${port}/login`)
  assert.equal((await api('/api/system-prompt/get', {})).status, 401)
  assert.equal((await api('/api/auth/login', { password })).status, 200)
  await navigate(page, `http://127.0.0.1:${port}/`)
  await wait(
    `!!document.querySelector('[data-testid="work-session-row-${workId}"]')`,
    '会话列表加载',
    120000
  )
  await js(`document.querySelector('[data-testid="work-session-row-${workId}"]').click()`)
  await wait(
    `document.querySelector('[data-work-id="${workId}"] textarea') !== null`,
    '工作台就绪',
    120000
  )
  for (const [path, body] of [
    ['/api/system-prompt/get', { modeKey: 'missing-mode' }],
    ['/api/capability-mode-defaults/replace', { cwd: null, defaultMode: 'missing-mode' }],
    ['/api/capability-mode-defaults/get', { cwd: 'not-an-absolute-project' }],
    ['/api/capability-modes/replace', { modes: {}, promptContents: { 'missing-mode': 'no' } }],
    ['/api/system-prompt/replace', { content: 123 }]
  ]) {
    const rejected = await api(path, body)
    await put(
      join(output, 'last-rejection.json'),
      JSON.stringify({ path, body, rejected }, null, 2)
    )
    assert.equal(rejected.status, 400, `${path} 必须拒绝非法输入：${JSON.stringify(rejected.body)}`)
  }
  console.log('通过：新增接口真实 HTTP 非法输入均返回 400')
  if (!process.argv.includes('--contracts-only')) await scenario()
  success = true
} catch (error) {
  if (page) {
    await put(join(output, 'failure.png'), await screenshot(page)).catch(() => {})
    await put(join(output, 'failure-state.txt'), await js('document.body.innerText')).catch(
      () => {}
    )
  }
  await put(join(output, 'failure.txt'), error.stack || String(error))
  throw error
} finally {
  page?.close()
  const clean = async (action) => {
    try {
      await action()
    } catch (error) {
      cleanupErrors.push(String(error))
    }
  }
  if (browser) await clean(() => stopBrowserTree(browser, cdpPort))
  if (runtime) await clean(() => stopE2eServerTree(runtime))
  if (provider)
    await clean(async () => {
      provider.closeAllConnections()
      await new Promise((resolveClose, reject) =>
        provider.close((error) => (error ? reject(error) : resolveClose()))
      )
      await assertPortReleased(providerPort)
    })
  await put(join(output, 'server.log'), serverOutput)
  await put(
    join(output, 'result.json'),
    JSON.stringify(
      { success, browserErrors, providerRequests: requests.length, captures, cleanupErrors },
      null,
      2
    )
  )
  if (success && cleanupErrors.length === 0) {
    await rm(isolatedRoot, { recursive: true, force: true })
    await rm(buildRoot, { recursive: true, force: true })
  }
  console.log('验收目录：' + output)
  assert.deepEqual(cleanupErrors, [], '验证进程或端口清理失败')
}
