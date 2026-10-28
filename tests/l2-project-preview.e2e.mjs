import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { scryptSync } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
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
  waitForHttp,
  waitForBrowserReady
} from './l4-browser-cdp-runtime.mjs'
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'
import {
  verifyProjectPreviewEntries,
  verifyPreviewConnectionLifecycle
} from './fixtures/l2-project-preview-entries.mjs'
import {
  prepareProjectPreviewBrowsing,
  verifyProjectPreviewBrowsing
} from './fixtures/l2-project-preview-browsing.mjs'
import {
  prepareProjectPreviewRefresh,
  verifyProjectPreviewRefresh
} from './fixtures/l2-project-preview-refresh.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const task = `independent-preview-${Date.now()}-${process.pid}`
const output = join(root, 'temp/run/project-preview', task)
const agentRoot = join(root, 'temp/pi/project-preview-e2e', task)
const agentDir = join(agentRoot, 'agent')
const fixtures = join(root, 'temp/tests/project-preview', task)
const build = join(root, 'temp/build/project-preview', task)
const project = join(fixtures, '代码 空格#&')
const plain = join(fixtures, 'plain')
const password = 'Preview-only-42!'
const checks = []
const pages = []
let service, browser, page, port, browserPort
let serverOutput = ''
let passed = false
const failures = []
const href = (cwd) => `/project-preview${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`
const observationMs = 60_000

async function progress(text) {
  checks.push(text)
  console.log(`[独立预览验收] ${text}`)
  await writeFile(join(output, 'progress.json'), JSON.stringify(checks, null, 2))
}
async function prepare() {
  await mkdir(output, { recursive: true })
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  await mkdir(project, { recursive: true })
  await mkdir(plain, { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], extensions: [] }))
  await writeFile(
    join(agentDir, 'pi-desk-settings.json'),
    JSON.stringify({ region: { locale: 'zh-CN', timeZone: 'UTC' } })
  )
  await writeFile(join(agentDir, 'pi-desk/auth-session-key'), Buffer.alloc(32, 7).toString('hex'))
  const salt = Buffer.alloc(16, 5)
  const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  await writeFile(
    join(agentDir, 'pi-desk/auth.json'),
    JSON.stringify({ passwordHash: `scrypt:${salt.toString('hex')}:${hash.toString('hex')}` })
  )
  await writeFile(join(project, 'hello.ts'), 'export const greeting = "preview-original"\n')
  await writeFile(join(project, 'README.md'), '# 项目预览示例\n\n共享预览中的 **Markdown**。\n')
  await writeFile(
    join(project, 'demo.html'),
    '<!doctype html><html><body><h1>静态页面示例</h1></body></html>'
  )
  await writeFile(
    join(project, 'pixel.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII=',
      'base64'
    )
  )
  await writeFile(join(plain, 'plain.txt'), '独立普通目录\n')
  if (process.argv.includes('--refresh-only')) await prepareProjectPreviewRefresh(project)
  execFileSync('git', ['init', '--quiet', project], { windowsHide: true })
  execFileSync('git', ['-C', project, 'add', '.'], { windowsHide: true })
  execFileSync(
    'git',
    [
      '-C',
      project,
      '-c',
      'user.name=Preview Test',
      '-c',
      'user.email=preview@example.test',
      'commit',
      '--quiet',
      '-m',
      '预览测试初始提交'
    ],
    { windowsHide: true }
  )
}
const observeScript = `
window.__previewRequests=[];window.__previewSockets=[];window.__previewErrors=[];window.__previewPending=0;
const fetchOriginal=window.fetch.bind(window);
window.fetch=async (...args)=>{
  const url=String(args[0]); const tracked=new URL(url,location.href).pathname.startsWith('/api/');
  const item=tracked?{url,body:args[1]?.body,clientId:new Headers(args[1]?.headers).get('X-Pi-Desk-Client-Id')}:null;
  if(item){window.__previewRequests.push(item);window.__previewPending++}
  try{const response=await fetchOriginal(...args);if(item){item.status=response.status;item.result=await response.clone().json()}return response}
  finally{if(item)window.__previewPending--}
};
const Socket=window.WebSocket;
window.WebSocket=class extends Socket{constructor(...args){super(...args);window.__previewSockets.push(String(args[0]))}};
window.addEventListener('error',event=>window.__previewErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.__previewErrors.push(String(event.reason)));
`
async function newPage() {
  const result = await createCdpPage(browserPort)
  pages.push(result)
  await result.send('Page.addScriptToEvaluateOnNewDocument', { source: observeScript })
  await setViewport(result, 1440, 900, false)
  return result
}
async function wait(expression, label, target = page) {
  await waitFor(target, expression, label, () => serverOutput, 60_000)
}
async function settled(target = page) {
  await wait(
    'window.__previewPending === 0 && !document.body.innerText.includes("正在与 HEAD 比较")',
    '当前读取结束',
    target
  )
}
async function click(selector, target = page) {
  await wait(
    `Boolean([...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getClientRects().length&&!el.closest('[inert],[aria-hidden="true"]')))`,
    `操作可见 ${selector}`,
    target
  )
  await evaluate(
    target,
    `([...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getClientRects().length&&!el.closest('[inert],[aria-hidden="true"]'))).click()`
  )
}
async function textButton(text, target = page) {
  const selector = `button`
  const expression = `([...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getClientRects().length && el.textContent.trim()===${JSON.stringify(text)}))`
  await wait(`Boolean(${expression})`, `按钮 ${text}`, target)
  await evaluate(target, `${expression}.click()`)
}
async function input(selector, value, target = page) {
  await wait(
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    `输入 ${selector}`,
    target
  )
  await evaluate(
    target,
    `document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`
  )
  await target.send('Input.insertText', { text: value })
}
async function capture(name) {
  await settled()
  await evaluate(
    page,
    `document.querySelectorAll('nextjs-portal').forEach(element=>element.style.setProperty('display','none','important'))`
  )
  await writeFile(join(output, name), await screenshot(page))
}
async function assertIndependent() {
  const state = await evaluate(
    page,
    '({requests:window.__previewRequests,sockets:window.__previewSockets,errors:window.__previewErrors})'
  )
  assert.deepEqual(state.errors, [])
  assert.equal(
    state.sockets.some((url) => new URL(url, `http://localhost:${port}`).pathname === '/api/ws'),
    false
  )
  assert.equal(
    state.requests.some((item) => /work-sessions|chat\/|plugins\//.test(item.url)),
    false
  )
  for (const item of state.requests) {
    assert.ok(item.clientId, `缺少页面身份 ${item.url}`)
    if (item.body && /project-files|project-git/.test(item.url))
      assert.equal(JSON.parse(item.body).workId, undefined)
  }
}
async function idle(label) {
  await settled()
  const before = await evaluate(page, 'window.__previewRequests.length')
  await new Promise((done) => setTimeout(done, observationMs))
  assert.equal(await evaluate(page, 'window.__previewPending'), 0)
  assert.equal(
    await evaluate(page, 'window.__previewRequests.length'),
    before,
    `${label}闲置产生请求`
  )
  await assertIndependent()
  await progress(`${label}：静置60秒无自动业务请求`)
}
async function login(target = page) {
  await input('#password', password, target)
  await click('button[type="submit"]', target)
}
async function go(cwd) {
  await navigate(page, `http://127.0.0.1:${port}${href(cwd)}`)
  await wait(
    `Boolean(document.querySelector('[data-testid="${cwd ? 'project-preview' : 'project-picker'}"]'))`,
    '预览页面'
  )
}
async function run() {
  await prepare()
  const browsingFixture = process.argv.includes('--browsing-only')
    ? await prepareProjectPreviewBrowsing(project)
    : null
  port = await reservePort()
  browserPort = await reservePort()
  service = spawnE2eServer({
    projectRoot: root,
    agentDir,
    port,
    development: true,
    nextDirectory: join(build, 'next'),
    environment: { NODE_OPTIONS: '' },
    onOutput: (chunk) => {
      serverOutput = (serverOutput + chunk).slice(-1024 * 1024)
      appendFileSync(join(output, 'server.log'), chunk)
    }
  })
  await waitForHttp(
    `http://127.0.0.1:${port}/api/health`,
    120_000,
    '隔离Pi Desk',
    () => serverOutput
  )
  browser = spawnEdge(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    browserPort,
    join(output, 'browser'),
    '1440,900'
  )
  await waitForBrowserReady(browser, browserPort)
  page = await newPage()
  await navigate(page, `http://127.0.0.1:${port}${href(project)}`)
  await wait(
    'location.pathname==="/login" && Boolean(document.querySelector("#password"))',
    '登录回跳入口'
  )
  assert.equal(
    await evaluate(page, 'new URL(location.href).searchParams.get("returnTo")'),
    href(project)
  )
  await login()
  await wait(
    `location.pathname==='/project-preview' && new URL(location.href).searchParams.get('cwd')===${JSON.stringify(project)} && Boolean(document.querySelector('[data-testid="project-file-hello.ts"]'))`,
    '登录返回目标目录'
  )
  await settled()
  await assertIndependent()
  assert.equal(
    await evaluate(
      page,
      'window.__previewRequests.some(item=>item.url.includes("/api/pi/directories/list"))'
    ),
    false
  )
  if (process.argv.includes('--refresh-only')) {
    await verifyProjectPreviewRefresh({
      page,
      project,
      wait,
      click,
      settled,
      newPage,
      assertIndependent,
      progress,
      capture
    })
    passed = true
    return
  }
  const verifyEntries = async () => {
    await verifyProjectPreviewEntries({
      page,
      baseUrl: `http://127.0.0.1:${port}/`,
      project,
      browserPort,
      output,
      diagnostics: () => serverOutput
    })
    await progress('原预览弹窗、真实新标签入口及原窗口继续使用通过')
  }
  if (browsingFixture) {
    await verifyProjectPreviewBrowsing({
      page,
      project,
      port,
      fixture: browsingFixture,
      wait,
      click,
      textButton,
      input,
      settled,
      capture,
      progress
    })
    passed = true
    return
  }
  if (process.argv.includes('--entries-only')) {
    await verifyEntries()
    await verifyPreviewConnectionLifecycle({ page, port, service })
    await progress('连接替换、重连初始化、双客户端推送与优雅退出通过')
    passed = true
    return
  }
  if (!process.argv.includes('--documents-only')) {
    await click('[data-testid="project-file-hello.ts"]')
    await wait(
      `document.querySelector('[data-testid="code-preview"]')?.textContent.includes('preview-original')`,
      '代码预览'
    )
    await capture('code-dark.png')
    await idle('文件预览')
    await writeFile(join(project, 'hello.ts'), 'export const greeting = "preview-refreshed"\n')
    await evaluate(page, `window.dispatchEvent(new Event('focus'))`)
    await wait(
      `document.querySelector('[data-testid="code-preview"]')?.textContent.includes('preview-refreshed')`,
      '聚焦刷新读取文件变化'
    )
    await writeFile(join(project, 'hello.ts'), 'export const greeting = "preview-manual"\n')
    await click('[aria-label="刷新项目预览"]')
    await wait(
      `document.querySelector('[data-testid="code-preview"]')?.textContent.includes('preview-manual')`,
      '手动刷新读取文件变化'
    )
    assert.equal(
      await evaluate(
        page,
        'window.__previewRequests.some(item=>item.url.includes("project-git-log"))'
      ),
      false
    )
    await textButton('Git 记录')
    await wait(
      'window.__previewRequests.some(item=>item.url.includes("project-git-log")&&item.status===200)',
      '展开Git读取历史'
    )
    await settled()
    await idle('Git预览')
    await capture('git-dark.png')
    await click('[aria-label="收起Git区域"]')
    await click('[data-testid="project-file-README.md"]')
    await wait(
      `document.querySelector('[data-testid="markdown-preview"]')?.textContent.includes('项目预览示例')`,
      'Markdown预览'
    )
    await evaluate(page, `document.documentElement.classList.remove('dark')`)
    await capture('markdown-light.png')
    await setViewport(page, 390, 844, true)
    await capture('markdown-mobile.png')
    assert.equal(await evaluate(page, 'document.documentElement.scrollWidth<=innerWidth'), true)
    await setViewport(page, 1440, 900, false)
    await textButton('切换项目')
    await wait(
      `Boolean(document.querySelector('[data-testid="project-picker"]'))`,
      '切换到项目选择'
    )
    await settled()
    await capture('picker-light.png')
    await idle('项目选择')
    await textButton('浏览目录')
    await wait(
      `document.body.innerText.includes('打开项目') && window.__previewRequests.some(item=>item.url.includes('directory-entries/list')&&item.status===200)`,
      '浏览服务端目录'
    )
    await input('#project-directory', plain)
    await textButton('打开')
    await wait(
      `Boolean(document.querySelector('[data-testid="project-file-plain.txt"]'))`,
      '打开无Git普通目录'
    )
    await click('[data-testid="project-file-plain.txt"]')
    await wait(
      `document.querySelector('[data-testid="code-preview"]')?.textContent.includes('独立普通目录')`,
      '普通目录文件内容'
    )
    await evaluate(page, 'history.back()')
    await wait(
      `Boolean(document.querySelector('[data-testid="project-picker"]'))`,
      '浏览器后退选择页'
    )
    await evaluate(page, 'history.forward()')
    await wait(
      `Boolean(document.querySelector('[data-testid="project-file-plain.txt"]'))`,
      '浏览器前进恢复目录'
    )
    await progress('目录选择、普通目录、导航与共享文档预览通过')
    await go(join(fixtures, 'missing'))
    await wait(`Boolean(document.querySelector('[role="alert"]'))`, '无效目录反馈')
    await idle('读取失败')
    await capture('directory-error.png')
    await textButton('切换项目')
    await wait(
      `Boolean(document.querySelector('[data-testid="project-picker"]'))`,
      '错误后重新选择'
    )
    await go(project)
  } else {
    await writeFile(join(project, 'hello.ts'), 'export const greeting = "preview-refreshed"\n')
    await progress('定向复测：HTML、图片、搜索和页面隔离；不执行前序闲置场景')
  }
  await writeFile(join(project, 'hello.ts'), 'export const greeting = "preview-refreshed"\n')
  await click('[data-testid="project-file-demo.html"]')
  await textButton('预览')
  await wait(`Boolean(document.querySelector('iframe[srcdoc]'))`, 'HTML预览')
  await click('[data-testid="project-file-pixel.png"]')
  await wait(`Boolean(document.querySelector('img[src^="blob:"]'))`, '图片预览')
  await click('[aria-label="搜索项目"]')
  await input('[data-testid="project-file-search"]', 'greeting')
  await wait(
    `Boolean(document.querySelector('[data-testid="project-search-line-hello.ts-1"]'))`,
    '真实文件内容搜索'
  )
  await click('[data-testid="project-search-line-hello.ts-1"]')
  await wait(
    `document.querySelector('[data-testid="code-preview"]')?.textContent.includes('preview-refreshed')`,
    '搜索打开代码'
  )
  await progress('HTML、图片和文件搜索通过')
  await settled()
  await assertIndependent()
  assert.deepEqual(await readdir(join(agentDir, 'sessions')), [], '独立浏览不应创建Pi会话')
  const second = await newPage()
  await navigate(second, `http://127.0.0.1:${port}${href(plain)}`)
  await wait(
    `Boolean(document.querySelector('[data-testid="project-file-plain.txt"]'))`,
    '第二页独立预览',
    second
  )
  await settled(second)
  const firstClient = await evaluate(page, 'window.__previewRequests[0].clientId')
  const secondClient = await evaluate(second, 'window.__previewRequests[0].clientId')
  assert.notEqual(firstClient, secondClient)
  const authenticatedLogin = await fetch(
    `http://127.0.0.1:${port}/login?returnTo=${encodeURIComponent(href(plain))}`,
    {
      redirect: 'manual',
      headers: {
        Cookie: (await page.send('Network.getCookies')).cookies
          .map((c) => `${c.name}=${c.value}`)
          .join('; ')
      }
    }
  )
  assert.equal(authenticatedLogin.status, 302)
  assert.equal(authenticatedLogin.headers.get('location'), href(plain))
  for (const [target, expected] of [
    ['/.//example.test', '/.//example.test'],
    ['/a/..//example.test', '/a/..//example.test'],
    ['/%2e//example.test', '/%2e//example.test'],
    ['/项目 空格?cwd=C%3A%5Cdemo', '/%E9%A1%B9%E7%9B%AE%20%E7%A9%BA%E6%A0%BC?cwd=C%3A%5Cdemo']
  ]) {
    const response = await fetch(
      `http://127.0.0.1:${port}/login?returnTo=${encodeURIComponent(target)}`,
      {
        redirect: 'manual',
        headers: {
          Cookie: (await page.send('Network.getCookies')).cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join('; ')
        }
      }
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), expected)
    assert.equal(
      new URL(response.headers.get('location'), `http://127.0.0.1:${port}`).origin,
      `http://127.0.0.1:${port}`
    )
  }
  await progress('页面身份隔离、无会话副作用和已登录回跳通过')
  if (!process.argv.includes('--documents-only')) await verifyEntries()
  await writeFile(
    join(output, 'requests.json'),
    JSON.stringify(await evaluate(page, 'window.__previewRequests'), null, 2)
  )
  if (!process.argv.includes('--documents-only')) {
    await verifyPreviewConnectionLifecycle({ page, port, service })
    await progress('连接替换、重连初始化、双客户端推送与优雅退出通过')
  }
  passed = true
}

await mkdir(output, { recursive: true })
try {
  await run()
} catch (error) {
  failures.push(error.stack ?? String(error))
  console.error(error)
  if (page) {
    await writeFile(
      join(output, 'diagnostics.json'),
      JSON.stringify(
        await evaluate(
          page,
          '({url:location.href,text:document.body.innerText,requests:window.__previewRequests,errors:window.__previewErrors})'
        ).catch(() => null),
        null,
        2
      )
    )
    await writeFile(join(output, 'failure.png'), await screenshot(page)).catch(() => {})
  }
  process.exitCode = 1
} finally {
  await writeFile(join(output, 'server.log'), serverOutput)
  for (const current of pages) current.close()
  try {
    if (browser) await stopBrowserTree(browser, browserPort)
  } catch (error) {
    failures.push(`浏览器清理：${error}`)
    process.exitCode = 1
  }
  try {
    if (service) await stopE2eServerTree(service)
  } catch (error) {
    failures.push(`服务清理：${error}`)
    process.exitCode = 1
  }
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ passed: passed && !failures.length, checks, failures }, null, 2)
  )
  if (passed && !failures.length) {
    await rm(fixtures, { recursive: true, force: true })
    await rm(agentRoot, { recursive: true, force: true })
    await rm(build, { recursive: true, force: true })
    await rm(join(output, 'browser'), { recursive: true, force: true })
  }
  console.log(`验收记录：${output}`)
}
