import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import { assertPortReleased } from '../l4-e2e-server-runtime.mjs'
import { evaluate, navigate, screenshot, waitFor } from '../l4-browser-cdp-runtime.mjs'

function withTimeout(promise, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时`)), 15_000)
    })
  ]).finally(() => clearTimeout(timer))
}

export async function verifyPreviewConnectionLifecycle({ page, port, service }) {
  const cookies = (await page.send('Network.getCookies')).cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ')
  const sockets = []
  const connect = async (clientId) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/ws?clientId=${clientId}`,
      'pi-desk.v1',
      { headers: { Cookie: cookies } }
    )
    sockets.push(socket)
    await withTimeout(once(socket, 'open'), '连接')
    return socket
  }
  const receive = (socket, predicate) => {
    let listener
    const promise = new Promise((resolve) => {
      listener = (bytes) => {
        const message = JSON.parse(bytes.toString())
        if (predicate(message)) resolve(message)
      }
      socket.on('message', listener)
    })
    return withTimeout(promise, '消息').finally(() => socket.off('message', listener))
  }
  const request = async (socket, path, body = {}) => {
    const requestId = randomUUID()
    const result = receive(
      socket,
      (message) => message.head?.op === 'resp' && message.head.requestId === requestId
    )
    socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
    return (await result).body
  }
  try {
    const id = randomUUID()
    const original = await connect(id)
    const originalList = await request(original, 'work-sessions/list')
    assert.equal(originalList.code, 0)
    const session = originalList.data.workSessions[0]
    assert.ok(session)
    const source = {
      workId: session.workId,
      sessionId: session.sessionId,
      branchId: session.branchId
    }
    const closed = once(original, 'close')
    const current = await connect(id)
    assert.equal((await withTimeout(closed, '旧连接关闭'))[0], 4001)
    assert.equal(
      (await request(current, 'chat/subscribe', { subscriptions: [{ source, cursor: null }] }))
        .code,
      409
    )
    const currentList = await request(current, 'work-sessions/list')
    assert.equal(currentList.code, 0, '旧close不能清除新连接')
    const observer = await connect(randomUUID())
    assert.equal((await request(observer, 'work-sessions/list')).code, 0)
    const updated = [current, observer].map((socket) =>
      receive(socket, (message) => message.head?.path === 'work-sessions/update')
    )
    const response = await fetch(`http://127.0.0.1:${port}/api/work-sessions/sort`, {
      method: 'POST',
      headers: { Cookie: cookies, 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': id },
      body: JSON.stringify({
        workIds: currentList.data.workSessions.map((item) => item.workId),
        pinnedCount: currentList.data.pinnedCount === 0 ? 1 : 0
      })
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).code, 0)
    const pushes = await Promise.all(updated)
    assert.deepEqual(pushes[0].body, pushes[1].body, '两个客户端收到同一权威列表变化')
    const disconnected = once(current, 'close')
    current.close()
    await withTimeout(disconnected, '主动断线')
    const reconnected = await connect(id)
    assert.equal(
      (await request(reconnected, 'chat/subscribe', { subscriptions: [{ source, cursor: null }] }))
        .code,
      409
    )
    assert.equal((await request(reconnected, 'work-sessions/list')).code, 0)
    const shutdownCloses = [reconnected, observer].map((socket) => once(socket, 'close'))
    service.child.send('pi-desk.shutdown')
    for (const close of shutdownCloses)
      assert.equal((await withTimeout(close, '优雅关闭连接'))[0], 1001)
    const [code, signal] = await withTimeout(service.exit, '服务退出')
    assert.equal(code, 0)
    assert.equal(signal, null)
    await assertPortReleased(port)
  } finally {
    for (const socket of sockets) socket.terminate()
  }
}

export async function verifyProjectPreviewEntries({
  page,
  baseUrl,
  project,
  browserPort,
  output,
  diagnostics
}) {
  const clientId = '541e6a7e-d27b-45f2-a19b-b7cf9cbf33ac'
  console.log('[入口验收] 创建隔离工作会话')
  const created = await evaluate(
    page,
    `fetch('/api/work-sessions/add', {
    method:'POST', signal:AbortSignal.timeout(60_000), headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':${JSON.stringify(clientId)}},
    body:JSON.stringify({cwd:${JSON.stringify(project)}})
  }).then(response=>response.json())`
  )
  assert.equal(created.code, 0, JSON.stringify(created))
  const wait = (expression, label) => waitFor(page, expression, label, diagnostics, 90_000)
  const click = async (selector) => {
    await wait(
      `Boolean([...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getClientRects().length&&!el.disabled))`,
      selector
    )
    await evaluate(
      page,
      `([...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getClientRects().length&&!el.disabled)).click()`
    )
  }
  console.log('[入口验收] 工作会话已创建，进入工作台')
  await navigate(page, baseUrl)
  await wait(
    `Boolean(document.querySelector('[data-testid^="work-session-row-"]'))`,
    '工作会话列表'
  )
  await click('[data-testid^="work-session-row-"]')
  await click('[data-testid="sidebar-mode-files"]')
  await wait(
    `Boolean(document.querySelector('[data-testid="project-file-README.md"]'))`,
    '项目文件区'
  )
  await click('[data-testid="project-preview-open"]')
  await wait(
    `Boolean(document.querySelector('[data-testid="project-preview-dialog"]'))`,
    '原项目预览仍打开弹窗'
  )
  await click('[data-testid="project-preview-dialog"] [data-testid="project-file-README.md"]')
  await wait(
    `document.querySelector('[data-testid="project-preview-dialog"] [data-testid="markdown-preview"]')?.textContent.includes('项目预览示例')`,
    '弹窗复用Markdown预览'
  )
  await evaluate(
    page,
    `document.querySelectorAll('nextjs-portal').forEach(element=>element.style.setProperty('display','none','important'))`
  )
  await writeFile(join(output, 'original-dialog.png'), await screenshot(page))
  await wait('window.__previewPending===0', '弹窗读取完成')
  const beforeFocus = await evaluate(page, 'window.__previewRequests.length')
  // 等待原文档聚焦刷新的1秒节流窗口，不用于判断页面加载完成。
  await new Promise((done) => setTimeout(done, 1100))
  await evaluate(page, `window.dispatchEvent(new Event('focus'))`)
  await wait(
    `window.__previewRequests.length>${beforeFocus} && window.__previewPending===0`,
    '原弹窗激活刷新保持可用'
  )
  await click('[aria-label="关闭项目预览"]')
  await wait(`!document.querySelector('[data-testid="project-preview-dialog"]')`, '关闭原弹窗')
  const listTargets = async () => (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json()
  const before = new Set((await listTargets()).map((item) => item.id))
  const expression = `(() => {
    const button=document.querySelector('[data-testid="project-preview-window-open"]');
    if(!button || !button.getClientRects().length || button.disabled) return null;
    const rect=button.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  })()`
  await wait(`Boolean(${expression})`, '独立打开操作')
  const point = await evaluate(page, expression)
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...point
  })
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...point
  })
  const deadline = Date.now() + 30_000
  let opened
  while (Date.now() < deadline) {
    opened = (await listTargets()).find(
      (item) => !before.has(item.id) && new URL(item.url).pathname === '/project-preview'
    )
    if (opened) break
    await new Promise((done) => setTimeout(done, 100))
  }
  assert.ok(opened, '点击应创建真实浏览器新标签')
  assert.equal(new URL(opened.url).searchParams.get('cwd'), project)
  assert.equal(await evaluate(page, 'location.pathname'), '/')
  assert.equal(
    await evaluate(
      page,
      `Boolean(document.querySelector('[data-testid="project-preview-dialog"]'))`
    ),
    false
  )
  await fetch(`http://127.0.0.1:${browserPort}/json/close/${opened.id}`)
  await click('[data-testid="project-preview-open"]')
  await wait(
    `document.querySelector('[data-testid="project-preview-dialog"] [data-testid="markdown-preview"]')?.textContent.includes('项目预览示例')`,
    '新标签关闭后原入口及浏览位置仍可恢复'
  )
  await click('[aria-label="关闭项目预览"]')
}
