import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { assertPortReleased } from './l4-e2e-server-runtime.mjs'
import {
  createCdpPage,
  evaluate,
  navigate,
  reservePort,
  spawnEdge,
  stopBrowserTree,
  waitForBrowserReady
} from './l4-browser-cdp-runtime.mjs'

const execute = promisify(execFile)
const packageName = 'pidesk-command-fixture'
const pluginVersion = '1.0.0'

function text(content) {
  return typeof content === 'string'
    ? content
    : (content ?? []).map((part) => part.text ?? '').join('\n')
}

async function waitFor(check, label, diagnostics = () => '', timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(100)
  }
  throw Object.assign(new Error(`等待超时：${label}\n${diagnostics()}`), { code: 'ETIMEDOUT' })
}

function respond(response, call) {
  const base = {
    id: randomUUID(),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fixture'
  }
  const delta = call
    ? {
        tool_calls: [
          {
            index: 0,
            id: call.id,
            type: 'function',
            function: { name: call.tool, arguments: JSON.stringify(call.parameters) }
          }
        ]
      }
    : { content: '命令验收已完成。' }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const chunk of [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }
  ])
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.end('data: [DONE]\n\n')
}

export async function createPiDeskCommandFixture(root, agentDir) {
  let archive
  let metadata
  let activeCall
  let providerError
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '').split('?')[0])
    if (request.method === 'POST' && path === '/v1/chat/completions') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        try {
          const messages = JSON.parse(body).messages
          let call
          if (activeCall) {
            const marker = messages.findIndex(
              (message) => text(message.content) === activeCall.marker
            )
            for (const message of messages.slice(marker + 1)) {
              if (message.role === 'tool' && message.tool_call_id === activeCall.id)
                activeCall.result = text(message.content)
              const content = text(message.content)
              if (
                message.role !== 'tool' &&
                /Pi Desk 命令执行结果|当前窗口的 Pi 配置.*重载/.test(content)
              )
                activeCall.notice = content
            }
            if (marker >= 0 && !activeCall.sent) {
              activeCall.sent = true
              call = activeCall
            }
          }
          respond(response, call)
        } catch (error) {
          providerError = error
          response.writeHead(500)
          response.end(String(error))
        }
      })
      return
    }
    if (path === `/${packageName}/-/${pluginVersion}.tgz`) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      response.end(archive)
    } else if (path === `/${packageName}`) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(metadata))
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: '测试包或版本不存在' }))
    }
  })
  await mkdir(join(agentDir, 'config'), { recursive: true })
  await mkdir(root, { recursive: true })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const fixturePort = server.address().port
  const registry = `http://127.0.0.1:${fixturePort}`
  try {
    const directory = join(root, 'packages', 'package')
    await mkdir(join(directory, 'browser/chunks'), { recursive: true })
    const manifest = {
      name: packageName,
      version: pluginVersion,
      type: 'module',
      pi: { extensions: ['./index.mjs'] },
      piDesk: { entry: './pi-desk.mjs' }
    }
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
    await writeFile(
      join(directory, 'index.mjs'),
      `export default function (pi) {
        pi.registerTool({ name: 'pidesk_command_fixture', label: 'Fixture', description: '安装态测试工具',
          parameters: { type: 'object', properties: {} },
          async execute() { return { content: [{ type: 'text', text: '${pluginVersion}' }] } }
        })
      }\n`
    )
    await writeFile(
      join(directory, 'pi-desk.mjs'),
      `export default { name: '${packageName}', setup(plugin) { plugin.registerBrowserEntry('./browser/entry.js') } }\n`
    )
    await writeFile(
      join(directory, 'browser/entry.js'),
      `export default function (plugin) {
        plugin.registerContribution('settings-page', 'command-check', { label: '命令验收', icon: { type: 'builtin', name: 'settings' }, load: () => import('./chunks/view.js').then(module => module.default) })
      }\n`
    )
    await writeFile(
      join(directory, 'browser/chunks/view.js'),
      `import { createElement, createRoot, PluginButton } from '@jetcrab/pi-desk-sdk/react/base'
      import { PluginMarkdown } from '@jetcrab/pi-desk-sdk/react/markdown'
      export default { mount({ container }) {
        const root = createRoot(container, { onUncaughtError(error) { container.dataset.mountError = error.message } })
        root.render(createElement('div', { 'data-testid': 'pidesk-command-fixture' }, createElement(PluginButton, null, '${pluginVersion}'), createElement(PluginMarkdown, { content: '命令模块 ${pluginVersion}' })))
        return () => root.unmount()
      } }\n`
    )
    const archivePath = join(root, 'packages', `${pluginVersion}.tgz`)
    await execute(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-czf', basename(archivePath), '-C', dirname(directory), 'package'],
      { cwd: dirname(archivePath), timeout: 10_000, windowsHide: true }
    )
    archive = await readFile(archivePath)
    metadata = {
      name: packageName,
      'dist-tags': { latest: pluginVersion },
      versions: {
        [pluginVersion]: {
          ...manifest,
          dist: {
            tarball: `${registry}/${packageName}/-/${pluginVersion}.tgz`,
            integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`
          }
        }
      }
    }
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        packages: [],
        defaultProvider: 'pidesk-smoke',
        defaultModel: 'fixture',
        defaultThinkingLevel: 'off',
        retry: { enabled: false },
        compaction: { enabled: false }
      })
    )
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'pidesk-smoke': {
            baseUrl: `${registry}/v1`,
            api: 'openai-completions',
            apiKey: 'fixture',
            models: [
              {
                id: 'fixture',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_000_000,
                maxTokens: 512
              }
            ]
          }
        }
      })
    )
    await writeFile(
      join(agentDir, 'config', 'pi-desk-plugins.json'),
      JSON.stringify({ downloadSource: { mode: 'custom', registry } })
    )
  } catch (error) {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    throw error
  }

  return {
    async verify({ port, version }) {
      const baseUrl = `http://127.0.0.1:${port}`
      const clientId = randomUUID()
      const workspace = join(root, 'project')
      await mkdir(workspace, { recursive: true })
      const socket = new WebSocket(
        `${baseUrl.replace('http', 'ws')}/api/ws?clientId=${clientId}`,
        'pi-desk.v1'
      )
      const pending = new Map()
      socket.on('error', () => undefined)
      const request = (path, body) =>
        new Promise((resolveResponse, rejectResponse) => {
          const id = randomUUID()
          const timer = setTimeout(() => {
            pending.delete(id)
            rejectResponse(Object.assign(new Error(`请求超时：${path}`), { code: 'ETIMEDOUT' }))
          }, 30_000)
          pending.set(id, { timer, resolve: resolveResponse, reject: rejectResponse })
          socket.send(JSON.stringify({ head: { op: 'req', path, requestId: id }, body }))
        })
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString())
        if (message.head.op !== 'resp') return
        const item = pending.get(message.head.requestId)
        if (!item) return
        pending.delete(message.head.requestId)
        clearTimeout(item.timer)
        if (message.body.code === 0) item.resolve(message.body.data)
        else item.reject(new Error(message.body.msg))
      })
      const transcript = []
      try {
        await once(socket, 'open', { signal: AbortSignal.timeout(30_000) })
        await request('work-sessions/list', {})
        const added = await fetch(`${baseUrl}/api/work-sessions/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
          body: JSON.stringify({ cwd: workspace }),
          signal: AbortSignal.timeout(30_000)
        }).then((response) => response.json())
        assert.equal(added.code, 0, added.msg)
        const { workId, sessionId, branchId } = added.data.workSession
        const source = { workId, sessionId, branchId }
        assert.ok(
          (await request('pi/tools/list', { source })).tools.some((tool) => tool.name === 'pidesk')
        )
        await request('chat/subscribe', { subscriptions: [{ source, cursor: null }] })
        const idle = () =>
          waitFor(async () => {
            const current = (await request('work-sessions/list', {})).workSessions.find(
              (item) => item.workId === workId
            )
            return ['completed', 'idle'].includes(current?.status)
          }, '命令会话空闲')
        const callTool = async (tool, parameters) => {
          await idle()
          const id = randomUUID()
          activeCall = { id, tool, parameters, marker: `pidesk-smoke:${id}`, sent: false }
          console.info(`[smoke:tool] ${tool} ${JSON.stringify(parameters)}`)
          await request('chat/send', { source, mode: 'auto', text: activeCall.marker, images: [] })
          await waitFor(
            () => {
              if (providerError) throw providerError
              return activeCall.result !== undefined
            },
            `真实工具结果：${tool}`,
            () => JSON.stringify(activeCall)
          )
          transcript.push({ tool, parameters, result: activeCall.result })
          return activeCall.result
        }
        const invoke = async (args) => {
          const result = await callTool('pidesk', { args })
          const output = JSON.parse(result)
          assert.ok(['sync', 'async'].includes(output.mode), result)
          if (output.mode === 'async') {
            await waitFor(
              () => activeCall.notice !== undefined,
              '命令最终完成通知',
              () => JSON.stringify(activeCall),
              90_000
            )
            transcript.push({ args, notice: activeCall.notice })
          }
          return output.message
        }
        const listed = async () => JSON.parse(await invoke(['plugins', 'list']))
        const installed = join(agentDir, 'npm/node_modules', packageName)
        assert.equal(await invoke(['--version']), version)
        await invoke(['plugins', 'install', packageName, '--scope', 'global'])
        assert.equal(
          JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version,
          pluginVersion
        )
        assert.ok((await listed()).plugins.some((item) => item.name === packageName))
        await invoke(['session', 'reload'])
        assert.ok(
          (await request('pi/tools/list', { source })).tools.some(
            (tool) => tool.name === 'pidesk_command_fixture'
          )
        )
        assert.equal(await callTool('pidesk_command_fixture', {}), pluginVersion)
        await verifyBrowserModules({
          root,
          baseUrl,
          entry: (await request('plugins/browser-entries/list', {})).entries.find(
            (item) => item.pluginName === packageName
          ),
          version: pluginVersion
        })
        await invoke(['plugins', 'remove', packageName, '--scope', 'global'])
        await assert.rejects(access(installed), { code: 'ENOENT' })
        assert.ok(!(await listed()).plugins.some((item) => item.name === packageName))
        assert.ok(
          !(await request('plugins/browser-entries/list', {})).entries.some(
            (item) => item.pluginName === packageName
          )
        )
        await invoke(['session', 'reload'])
        assert.ok(
          !(await request('pi/tools/list', { source })).tools.some(
            (tool) => tool.name === 'pidesk_command_fixture'
          )
        )
        await idle()
        console.info('[smoke:pidesk] 插件安装、加载、工具调用、浏览器挂载和卸载验收通过')
      } finally {
        activeCall = undefined
        for (const item of pending.values()) {
          clearTimeout(item.timer)
          item.reject(new Error('验收已结束'))
        }
        pending.clear()
        socket.terminate()
        await writeFile(join(root, 'commands.json'), JSON.stringify(transcript, null, 2))
      }
    },
    async close() {
      server.closeAllConnections()
      await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())))
      await assertPortReleased(fixturePort)
    }
  }
}

export async function verifyBrowserModules({ root, baseUrl, entry, version }) {
  assert.ok(entry, '安装后的插件必须提供 Browser Entry')
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  const executables = candidates.filter(existsSync)
  assert.ok(executables.length, '命令验收需要已安装的 Edge 或 Chromium')
  for (let attempt = 1; attempt <= 2; attempt++) {
    const executable = executables[Math.min(attempt - 1, executables.length - 1)]
    try {
      await verifyBrowserAttempt({ root, baseUrl, entry, version, executable, attempt })
      return
    } catch (error) {
      if (attempt === 2 || error.code !== 'ETIMEDOUT') throw error
      console.warn('[smoke:browser] 浏览器暂时无响应；已释放旧实例，重启浏览器继续当前验收')
    }
  }
}

async function verifyBrowserAttempt({ root, baseUrl, entry, version, executable, attempt }) {
  const cdpPort = await reservePort()
  const browser = spawnEdge(
    executable,
    cdpPort,
    join(root, `browser-${attempt}`),
    '1024,768',
    process.platform === 'win32' ? [] : ['--no-sandbox']
  )
  let client
  let timer
  try {
    await Promise.race([
      (async () => {
        try {
          const diagnostics = await waitForBrowserReady(browser, cdpPort)
          await writeFile(join(root, `browser-startup-${attempt}.log`), `${diagnostics}\n`)
        } catch (error) {
          await writeFile(join(root, `browser-startup-${attempt}.log`), `${error.stack ?? error}\n`)
          if (/验收浏览器启动超时|验收浏览器在就绪前退出/.test(error.message))
            error.code = 'ETIMEDOUT'
          throw error
        }
        client = await createCdpPage(cdpPort)
        console.info(`[smoke:browser] 第 ${attempt} 次浏览器验收：加载页面`)
        await navigate(client, baseUrl)
        const result = await evaluate(
          client,
          `(async () => {
      const entry = await import(${JSON.stringify(entry.url)})
      let definition
      entry.default({ registerContribution(kind, name, contribution) { definition = contribution } })
      const implementation = await definition.load()
      const container = document.createElement('div')
      document.body.append(container)
      const controller = new AbortController()
      const dispose = await implementation.mount({ container, target: { kind: 'settings-page', close() {}, setBeforeLeave() {} }, signal: controller.signal })
      try {
        const deadline = Date.now() + 10000
        while (!container.textContent.includes(${JSON.stringify(`命令模块 ${version}`)})) {
          if (container.dataset.mountError) throw new Error(container.dataset.mountError)
          if (Date.now() >= deadline) throw new Error('浏览器模块挂载超时：' + container.textContent)
          await new Promise(done => requestAnimationFrame(done))
        }
        return container.textContent
      } finally { controller.abort(); await dispose?.(); container.remove() }
    })()`
        )
        assert.ok(result.includes(`命令模块 ${version}`))
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error('浏览器页面或 CDP 在 45 秒内未完成验收'), {
                code: 'ETIMEDOUT'
              })
            ),
          45_000
        )
      })
    ])
    console.info('[smoke:pidesk] Browser Entry、Lazy Module、base/markdown 和挂载验收通过')
  } finally {
    clearTimeout(timer)
    client?.close()
    await stopBrowserTree(browser, cdpPort).catch((error) => {
      console.warn(`验收浏览器收尾未完成：pid=${browser.pid}，port=${cdpPort}；${error.message}`)
    })
  }
}
