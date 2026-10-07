import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  clickText,
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
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const taskId = `subagent-message-layout-${process.pid}`
const testRoot = join(projectRoot, 'temp', 'pi', 'subagent-message-visual', taskId)
const runRoot = join(projectRoot, 'temp', 'run', 'subagent-message-visual', taskId)
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, '子代理消息视觉项目')
const packageDir =
  process.env.PI_SUBAGENT_VISUAL_PACKAGE_DIR ?? join(projectRoot, 'plugins', 'pi-desk-subagent')
const workId = 'subagent-message-visual-work-session'
const password = 'Qq.445566'
const agentId = '11111111-1111-4111-8111-111111111111'
const title = '接通可恢复账户驱动组合'
const markdown =
  '已完成恢复接口与驱动组合，本次检查保持既有运行行为。\n\n### 实际接口\n\n- `ExecutionDriver::checkpoint(&self) -> Result<Vec<u8>>`\n- `ExecutionDriver::restore(&self, bytes: &[u8]) -> Result<Box<dyn ExecutionDriver + Send>>`\n- 默认实现明确拒绝，旧自定义 Driver 不必增加实现。\n\n连续正文用于核对聊天与子代理详情的行高、段落间距和中文换行。\n\n```rust\nfn checkpoint(&self) -> Result<Vec<u8>> {\n    Ok(Vec::new())\n}\n```'
const firstParagraph = '已完成恢复接口与驱动组合，本次检查保持既有运行行为。'
const steerPrompt =
  '补充检查恢复失败时的处理。\n\n- 保留失败前的账户状态。\n- 验证资源清理。\n\n' +
  '核对错误恢复、会话切换和任务取消后的数据一致性。'.repeat(16) +
  '\n\n请返回复测结果。'
const stopTitle =
  '检查恢复接口与长任务名称：核对错误处理、资源释放以及多列聊天中的完整内容展示，不因停止回执没有正文而隐藏任务名称。'
let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''
const browserDiagnostics = []
const executionStartedAt = performance.now()
const executionEvents = []

function recordStage(stage, data = {}) {
  const event = { stage, elapsedMs: Math.round(performance.now() - executionStartedAt), ...data }
  executionEvents.push(event)
  console.log('[子代理消息视觉测试]', event)
}

async function buildPackage() {
  if (process.env.PI_SUBAGENT_VISUAL_SKIP_BUILD === '1') return
  await execFileAsync(
    'cmd.exe',
    [
      '/d',
      '/s',
      '/c',
      'pnpm --filter @jetcrab/pi-desk-sdk build && pnpm --filter @jetcrab/pi-desk-subagent build'
    ],
    {
      cwd: projectRoot,
      windowsHide: true,
      timeout: 120_000
    }
  )
}

async function createFixture() {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  await mkdir(projectDir, { recursive: true })
  await mkdir(runRoot, { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [packageDir] }))
  await writeFile(
    join(agentDir, 'trust.json'),
    JSON.stringify({ [await realpath(projectDir)]: true })
  )
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir)
  let timestamp = Date.now()
  const usage = {
    input: 120,
    output: 45,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 165,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
  const launch = {
    version: 1,
    kind: 'launch',
    taskId: agentId,
    agentType: 'dev',
    title,
    sessionFile: join(testRoot, 'child-session.jsonl'),
    startedAt: timestamp
  }
  const call = (name, args, details, output = '已完成', isError = false) => {
    const id = `visual-call-${timestamp}`
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: args }],
      api: 'openai-responses',
      provider: 'test',
      model: 'test-model',
      usage,
      stopReason: 'toolUse',
      timestamp: timestamp++
    })
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: id,
      toolName: name,
      content: [{ type: 'text', text: output }],
      details,
      isError,
      timestamp: timestamp++
    })
  }
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '检查子代理消息的任务归属、提示词预览和展开详情。' }],
    timestamp: timestamp++
  })
  call(
    'agent',
    {
      subagent_type: 'dev',
      description: title,
      prompt: `## 启动阶段\n\n检查驱动组合。\n\n${Array.from({ length: 20 }, (_, index) => `- 检查项 ${index + 1}：核对恢复接口与运行边界`).join('\n')}`
    },
    launch
  )
  call(
    'read',
    { path: 'lib.rs', reasoning: '检查恢复接口与运行边界', offset: 1, limit: 260 },
    {},
    '驱动实现'
  )
  call('agent_resume', { agent_id: agentId, prompt: '继续核对错误处理路径。' }, launch)
  call(
    'agent_steer',
    { agent_id: agentId, prompt: steerPrompt },
    { taskId: agentId, agentType: 'dev', title, delivery: 'delivered' },
    '补充要求已发送。工具回执不应出现在条件正文。'
  )
  call(
    'agent_steer',
    { agent_id: agentId, prompt: '等待开始后补充要求。' },
    { taskId: agentId, agentType: 'dev', title: '核对扩展关闭与资源释放', delivery: 'queued' }
  )
  call(
    'agent_steer',
    { agent_id: 'failed-agent-id', prompt: '补充条件失败后仍需辨认操作对象。' },
    {},
    'Agent failed-agent-id 当前不是 running',
    true
  )
  call('agent_stop', { agent_id: agentId }, { taskId: agentId, agentType: 'dev', title: stopTitle })
  call(
    'agent_resume',
    { agent_id: 'legacy-agent-id' },
    { ...launch, taskId: 'legacy-agent-id', title: '历史无正文任务' }
  )
  const agents = Array.from({ length: 20 }, (_, index) => ({
    taskId: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    agentType: ['dev', 'explore', 'research'][index % 3],
    title:
      index === 0
        ? '检查恢复接口与长标题：核对错误处理、资源释放及窄聊天列中的完整内容查看'
        : `核对驱动恢复路径 ${index + 1}`,
    status: ['running', 'completed', 'failed', 'interrupted'][index % 4],
    startedAt: timestamp - index * 60_000
  }))
  call('agent_list', {}, { agents })
  call('agent_list', { agent_id: agents[0].taskId }, { agents: [agents[0]] })
  call('agent_list', {}, { agents: [] })
  call('agent_stop', { agent_id: 'missing-agent' }, {}, '未知 Agent ID：missing-agent', true)
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: markdown }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp++
  })
  manager.appendCustomMessageEntry(
    'pi-desk-subagent:completion:v1',
    `子代理已完成。\n\nAgent ID: ${agentId}\n类型: dev\n任务: ${title}\n\n结果:\n${markdown}`,
    true,
    {
      version: 1,
      kind: 'terminal',
      taskId: agentId,
      status: 'completed',
      endedAt: timestamp++,
      sessionFile: launch.sessionFile
    }
  )
  manager.appendSessionInfo('子代理消息布局与交互')
  await writeFile(
    join(agentDir, 'pi-desk', 'work-sessions.json'),
    JSON.stringify({
      workSessions: [{ workId, cwd: projectDir, sessionId: manager.getSessionId() }],
      pinnedCount: 0
    })
  )
}

async function login(client) {
  await navigate(client, `http://127.0.0.1:${appPort}/login`)
  const result = await evaluate(
    client,
    `fetch('/api/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': '752009d7-4dc0-4fd0-ab75-28c981a04f8f' }, body: JSON.stringify({ password: ${JSON.stringify(password)} }) }).then(async response => ({ ok: response.ok, body: await response.json() }))`
  )
  assert.equal(result.ok, true, result.body?.msg)
}

function groupExpression(operation, text = '') {
  return `[...document.querySelectorAll('[role="group"]')].find(element => element.getAttribute('aria-label') === ${JSON.stringify('子代理' + operation + '消息')} && element.textContent.includes(${JSON.stringify(text)}) && element.getBoundingClientRect().width > 0)`
}

async function toggleGroup(client, operation) {
  assert.equal(
    await evaluate(
      client,
      `(() => { const button = ${groupExpression(operation)}?.querySelector('button[aria-expanded]'); if (!button) return false; button.click(); return true; })()`
    ),
    true,
    `未找到可展开消息：${operation}`
  )
}

async function capture(client, operation, file) {
  await evaluate(client, `${groupExpression(operation)}?.scrollIntoView({ block: 'center' })`)
  await writeFile(join(runRoot, `${file}.png`), await screenshot(client))
}

async function ensureProcessOpen(client) {
  await evaluate(
    client,
    `(() => {
    const button = [...document.querySelectorAll('button[aria-expanded]')].find(element => element.textContent?.includes('处理过程') && element.getBoundingClientRect().width > 0);
    if (button?.getAttribute('aria-expanded') === 'false') button.click();
  })()`
  )
  await waitFor(
    client,
    `(() => {
    const panel = ${groupExpression('最近记录')}?.closest('[data-slot="collapsible-content"]');
    return panel && panel.getBoundingClientRect().height > 200 && panel.style.getPropertyValue('--collapsible-panel-height').trim() === 'auto';
  })()`,
    '处理区展开且高度稳定'
  )
}

async function assertFits(client) {
  const errors = await evaluate(
    client,
    `(() => {
    const groups = [...document.querySelectorAll('[role="group"][aria-label$="消息"]')].filter(element => element.getBoundingClientRect().width > 0);
    return groups.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => ({ name: element.getAttribute('aria-label'), width: element.clientWidth, scroll: element.scrollWidth }));
  })()`
  )
  assert.deepEqual(errors, [], '子代理消息发生横向溢出')
}

async function main() {
  let client
  let passed = false
  try {
    await buildPackage()
    await createFixture()
    appPort = await reservePort()
    cdpPort = await reservePort()
    recordStage('开始启动服务', { appPort, cdpPort })
    serverRuntime = spawnE2eServer({
      projectRoot,
      agentDir,
      port: appPort,
      development: true,
      nextDirectory:
        process.env.PI_SUBAGENT_VISUAL_NEXT_DIR ??
        join(projectRoot, 'temp', 'build', 'subagent-message-visual', taskId, 'next'),
      onOutput: (output) => {
        serverOutput += output
        executionEvents.push({
          stage: '服务输出',
          elapsedMs: Math.round(performance.now() - executionStartedAt),
          output
        })
      }
    })
    await waitForHttp(
      `http://127.0.0.1:${appPort}/api/health`,
      Number(process.env.PI_SUBAGENT_VISUAL_STARTUP_TIMEOUT_MS ?? 30_000),
      'Pi Desk',
      () => serverOutput
    )
    recordStage('健康检查通过', { serverPid: serverRuntime.child.pid })
    browserProcess = spawnEdge(
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      cdpPort,
      join(runRoot, 'edge-profile')
    )
    await waitForHttp(
      `http://127.0.0.1:${cdpPort}/json/version`,
      20_000,
      'Edge CDP',
      () => serverOutput
    )
    client = await createCdpPage(cdpPort)
    for (const event of ['Runtime.exceptionThrown', 'Runtime.consoleAPICalled']) {
      client.events.set(
        event,
        new Set([(value) => browserDiagnostics.push({ type: event, event: value })])
      )
    }
    await setViewport(client, 1440, 1000, false)
    await login(client)
    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitFor(
      client,
      `document.body.innerText.includes('子代理消息视觉项目')`,
      '工作会话加载',
      () => serverOutput
    )
    await clickText(client, '子代理消息视觉项目')
    await waitFor(
      client,
      `document.body.innerText.includes(${JSON.stringify(firstParagraph)})`,
      '聊天历史加载',
      () => serverOutput
    )
    await ensureProcessOpen(client)
    await evaluate(
      client,
      `document.querySelectorAll('nextjs-portal').forEach(element => { element.style.display = 'none' })`
    )
    const sizes = await evaluate(
      client,
      `(() => {
      const group = ${groupExpression('启动任务')};
      const task = [...group.querySelectorAll('span')].find(element => element.textContent === '${title}');
      const tool = [...document.querySelectorAll('span')].find(element => element.textContent === 'read');
      return { task: getComputedStyle(task).fontSize, tool: getComputedStyle(tool).fontSize };
    })()`
    )
    assert.ok(parseFloat(sizes.task) > parseFloat(sizes.tool), '任务名不能退化为工具辅助字号')
    for (const operation of [
      '启动任务',
      '继续执行',
      '补充要求',
      '请求停止',
      '最近记录',
      '返回结果'
    ]) {
      assert.equal(await evaluate(client, `Boolean(${groupExpression(operation)})`), true)
    }
    for (const expression of [
      groupExpression('请求停止'),
      groupExpression('继续执行', '历史无正文任务')
    ]) {
      assert.equal(
        await evaluate(client, `${expression}.querySelector('button[aria-expanded]') === null`),
        true,
        '没有正文时不能提供空详情开关'
      )
    }
    assert.equal(
      await evaluate(client, `${groupExpression('请求停止')}.textContent.includes('已停止')`),
      false
    )
    assert.equal(
      await evaluate(client, `${groupExpression('请求停止')}.textContent.includes('${agentId}')`),
      true
    )
    const failure = await evaluate(client, `${groupExpression('补充要求', 'failed-a')}.innerText`)
    assert.match(failure, /子代理/)
    assert.match(failure, /#failed-a/)
    assert.match(failure, /请求失败/)
    assert.match(failure, /当前未运行/)
    assert.equal(failure.includes('running'), false)
    assert.equal(
      await evaluate(
        client,
        `document.body.innerText.includes('已排队') && document.body.innerText.includes('已发送')`
      ),
      true
    )
    const headerBefore = await evaluate(
      client,
      `(() => {
      const button = ${groupExpression('补充要求')}.querySelector('button[aria-expanded]');
      return { text: button.textContent, height: button.getBoundingClientRect().height };
    })()`
    )
    assert.match(headerBefore.text, new RegExp(title))
    assert.match(headerBefore.text, /补充检查恢复失败/)
    assert.match(headerBefore.text, /…/)
    assert.equal(headerBefore.text.includes('请返回复测结果。'), false)
    await assertFits(client)
    await capture(client, '补充要求', '子代理消息__暗色摘要')

    await toggleGroup(client, '启动任务')
    await waitFor(
      client,
      `${groupExpression('启动任务')}.textContent.includes('检查项 20')`,
      '完整任务要求'
    )
    const promptScroll = await evaluate(
      client,
      `(() => {
      const viewport = ${groupExpression('启动任务')}.querySelector('[data-slot="plugin-scroll-viewport"]');
      viewport.scrollTop = viewport.scrollHeight;
      const scrollable = viewport.scrollTop > 0;
      viewport.scrollTop = 0;
      return scrollable;
    })()`
    )
    assert.equal(promptScroll, true)
    await toggleGroup(client, '启动任务')
    await toggleGroup(client, '继续执行')
    await waitFor(
      client,
      `${groupExpression('继续执行')}.textContent.includes('继续核对错误处理路径。')`,
      '完整追加要求'
    )
    assert.equal(
      await evaluate(client, `${groupExpression('继续执行')}.textContent.includes('追加要求')`),
      true
    )
    await toggleGroup(client, '继续执行')
    await toggleGroup(client, '补充要求')
    await waitFor(
      client,
      `${groupExpression('补充要求')}.textContent.includes('请返回复测结果。')`,
      '完整补充要求'
    )
    const headerAfter = await evaluate(
      client,
      `(() => {
      const button = ${groupExpression('补充要求')}.querySelector('button[aria-expanded]');
      return { text: button.textContent, height: button.getBoundingClientRect().height };
    })()`
    )
    assert.deepEqual(headerAfter, headerBefore, '展开不能隐藏简述或改变任务头部')
    assert.equal(
      await evaluate(
        client,
        `${groupExpression('补充要求')}.textContent.includes('工具回执不应出现在条件正文')`
      ),
      false
    )
    await capture(client, '补充要求', '子代理消息__补充详情')
    await toggleGroup(client, '补充要求')

    const list = groupExpression('最近记录', '20 条')
    assert.equal(await evaluate(client, `${list}.querySelectorAll('li').length`), 3)
    assert.equal(
      await evaluate(
        client,
        `${list}.querySelector('button').textContent.includes('查看全部 20 条')`
      ),
      true
    )
    await evaluate(client, `${list}.querySelector('button').click()`)
    await waitFor(client, `${list}.querySelectorAll('li').length === 20`, '全部最近记录')
    assert.equal(
      await evaluate(
        client,
        `${list}.textContent.includes('00000001-1111-4111-8111-111111111111')`
      ),
      true
    )
    await capture(client, '最近记录', '子代理消息__最近记录')
    await evaluate(client, `${list}.querySelector('button').click()`)
    assert.equal(
      await evaluate(
        client,
        `${groupExpression('最近记录', '暂无子代理记录')}.querySelector('button') === null`
      ),
      true
    )
    assert.equal(
      await evaluate(client, `${groupExpression('查询记录')}.querySelector('button') === null`),
      true
    )

    recordStage('消息头部、按需详情与列表检查通过')
    // 末尾消息在吸底状态展开，头部不能被新增详情推走。
    const anchorBefore = await evaluate(
      client,
      `(() => {
      const group = ${groupExpression('返回结果')};
      group.scrollIntoView({ block: 'end' });
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(group.getBoundingClientRect().top))));
    })()`
    )
    await toggleGroup(client, '返回结果')
    await waitFor(
      client,
      `${groupExpression('返回结果')}.textContent.includes('实际接口')`,
      '返回内容按需加载'
    )
    const anchorAfter = await evaluate(
      client,
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(${groupExpression('返回结果')}.getBoundingClientRect().top))))`
    )
    recordStage('返回结果展开锚点', { anchorBefore, anchorAfter })
    await writeFile(
      join(runRoot, 'anchor.json'),
      JSON.stringify({ anchorBefore, anchorAfter, delta: anchorAfter - anchorBefore }, null, 2)
    )
    assert.ok(
      Math.abs(anchorAfter - anchorBefore) < 3,
      `展开顶走头部：${anchorBefore} → ${anchorAfter}`
    )
    const typography = await evaluate(
      client,
      `(() => {
      const plugin = ${groupExpression('返回结果')};
      const pluginP = [...plugin.querySelectorAll('p')].find(element => element.textContent === ${JSON.stringify(firstParagraph)});
      const chatP = [...document.querySelectorAll('p')].find(element => !element.closest('[aria-label="子代理返回结果消息"]') && element.textContent === ${JSON.stringify(firstParagraph)});
      const describe = p => {
        const root = p.parentElement;
        const li = root.querySelector('[data-streamdown="list-item"]');
        const h = root.querySelector('h3');
        const code = root.querySelector('[data-streamdown="code-block-body"]');
        return { paragraph: { font: getComputedStyle(p).fontSize, line: getComputedStyle(p).lineHeight, top: getComputedStyle(p).marginTop, bottom: getComputedStyle(p).marginBottom }, list: { line: getComputedStyle(li).lineHeight, top: getComputedStyle(li).paddingTop, bottom: getComputedStyle(li).paddingBottom }, heading: { font: getComputedStyle(h).fontSize, weight: getComputedStyle(h).fontWeight, top: getComputedStyle(h).marginTop, bottom: getComputedStyle(h).marginBottom }, code: { font: getComputedStyle(code).fontSize, line: getComputedStyle(code).lineHeight, padding: getComputedStyle(code).padding } };
      };
      return { plugin: describe(pluginP), chat: describe(chatP) };
    })()`
    )
    assert.deepEqual(typography.plugin, typography.chat, '插件Markdown与聊天正文排版不一致')
    await capture(client, '返回结果', '子代理消息__返回结果')
    await toggleGroup(client, '返回结果')
    await evaluate(
      client,
      `localStorage.setItem('pi-super-theme', 'light'); window.dispatchEvent(new StorageEvent('storage', { key: 'pi-super-theme', newValue: 'light' }))`
    )
    await waitFor(client, `!document.documentElement.classList.contains('dark')`, '亮色主题')
    await capture(client, '补充要求', '子代理消息__亮色摘要')
    for (const [width, height, mobile] of [
      [640, 900, false],
      [390, 844, true]
    ]) {
      await setViewport(client, width, height, mobile)
      await ensureProcessOpen(client)
      await assertFits(client)
      assert.equal(
        await evaluate(
          client,
          `${groupExpression('请求停止')}.textContent.includes(${JSON.stringify(stopTitle)})`
        ),
        true
      )
      const titleVisible = await evaluate(
        client,
        `(() => {
        const text = [...${groupExpression('请求停止')}.querySelectorAll('span')].find(element => element.textContent === ${JSON.stringify(stopTitle)});
        return text.scrollHeight <= text.clientHeight + 1;
      })()`
      )
      assert.equal(titleVisible, true, '停止回执长任务名必须完整可见')
      await capture(client, '补充要求', `子代理消息__摘要__${width}`)
      await toggleGroup(client, '补充要求')
      await waitFor(
        client,
        `${groupExpression('补充要求')}.textContent.includes('请返回复测结果。')`,
        '窄屏完整补充要求'
      )
      await capture(client, '补充要求', `子代理消息__详情__${width}`)
      await toggleGroup(client, '补充要求')
    }
    await writeFile(
      join(runRoot, 'checks.json'),
      JSON.stringify(
        { sizes, typography, anchorBefore, anchorAfter, appPort, cdpPort, passed: true },
        null,
        2
      )
    )
    assert.deepEqual(
      browserDiagnostics.filter(
        (item) => item.type === 'Runtime.exceptionThrown' || item.event.type === 'error'
      ),
      [],
      '浏览器出现运行异常'
    )
    passed = true
    console.log(`子代理消息视觉与交互检查通过，待主代理审阅截图：${runRoot}`)
  } catch (error) {
    await mkdir(runRoot, { recursive: true })
    await writeFile(join(runRoot, 'failure.txt'), String(error.stack ?? error))
    if (client)
      await writeFile(join(runRoot, '失败现场.png'), await screenshot(client)).catch(
        () => undefined
      )
    recordStage('首先异常', { error: String(error.stack ?? error) })
    throw error
  } finally {
    await mkdir(runRoot, { recursive: true })
    await writeFile(join(runRoot, 'server.log'), serverOutput)
    await writeFile(join(runRoot, 'browser.json'), JSON.stringify(browserDiagnostics, null, 2))
    client?.close()
    try {
      await stopBrowserTree(browserProcess, cdpPort)
    } finally {
      if (serverRuntime) await stopE2eServerTree(serverRuntime)
    }
    recordStage('进程树关闭且端口释放', {
      appPort,
      cdpPort,
      serverPid: serverRuntime?.child.pid,
      browserPid: browserProcess?.pid
    })
    await writeFile(join(runRoot, 'execution.json'), JSON.stringify(executionEvents, null, 2))
    if (passed) await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
