import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCdpPage,
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
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testRoot = join(projectRoot, 'temp/pi/skills-settings-e2e', String(process.pid))
const agentDir = join(testRoot, 'agent')
const projectA = join(testRoot, 'projects', '订单服务')
const projectB = join(testRoot, 'projects', '移动应用')
const entryA = join(projectA, '.pi/skills/release-guide/SKILL.md')
const referenceA = join(dirname(entryA), 'references/check.md')
const entryGlobal = join(agentDir, 'skills/global-notes/SKILL.md')
const managedRoot = join(agentDir, 'npm/node_modules/@skills-fixture/catalog')
const entryManaged = join(managedRoot, 'skills/managed-notes/SKILL.md')
const captures = []
let serverRuntime
let browser
let client
let appPort = 0
let cdpPort = 0
let serverOutput = ''

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
function skill(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}
async function fixture() {
  process.env.TSX_TSCONFIG_PATH = join(projectRoot, 'tsconfig.json')
  process.env.NODE_PATH = ''
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  process.env.HOME = join(agentDir, 'home')
  process.env.USERPROFILE = join(agentDir, 'home')
  process.env.PI_OFFLINE = '1'
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(join(agentDir, 'home'), { recursive: true })
  await mkdir(join(projectA, '.git'), { recursive: true })
  await mkdir(join(projectB, '.git'), { recursive: true })
  await put(
    entryA,
    skill(
      'release-guide',
      '订单服务的发布说明、检查清单与辅助脚本',
      '# 发布说明\n\n## 发布前检查\n\n- 检查测试结果\n- 核对变更范围\n- 阅读 references/check.md\n\n## 相关文件\n\n辅助脚本位于 scripts/。'
    )
  )
  await put(referenceA, '\uFEFF# 发布检查清单\r\n\r\n这里是待维护的项目参考文件。\r\n')
  await put(
    join(dirname(entryA), 'scripts/release.mjs'),
    'export const releaseTarget = "staging"\n'
  )
  await put(join(dirname(entryA), 'assets/config.json'), '{"environment":"staging"}\n')
  await put(join(dirname(entryA), 'assets/unsupported.bin'), Buffer.from([0, 255, 0]))
  await put(
    entryGlobal,
    skill(
      'global-notes',
      '所有项目共用的工作说明',
      '# 全局说明\n\n此内容来自独立的测试 Agent 目录。'
    )
  )
  await put(
    join(projectB, '.agents/skills/mobile-check/SKILL.md'),
    skill('mobile-check', '移动应用的界面检查说明', '# 移动应用\n')
  )
  await put(
    entryManaged,
    skill('managed-notes', '包管理器维护的只读技能', '# 包内资源\n\n此文件应保持只读。')
  )
  await put(
    join(managedRoot, 'package.json'),
    JSON.stringify({
      name: '@skills-fixture/catalog',
      version: '1.0.0',
      pi: { skills: ['skills'] }
    })
  )
  await put(
    join(agentDir, 'npm/package.json'),
    JSON.stringify({ dependencies: { '@skills-fixture/catalog': '1.0.0' } })
  )
  await put(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      packages: ['npm:@skills-fixture/catalog'],
      defaultProjectTrust: 'always',
      enableInstallTelemetry: false
    })
  )
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const records = []
  for (const [index, cwd] of [projectA, projectA, projectB].entries()) {
    const session = SessionManager.create(cwd)
    session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: `Skills 编辑验收会话 ${index + 1}` }],
      timestamp: Date.now()
    })
    session.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '工作区已准备好，可以打开设置管理 Skills。' }],
      api: 'openai-responses',
      provider: 'test',
      model: 'test-model',
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
    records.push({ workId: `skills-work-${index}`, cwd, sessionId: session.getSessionId() })
  }
  await put(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({ workSessions: records, pinnedCount: 0 })
  )
}

async function click(label) {
  const result = await evaluate(
    client,
    `(() => {
    const target = [...document.querySelectorAll('[aria-label]')].find(e => e.getAttribute('aria-label') === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0);
    if (!target || target.disabled) return false; target.click(); return true;
  })()`
  )
  assert.equal(result, true, `操作不可用：${label}`)
}
async function clickText(text) {
  const result = await evaluate(
    client,
    `(() => {
    const target = [...document.querySelectorAll('button')].reverse().find(e => e.textContent.trim() === ${JSON.stringify(text)} && e.getBoundingClientRect().width > 0 && !e.disabled);
    if (!target) return false; target.click(); return true;
  })()`
  )
  assert.equal(result, true, `按钮不可用：${text}`)
}
async function wait(expression, label, timeout = 30000) {
  await waitFor(client, expression, label, () => serverOutput.slice(-12000), timeout)
}
async function waitEditor(text) {
  await wait(
    `document.querySelector('[aria-label="Skill 文件编辑器"]') !== null && document.querySelector('[aria-label="正在切换文件"]') === null && document.querySelector('[aria-label="Skills 管理"]')?.textContent.includes(${JSON.stringify(text)})`,
    `Monaco 展示 ${text}`,
    60000
  )
}
async function key(key, code, modifiers = 0, windowsVirtualKeyCode) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode
  })
}
async function edit(content, composition = false) {
  assert.equal(
    await evaluate(
      client,
      `(() => { const e = document.querySelector('[aria-label="Skill 文件编辑器"]'); if (!e) return false; e.focus(); return true; })()`
    ),
    true
  )
  await key('a', 'KeyA', 2, 65)
  if (composition)
    await client.send('Input.imeSetComposition', {
      text: '中文草稿',
      selectionStart: 4,
      selectionEnd: 4
    })
  await client.send('Input.insertText', { text: content })
  await wait(
    `document.querySelector('[aria-label="保存 Skill 文件"]')?.disabled === false`,
    '编辑后出现未保存状态'
  )
}
async function save(shortcut = false) {
  if (shortcut) await key('s', 'KeyS', 2, 83)
  else await click('保存 Skill 文件')
  await wait(
    `document.querySelector('[aria-label="文件已保存"]') !== null && document.querySelector('[aria-label="保存 Skill 文件"]')?.disabled === true && !document.querySelector('[aria-label="Skills 管理"] [role="alert"]')`,
    '文件保存成功'
  )
}
async function openSkill(name) {
  await click(`Skill：${name}`)
  await waitEditor(name)
}
async function capture(name, condition) {
  await wait(
    `(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(e => e.getBoundingClientRect().width > 0);
    return dialogs.every(e => Number(getComputedStyle(e).opacity) === 1 && e.getAnimations().every(a => a.playState === 'finished' || a.playState === 'idle'));
  })()`,
    '弹层进入稳定展示状态'
  )
  const bytes = await screenshot(client)
  await put(join(testRoot, 'captures', `${condition}-${name}.png`), bytes)
  captures.push([
    join(projectRoot, 'temp/验收', `客户端_${condition}`, `Skills管理__${name}.png`),
    bytes
  ])
}
async function api(path, body) {
  return evaluate(
    client,
    `fetch(${JSON.stringify(path)}, {method:'POST',headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':'58b39190-466c-449c-bdce-52743d3c420e'},body:JSON.stringify(${JSON.stringify(body)})}).then(async r=>({status:r.status,body:await r.json()}))`
  )
}

async function main() {
  try {
    await fixture()
    appPort = await reservePort()
    cdpPort = await reservePort()
    serverRuntime = spawnE2eServer({
      projectRoot,
      agentDir,
      port: appPort,
      development: true,
      onOutput: (text) => {
        serverOutput = (serverOutput + text).slice(-150000)
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
      join(testRoot, 'edge-profile')
    )
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20000, 'Edge')
    client = await createCdpPage(cdpPort)
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__skillsErrors = []
        window.__skillsHoldFileGet = false
        window.__skillsReleaseFileGet = null
        const __skillsOriginalFetch = window.fetch.bind(window)
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : input.url
          if (window.__skillsHoldFileGet && url.includes('/api/skill-files/get')) {
            return new Promise((resolve, reject) => {
              window.__skillsReleaseFileGet = () => {
                window.__skillsHoldFileGet = false
                window.__skillsReleaseFileGet = null
                __skillsOriginalFetch(input, init).then(resolve, reject)
              }
            })
          }
          return __skillsOriginalFetch(input, init)
        }
        window.addEventListener('error', (event) => window.__skillsErrors.push(event.message))
        window.addEventListener('unhandledrejection', (event) => window.__skillsErrors.push(String(event.reason)))
      `
    })
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    await setViewport(client, 1440, 900, false)
    await navigate(client, `http://127.0.0.1:${appPort}/login`)
    const unauthenticated = await api('/api/skills/list', { cwd: null })
    assert.equal(unauthenticated.status, 401)
    const login = await api('/api/auth/login', { password: 'Qq.445566' })
    assert.equal(login.status, 200)
    await evaluate(
      client,
      `localStorage.setItem('pi-desk:workbench-layout',JSON.stringify({primaryWorkId:'skills-work-0'}))`
    )
    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await wait(
      `document.querySelector('[data-work-id="skills-work-0"] textarea') !== null`,
      '工作区初始化',
      60000
    )
    await click('设置')
    await click('设置分类：Skills')
    await waitEditor('release-guide')
    await wait(
      `document.querySelector('[aria-label="Skills 项目目录"]')?.textContent.includes('2 个项目')`,
      '同 cwd 多会话只显示一个项目'
    )
    assert.equal(
      await evaluate(
        client,
        `[...document.querySelectorAll('[aria-label="项目 Skills：订单服务"]')].filter(e=>e.getBoundingClientRect().width>0).length`
      ),
      1
    )

    await evaluate(client, `document.querySelector('[aria-label="搜索项目或 Skill"]').focus()`)
    await client.send('Input.insertText', { text: 'mobile-check' })
    await wait(
      `document.querySelector('[aria-label="Skill：mobile-check"]')?.getBoundingClientRect().width > 0`,
      '搜索加载其他项目 Skills 并保留分组'
    )
    await key('a', 'KeyA', 2, 65)
    await key('Backspace', 'Backspace', 0, 8)
    await wait(
      `document.querySelector('[aria-label="Skill：release-guide"]')?.getBoundingClientRect().width > 0`,
      '清空搜索恢复项目目录'
    )

    const global = await api('/api/skills/list', { cwd: null })
    assert.equal(global.body.code, 0)
    assert.equal(
      global.body.data.skills.some((item) => item.name === 'release-guide'),
      false
    )
    const project = await api('/api/skills/list', { cwd: projectA })
    assert.deepEqual(
      project.body.data.skills.map((item) => item.name),
      ['release-guide']
    )
    assert.equal((await api('/api/skills/list', { cwd: testRoot })).status, 409)
    assert.equal(
      (await api('/api/skill-files/get', { cwd: projectA, skillPath: entryA, path: '../secret' }))
        .status,
      400
    )
    const replaced = await api('/api/skill-files/replace', {
      cwd: null,
      skillPath: entryManaged,
      path: 'SKILL.md',
      content: 'not allowed'
    })
    assert.equal(replaced.status, 403)
    const read = await api('/api/skill-files/get', {
      cwd: projectA,
      skillPath: entryA,
      path: 'references/check.md'
    })
    assert.equal(read.body.data.readOnlyReason, null)
    const binary = await api('/api/skill-files/get', {
      cwd: projectA,
      skillPath: entryA,
      path: 'assets/unsupported.bin'
    })
    assert.equal(binary.body.data.kind, 'unsupported')

    await click('Skill 目录：release-guide/references')
    await wait(
      `document.querySelector('[aria-label="Skill 文件：release-guide/references/check.md"]') !== null`,
      '参考文件目录加载'
    )
    await click('Skill 文件：release-guide/references/check.md')
    await waitEditor('发布检查清单')
    await edit('# 中文未保存草稿\n\n目录刷新不能覆盖这段内容。\n')
    await wait(
      `!document.querySelector('[aria-label="刷新 Skills 目录"]').disabled`,
      '目录查询完成'
    )
    await click('刷新 Skills 目录')
    await wait(
      `!document.querySelector('[aria-label="刷新 Skills 目录"]').disabled`,
      '目录刷新完成'
    )
    assert.equal(
      await evaluate(
        client,
        `document.querySelector('[aria-label="Skills 管理"]').textContent.includes('中文未保存草稿')`
      ),
      true
    )
    await click('设置分类：关于')
    await wait(`document.body.innerText.includes('保存文件修改？')`, '切换分类触发未保存确认')
    await clickText('取消')
    await wait(`!document.body.innerText.includes('保存文件修改？')`, '取消后继续编辑')
    assert.equal(
      await evaluate(client, `document.querySelector('[aria-label="保存 Skill 文件"]').disabled`),
      false
    )

    await rename(referenceA, `${referenceA}.removed`)
    await click('保存 Skill 文件')
    await wait(
      `document.querySelector('[aria-label="Skills 管理"] [role="alert"]')?.textContent.includes('不存在')`,
      '保存失败保留草稿'
    )
    assert.equal(
      await evaluate(client, `document.querySelector('[aria-label="保存 Skill 文件"]').disabled`),
      false
    )
    await rename(`${referenceA}.removed`, referenceA)
    await click('Skill 文件：release-guide/SKILL.md')
    await wait(`document.body.innerText.includes('保存文件修改？')`, '切换文件触发未保存确认')
    await clickText('保存并继续')
    await waitEditor('发布前检查')
    assert.equal(
      await readFile(referenceA, 'utf8'),
      '\uFEFF# 中文未保存草稿\r\n\r\n目录刷新不能覆盖这段内容。\r\n'
    )

    const originalEntry = await readFile(entryA, 'utf8')
    await edit('这是一段要放弃的修改')
    await click('Skill：global-notes')
    await wait(`document.body.innerText.includes('保存文件修改？')`, '切换 Skill 触发未保存确认')
    await clickText('放弃修改')
    await waitEditor('全局说明')
    assert.equal(await readFile(entryA, 'utf8'), originalEntry)
    await openSkill('managed-notes')
    await wait(
      `document.querySelector('[aria-label="Skills 管理"] [role="note"]')?.textContent.includes('包管理器')`,
      '包内资源只读说明'
    )
    assert.equal(
      await evaluate(client, `document.querySelector('[aria-label="保存 Skill 文件"]').disabled`),
      true
    )
    await capture('包内只读', '桌面')
    await evaluate(client, `window.__skillsHoldFileGet = true`)
    await click('Skill：release-guide')
    await wait(`document.querySelector('[aria-label="正在切换文件"]') !== null`, '切换文件状态')
    assert.deepEqual(
      await evaluate(
        client,
        `(() => ({
          editor: document.querySelector('[aria-label="Skill 文件编辑器"]') !== null,
          oldContent: document.body.innerText.includes('包内资源'),
          loadingMask: document.body.innerText.includes('正在读取文件…')
        }))()`
      ),
      { editor: true, oldContent: true, loadingMask: false }
    )
    const visibleSkillButtons = await evaluate(
      client,
      `(() => [...document.querySelectorAll('button[aria-label^="Skill："], button[aria-label^="Skill 文件："]')]
        .filter((button) => {
          const rect = button.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        })
        .map((button) => ({
          label: button.getAttribute('aria-label'),
          disabled: button.disabled,
          opacity: getComputedStyle(button).opacity
        })))()`
    )
    assert.ok(visibleSkillButtons.length > 0, '挂起期间应有可见的 Skill 或文件按钮')
    assert.equal(
      visibleSkillButtons.some((button) => button.disabled),
      false,
      `挂起期间目录按钮不应 disabled：${JSON.stringify(visibleSkillButtons)}`
    )
    assert.equal(
      visibleSkillButtons.some((button) => button.opacity === '0.5'),
      false,
      `挂起期间目录按钮不应降为 disabled opacity：${JSON.stringify(visibleSkillButtons)}`
    )
    assert.equal(
      await evaluate(
        client,
        `(() => {
          const button = [...document.querySelectorAll('button[aria-label="Skill：release-guide"]')]
            .find((item) => {
              const rect = item.getBoundingClientRect()
              return rect.width > 0 && rect.height > 0
            })
          if (!button) return false
          button.click()
          return true
        })()`
      ),
      true,
      '挂起期间应允许重复点击 Skill 按钮'
    )
    await evaluate(client, `window.__skillsReleaseFileGet?.(); true`)
    await waitEditor('发布前检查')
    await edit(originalEntry.replace('发布前检查', '发布前检查（已更新）'))
    await save(true)
    assert.ok((await readFile(entryA, 'utf8')).includes('发布前检查（已更新）'))
    await capture('源码编辑', '桌面')

    await setViewport(client, 390, 844, true)
    await wait(
      `document.querySelector('[aria-label="打开 Skills 目录"]')?.getBoundingClientRect().width > 0`,
      '移动端目录入口'
    )
    await click('打开 Skills 目录')
    await wait(`document.body.innerText.includes('Skills 目录')`, '移动目录抽屉')
    await capture('项目目录', '移动端')
    await click('Skill 文件：release-guide/SKILL.md')
    await waitEditor('发布前检查（已更新）')
    await edit(
      skill(
        'release-guide',
        '移动端中文输入已验证',
        '# 中文技能编辑\n\n可在手机宽度下修改并保存。'
      ),
      true
    )
    await save()
    assert.ok((await readFile(entryA, 'utf8')).includes('中文技能编辑'))
    await capture('源码编辑', '移动端')
    await setViewport(client, 390, 480, true)
    await wait(
      `(() => { const b=document.querySelector('[aria-label="保存 Skill 文件"]'); const r=b.getBoundingClientRect(); return r.top>=0 && r.bottom<=window.innerHeight && document.documentElement.scrollWidth<=window.innerWidth; })()`,
      '缩短视口后保存操作仍可见且无横向溢出'
    )
    await setViewport(client, 390, 844, true)
    await edit('关闭设置前的未保存内容')
    assert.equal(
      await evaluate(
        client,
        `(() => { const dialog=document.querySelector('[aria-label="Skills 管理"]').closest('[role="dialog"]'); const button=dialog.querySelector('[aria-label="关闭弹窗"]'); button.click(); return true; })()`
      ),
      true
    )
    await wait(`document.body.innerText.includes('保存文件修改？')`, '关闭设置受到保护')
    await clickText('取消')
    await wait(`!document.body.innerText.includes('保存文件修改？')`, '取消关闭后保持编辑')
    assert.equal(
      await evaluate(client, `document.querySelector('[aria-label="保存 Skill 文件"]').disabled`),
      false
    )
    const leaving = client.once('Page.javascriptDialogOpening')
    const navigation = client.send('Page.navigate', { url: 'about:blank' })
    let leaveTimeout
    const leaveDialog = await Promise.race([
      leaving,
      new Promise((_, reject) => {
        leaveTimeout = setTimeout(() => reject(new Error('浏览器未显示未保存离开提醒')), 10000)
      })
    ]).finally(() => clearTimeout(leaveTimeout))
    assert.equal(leaveDialog.type, 'beforeunload')
    await client.send('Page.handleJavaScriptDialog', { accept: false })
    await navigation
    await wait(
      `document.querySelector('[aria-label="Skills 管理"]') !== null`,
      '取消浏览器离开后保留编辑页'
    )
    const errors = await evaluate(client, 'window.__skillsErrors')
    assert.deepEqual(errors, [], `浏览器异常：${JSON.stringify(errors)}`)
    console.log(
      'PASS: Skills HTTP、项目去重、多文件、中文编辑、保存/失败/离开保护、只读及桌面/移动布局'
    )
  } catch (error) {
    // 失败诊断覆盖同一位置，浏览器 profile 和隔离会话在 finally 中释放。
    const failureRoot = join(dirname(testRoot), 'failure')
    try {
      if (client) await put(join(failureRoot, 'failure.png'), await screenshot(client))
      await put(join(failureRoot, 'server.log'), serverOutput)
    } catch {}
    throw error
  } finally {
    client?.close()
    try {
      await stopBrowserTree(browser, cdpPort)
    } finally {
      if (serverRuntime) await stopE2eServerTree(serverRuntime)
    }
    await rm(testRoot, { recursive: true, force: true })
  }
  await publishScreenshots(captures)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
