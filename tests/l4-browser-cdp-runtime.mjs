import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { terminateManagedTree } from '../src/server/l4_foundation/process/l4-process-tree.js'
import { assertPortReleased } from './l4-e2e-server-runtime.mjs'

const execFileAsync = promisify(execFile)

export function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

export async function reservePort() {
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

export async function waitForHttp(url, timeoutMs, label, diagnostics = () => '') {
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
  throw new Error(`${label}启动超时\n${diagnostics()}`)
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

export async function createCdpPage(cdpPort, url = 'about:blank') {
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

export async function navigate(client, url) {
  const loaded = client.once('Page.loadEventFired')
  await client.send('Page.navigate', { url })
  await loaded
}

export async function evaluate(client, expression) {
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

export async function waitFor(
  client,
  expression,
  label,
  diagnostics = () => '',
  timeoutMs = 20_000
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return
    await delay(100)
  }
  const bodyText = await evaluate(client, `document.body.innerText.slice(0, 6000)`)
  throw new Error(
    `等待页面状态超时：${label}\n--- DOM ---\n${bodyText}\n--- Diagnostics ---\n${diagnostics()}`
  )
}

export async function clickText(client, text) {
  const clicked = await evaluate(
    client,
    `(() => {
      const target = [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')].reverse().find((element) => element.textContent?.trim().includes(${JSON.stringify(text)}));
      if (!target) return false;
      target.click();
      return true;
    })()`
  )
  assert.equal(clicked, true, `未找到按钮：${text}`)
}

export async function clickAriaLabel(client, label) {
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

export async function screenshot(client) {
  await evaluate(
    client,
    `(async () => {
    await document.fonts.ready;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const finiteAnimations = () => document.getAnimations().filter(animation =>
      animation.playState === 'running' && animation.effect &&
      Number.isFinite(animation.effect.getComputedTiming().endTime)
    );
    await frame();
    for (let pass = 0; pass < 8; pass += 1) {
      const animations = finiteAnimations();
      if (animations.length === 0) break;
      await Promise.allSettled(animations.map(animation => animation.finished));
      await frame();
    }
    if (finiteAnimations().length > 0) throw new Error('截图前有限动画未收敛');
    await frame();
  })()`
  )
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  return Buffer.from(result.data, 'base64')
}

export async function setViewport(client, width, height, mobile) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile
  })
}

export async function waitForPortReleased(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
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

export function spawnEdge(edgePath, cdpPort, userDataDir, windowSize = '1440,900', extraArgs = []) {
  return spawn(
    edgePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${windowSize}`,
      ...extraArgs,
      'about:blank'
    ],
    { stdio: 'ignore', windowsHide: true }
  )
}

async function hasProcessForBrowserProfile(browserProcess) {
  const userDataArgument = browserProcess.spawnargs.find((argument) =>
    argument.startsWith('--user-data-dir=')
  )
  if (!userDataArgument) throw new Error('浏览器进程缺少隔离 user-data-dir 参数')
  const profilePath = userDataArgument.slice('--user-data-dir='.length).replaceAll("'", "''")
  const command = [
    "$ProgressPreference = 'SilentlyContinue'",
    `$profile = '${profilePath}'`,
    `$items = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction Stop | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) })`,
    '$active = @($items | Where-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; $p -and -not $p.HasExited })',
    'if ($active.Count -gt 0) { exit 0 } else { exit 1 }'
  ].join('; ')
  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64')
      ],
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 1024 * 1024
      }
    )
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) return false
    throw error
  }
}

async function windowsProcessCommandLine(pid) {
  const command = [
    `$item = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    'if ($item) { [Console]::Out.WriteLine($item.CommandLine) }'
  ].join('; ')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }
  )
  return stdout.trim() || null
}

function isWindowsProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'ESRCH') return false
      if (error.code === 'EPERM') return true
    }
    throw error
  }
}

async function waitForWindowsProcessExit(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isWindowsProcessAlive(pid)) return
    await delay(100)
  }
  throw new Error(`浏览器root PID仍存在，拒绝按旧PPID清理：${pid}`)
}

async function waitForBrowserProfileExit(browserProcess) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (!(await hasProcessForBrowserProfile(browserProcess))) return
    await delay(100)
  }
  assert.fail('Edge隔离profile仍被浏览器子进程占用')
}

export async function stopBrowserTree(browserProcess, cdpPort) {
  if (browserProcess) {
    const exited =
      browserProcess.exitCode !== null || browserProcess.signalCode !== null
        ? Promise.resolve()
        : once(browserProcess, 'exit').catch(() => undefined)

    if (process.platform === 'win32') {
      let terminationError
      try {
        await terminateManagedTree(browserProcess)
      } catch (error) {
        terminationError = error
        const commandLine = await windowsProcessCommandLine(browserProcess.pid).catch(() => null)
        const profileArgument = browserProcess.spawnargs.find((argument) =>
          argument.startsWith('--user-data-dir=')
        )
        const profilePath = profileArgument?.slice('--user-data-dir='.length)
        if (commandLine && profilePath && commandLine.includes(profilePath)) {
          try {
            await terminateManagedTree(browserProcess)
          } catch (retryError) {
            terminationError = new AggregateError(
              [error, retryError],
              'Edge root termination failed'
            )
          }
        }
      }

      await Promise.race([exited, delay(10_000)])
      await waitForWindowsProcessExit(browserProcess.pid)

      if (terminationError) {
        try {
          await terminateManagedTree({ pid: browserProcess.pid, exitCode: 0, signalCode: null })
        } catch (orphanError) {
          if (await hasProcessForBrowserProfile(browserProcess)) {
            terminationError = new AggregateError(
              [terminationError, orphanError].filter(Boolean),
              'Edge orphan cleanup failed'
            )
          }
        }
      }

      try {
        await waitForBrowserProfileExit(browserProcess)
      } catch (profileError) {
        throw new AggregateError(
          [terminationError, profileError].filter(Boolean),
          'Edge process tree cleanup failed'
        )
      }
    } else if (browserProcess.exitCode === null && browserProcess.signalCode === null) {
      browserProcess.kill('SIGKILL')
      await Promise.race([exited, delay(10_000)])
      assert.ok(
        browserProcess.exitCode !== null || browserProcess.signalCode !== null,
        '浏览器root进程未在截止时间内退出'
      )
    }
  }
  if (cdpPort > 0) await waitForPortReleased(cdpPort, 30_000)
}

export async function publishScreenshots(screenshots) {
  for (const [path, content] of screenshots) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}
