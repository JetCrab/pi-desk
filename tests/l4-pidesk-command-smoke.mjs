import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'

const execute = promisify(execFile)
const packageName = 'pidesk-command-fixture'

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
  throw new Error(`等待超时：${label}\n${diagnostics()}`)
}

function extension(version) {
  return `export default function (pi) {
    pi.registerTool({ name: 'pidesk_command_fixture', label: 'Fixture', description: 'fixture-${version}',
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text', text: '${version}' }] } }
    })
  }\n`
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
            function: { name: 'pidesk', arguments: JSON.stringify({ args: call.args }) }
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
  const archives = new Map()
  const versions = {}
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
    const archive = archives.get(path)
    if (archive) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      response.end(archive)
    } else if (path === `/${packageName}`) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({ name: packageName, 'dist-tags': { latest: '2.0.0' }, versions })
      )
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: '测试包或版本不存在' }))
    }
  })
  await mkdir(agentDir, { recursive: true })
  await mkdir(root, { recursive: true })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const fixturePort = server.address().port
  const registry = `http://127.0.0.1:${fixturePort}`
  try {
    for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
      const directory = join(root, 'packages', version, 'package')
      await mkdir(join(directory, 'browser/chunks'), { recursive: true })
      const manifest = {
        name: packageName,
        version,
        type: 'module',
        pi: { extensions: ['./index.mjs'] },
        piDesk: { entry: './pi-desk.mjs' }
      }
      await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
      await writeFile(join(directory, 'index.mjs'), extension(version))
      await writeFile(
        join(directory, 'pi-desk.mjs'),
        version === '3.0.0'
          ? `export default { name: '${packageName}', setup() { throw new Error('候选插件初始化失败') } }\n`
          : `export default { name: '${packageName}', setup(plugin) { plugin.registerBrowserEntry('./browser/entry.js') } }\n`
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
          root.render(createElement('div', { 'data-testid': 'pidesk-command-fixture' }, createElement(PluginButton, null, '${version}'), createElement(PluginMarkdown, { content: '命令模块 ${version}' })))
          return () => root.unmount()
        } }\n`
      )
      const archive = join(root, 'packages', `${version}.tgz`)
      await execute(
        process.platform === 'win32' ? 'tar.exe' : 'tar',
        ['-czf', basename(archive), '-C', dirname(directory), 'package'],
        { cwd: dirname(archive), timeout: 10_000, windowsHide: true }
      )
      const bytes = await readFile(archive)
      const path = `/${packageName}/-/${version}.tgz`
      archives.set(path, bytes)
      versions[version] = {
        ...manifest,
        dist: {
          tarball: `${registry}${path}`,
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
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
      join(agentDir, 'pi-desk-plugins.json'),
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
            rejectResponse(new Error(`请求超时：${path}`))
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
        await once(socket, 'open')
        await request('work-sessions/list', {})
        const added = await fetch(`${baseUrl}/api/work-sessions/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
          body: JSON.stringify({ cwd: workspace })
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
        const invoke = async (args, failure) => {
          await idle()
          const id = randomUUID()
          activeCall = { id, args, marker: `pidesk-smoke:${id}`, sent: false }
          console.info(`[smoke:pidesk] ${args.join(' ')}`)
          await request('chat/send', { source, mode: 'auto', text: activeCall.marker, images: [] })
          await waitFor(
            () => {
              if (providerError) throw providerError
              return activeCall.result !== undefined
            },
            '真实 pidesk 工具结果',
            () => JSON.stringify(activeCall)
          )
          const result = activeCall.result
          let output
          try {
            output = JSON.parse(result)
          } catch (error) {
            if (!failure) throw error
            assert.match(result, failure)
            transcript.push({ args, error: result })
            return
          }
          assert.ok(['sync', 'async'].includes(output.mode), result)
          if (output.mode === 'async') {
            await waitFor(
              () => activeCall.notice !== undefined,
              '命令最终完成通知',
              () => JSON.stringify(activeCall),
              90_000
            )
            if (failure) assert.match(activeCall.notice, failure)
            else assert.doesNotMatch(activeCall.notice, /结果：失败|配置重载失败|尚未生效/)
          } else if (failure) {
            assert.fail(`失败命令不能返回同步成功：${args.join(' ')}`)
          }
          transcript.push({ args, output, notice: activeCall.notice })
          return output.message
        }
        const listed = async () => JSON.parse(await invoke(['plugins', 'list']))
        const installed = join(agentDir, 'npm/node_modules', packageName)
        const installedVersion = async (expected) => {
          assert.equal(
            JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version,
            expected
          )
          const tools = await request('pi/tools/list', { source })
          assert.equal(
            tools.tools.find((tool) => tool.name === 'pidesk_command_fixture')?.description,
            `fixture-${expected}`
          )
        }
        assert.match(await invoke(['--help']), /plugins install/)
        assert.equal(await invoke(['--version']), version)
        const info = JSON.parse(await invoke(['info']))
        assert.equal(info.mode, 'normal')
        assert.equal(info.agentDir, agentDir)
        assert.deepEqual((await listed()).plugins, [])
        await invoke(['plugins', 'install', packageName, '--scope', 'global', '--version', '1.0.0'])
        await installedVersion('1.0.0')
        const detail = JSON.parse(
          await invoke(['plugins', 'show', packageName, '--scope', 'global'])
        )
        assert.equal(detail.version, '1.0.0')
        assert.ok(detail.detail.tools.some((tool) => tool.name === 'pidesk_command_fixture'))
        await verifyBrowserModules({
          root,
          baseUrl,
          entry: (await request('plugins/browser-entries/list', {})).entries.find(
            (item) => item.pluginName === packageName
          ),
          version: '1.0.0'
        })
        await writeFile(join(installed, 'index.mjs'), 'export default () => {}\n')
        await invoke(['plugins', 'install', packageName, '--scope', 'global', '--version', '1.0.0'])
        assert.equal(await readFile(join(installed, 'index.mjs'), 'utf8'), extension('1.0.0'))
        await installedVersion('1.0.0')
        await invoke(['plugins', 'install', packageName, '--scope', 'global'])
        await installedVersion('2.0.0')
        await invoke(
          ['plugins', 'install', packageName, '--scope', 'global', '--version', '9.0.0'],
          /不存在|失败/
        )
        await installedVersion('2.0.0')
        await invoke(
          ['plugins', 'install', packageName, '--scope', 'global', '--version', '3.0.0'],
          /候选插件初始化失败/
        )
        await installedVersion('2.0.0')
        await invoke(['plugins', 'install', packageName, '--scope', 'global', '--version', '1.0.0'])
        await installedVersion('1.0.0')
        const before = (await request('work-sessions/list', {})).workSessions.find(
          (item) => item.workId === workId
        )
        await invoke(['session', 'reload'])
        assert.match(activeCall.notice, /已重载完成/)
        const after = (await request('work-sessions/list', {})).workSessions.find(
          (item) => item.workId === workId
        )
        assert.equal(after.sessionId, before.sessionId)
        assert.equal(after.branchId, before.branchId)
        assert.ok(after.messageCounts.total > before.messageCounts.total)
        await invoke(['plugins', 'remove', packageName, '--scope', 'global'])
        assert.ok(!(await listed()).plugins.some((item) => item.name === packageName))
        assert.ok(
          !(await request('pi/tools/list', { source })).tools.some(
            (tool) => tool.name === 'pidesk_command_fixture'
          )
        )
        await invoke(['plugins', 'show', packageName, '--scope', 'global'], /插件不存在/)
        const localName = 'pidesk-local-fixture'
        const local = join(agentDir, 'extensions', localName)
        await mkdir(local, { recursive: true })
        await writeFile(join(local, 'index.ts'), extension('local-one'))
        await invoke(['plugins', 'install', localName, '--scope', 'global'])
        assert.match(activeCall.notice, /服务与界面已更新/)
        assert.ok(
          !(await request('pi/tools/list', { source })).tools.some(
            (tool) => tool.name === 'pidesk_command_fixture'
          )
        )
        await invoke(['session', 'reload'])
        assert.equal(
          (await request('pi/tools/list', { source })).tools.find(
            (tool) => tool.name === 'pidesk_command_fixture'
          )?.description,
          'fixture-local-one'
        )
        await writeFile(join(local, 'index.ts'), extension('local-two'))
        await invoke(['plugins', 'install', localName, '--scope', 'global'])
        assert.equal(
          (await request('pi/tools/list', { source })).tools.find(
            (tool) => tool.name === 'pidesk_command_fixture'
          )?.description,
          'fixture-local-one'
        )
        await invoke(['session', 'reload'])
        assert.equal(
          (await request('pi/tools/list', { source })).tools.find(
            (tool) => tool.name === 'pidesk_command_fixture'
          )?.description,
          'fixture-local-two'
        )
        await invoke(['plugins', 'remove', localName, '--scope', 'global'], /不支持卸载裸扩展/)
        const broken = join(agentDir, 'extensions', 'broken-fixture')
        await mkdir(broken, { recursive: true })
        await writeFile(join(broken, 'package.json'), '{')
        assert.ok(
          (await listed()).plugins.some((item) => item.name === 'broken-fixture' && item.error)
        )
        assert.equal(
          JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')).defaultProvider,
          'pidesk-smoke'
        )
        assert.equal(await invoke(['--version']), version)
        await idle()
        console.info('[smoke:pidesk] 安装、查询、更新、失败保留、重载和卸载验收通过')
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

async function verifyBrowserModules({ root, baseUrl, entry, version }) {
  assert.ok(entry, '安装后的插件必须提供 Browser Entry')
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  const executable = candidates.find(existsSync)
  assert.ok(executable, '命令验收需要已安装的 Edge 或 Chromium')
  const cdpPort = await reservePort()
  const browser = spawnEdge(
    executable,
    cdpPort,
    join(root, 'browser'),
    '1024,768',
    process.platform === 'win32' ? [] : ['--no-sandbox']
  )
  let client
  try {
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, '验收浏览器')
    client = await createCdpPage(cdpPort)
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
    console.info('[smoke:pidesk] Browser Entry、Lazy Module、base/markdown 和挂载验收通过')
  } finally {
    client?.close()
    await stopBrowserTree(browser, cdpPort)
  }
}
