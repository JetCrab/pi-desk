import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCdpPage,
  evaluate,
  navigate,
  reservePort,
  setViewport,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'
import {
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const taskId = `composer-resize-${process.pid}`
const runRoot = join(projectRoot, 'temp/run/chat-composer-resize', taskId)
const agentRoot = join(projectRoot, 'temp/pi/chat-composer-resize-e2e', taskId)
const agentDir = join(agentRoot, 'agent')
const buildRoot = join(projectRoot, 'temp/build/chat-composer-resize', taskId)
const workId = 'composer-resize'
let serverOutput = ''
const results = []

async function fixture() {
  await prepareIsolatedPiDirectory(agentDir)
  const cwd = join(agentRoot, 'project')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const session = SessionManager.create(cwd)
  const usage = {
    input: 20,
    output: 40,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 60,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
  let timestamp = Date.now()
  for (let turn = 1; turn <= 5; turn++) {
    session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: `第 ${turn} 轮阅读位置检查。` }],
      timestamp: timestamp++
    })
    session.appendMessage({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: Array.from(
            { length: turn === 5 ? 2 : 12 },
            (_, index) =>
              `第 ${index + 1} 段检查记录。图片移除后，当前阅读的消息应保持稳定，不出现先下移再弹回的跳动。`
          ).join('\n\n')
        }
      ],
      api: 'openai-completions',
      provider: 'fixture',
      model: 'fixture',
      usage,
      stopReason: 'stop',
      timestamp: timestamp++
    })
  }
  session.appendSessionInfo('输入框尺寸变化检查')
  await writeFile(
    join(agentDir, 'pi-desk/work-sessions.json'),
    JSON.stringify({
      workSessions: [{ workId, cwd, sessionId: session.getSessionId() }],
      pinnedCount: 0
    })
  )
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' })
  )
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [
            {
              id: 'fixture',
              name: '本地图片检查',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
}

const installProbe = `(() => {
  window.__measureChat = () => {
    const log = document.querySelector('[role="log"]');
    const scroll = log && [...log.querySelectorAll('div')].find(element =>
      ['auto', 'scroll'].includes(getComputedStyle(element).overflowY));
    const user = scroll && [...scroll.querySelectorAll('[data-chat-user-message]')].at(-1);
    if (!user) return null;
    window.__chatScroll = scroll;
    return {
      top: scroll.scrollTop, height: scroll.scrollHeight, viewport: scroll.clientHeight,
      gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      userTop: user.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
      composer: document.querySelector('textarea').closest('form').getBoundingClientRect().height
    };
  };
  window.__probeFrames = () => {
    const samples = [window.__measureChat()];
    window.__frameSamples = (async () => {
      for (let frame = 0; frame < 24; frame++) {
        // rAF 早于布局和 ResizeObserver；在本帧绘制后的任务中采样可见位置。
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        samples.push(window.__measureChat());
      }
      return samples;
    })();
  };
})()`

async function settle(client) {
  await evaluate(
    client,
    `(async () => {
    await document.fonts.ready;
    let previous = '', stable = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(requestAnimationFrame);
      const measured = window.__measureChat();
      const current = JSON.stringify(measured);
      stable = measured && previous === current ? stable + 1 : 0;
      previous = current;
      if (stable >= 8) return;
    }
    throw new Error('聊天布局未收敛');
  })()`
  )
}

async function pasteImages(client, count) {
  await evaluate(
    client,
    `(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 120; canvas.height = 80;
    const context = canvas.getContext('2d');
    context.fillStyle = '#6b7280'; context.fillRect(0, 0, 120, 80);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const clipboardData = new DataTransfer();
    for (let index = 0; index < ${count}; index++) {
      clipboardData.items.add(new File([blob], '滚动检查-' + index + '.png', { type: 'image/png' }));
    }
    const input = document.querySelector('textarea');
    input.focus({ preventScroll: true });
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  })()`
  )
  await waitFor(
    client,
    `document.querySelector('textarea').closest('form').querySelectorAll('img').length === ${count}`,
    '图片粘贴完成'
  )
  await settle(client)
}

async function removeImage(client, label, index = 0) {
  await evaluate(
    client,
    `(() => {
    const button = document.querySelector('[aria-label="移除 滚动检查-${index}.png"]');
    if (!button) throw new Error('没有找到移除图片按钮');
    window.__probeFrames();
    button.click();
  })()`
  )
  const samples = await evaluate(client, 'window.__frameSamples')
  results.push({ label, samples, events: await evaluate(client, 'window.__scrollLog') })
  const before = samples[0]
  const after = samples.at(-1)
  const movement = Math.max(...samples.map((sample) => Math.abs(sample.userTop - before.userTop)))
  console.log(
    `${label}：最大可见位移 ${movement}px，聊天区高度变化 ${after.viewport - before.viewport}px`
  )
  assert.ok(movement <= 2, `${label}发生消息跳动：${JSON.stringify(samples)}`)
  return { before, after }
}

async function main() {
  let server, browser, client, cdpPort
  let success = false
  try {
    await mkdir(runRoot, { recursive: true })
    await fixture()
    const port = await reservePort()
    cdpPort = await reservePort()
    server = spawnE2eServer({
      projectRoot,
      agentDir,
      port,
      development: true,
      nextDirectory: buildRoot,
      onOutput: (output) => {
        serverOutput += output
      }
    })
    await waitForHttp(`http://127.0.0.1:${port}/api/health`, 60000, 'Pi Desk', () => serverOutput)
    browser = spawnEdge(
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      cdpPort,
      join(runRoot, 'browser'),
      '1200,900'
    )
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20000, 'Edge')
    client = await createCdpPage(cdpPort)
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
      window.__scrollLog = [];
      const original = console.info;
      console.info = (...args) => {
        if (args[0] === '[Pi Desk][ChatScroll]') window.__scrollLog.push(args.slice(1));
        original(...args);
      };
    `
    })
    await navigate(client, `http://127.0.0.1:${port}/login`)
    const login = await evaluate(
      client,
      `fetch('/api/auth/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': crypto.randomUUID() },
      body: JSON.stringify({ password: 'Qq.445566' }) }).then(response => response.json())`
    )
    assert.equal(login.code, 0, login.msg)
    await evaluate(
      client,
      `localStorage.setItem('pi-super:workbench-layout', JSON.stringify({ primaryWorkId: '${workId}' }))`
    )
    for (const viewport of [
      { width: 1200, height: 900, mobile: false },
      { width: 390, height: 844, mobile: true }
    ]) {
      await setViewport(client, viewport.width, viewport.height, viewport.mobile)
      await navigate(client, `http://127.0.0.1:${port}/?chatScrollDebug=1`)
      await waitFor(
        client,
        `document.querySelector('[role="log"]')?.innerText.includes('第 5 轮') && document.querySelector('textarea')?.disabled === false`,
        '聊天内容和输入框就绪',
        () => serverOutput,
        60000
      )
      await evaluate(client, installProbe)
      await settle(client)
      await pasteImages(client, 1)
      const initial = await evaluate(client, 'window.__measureChat()')
      assert.ok(
        initial.top > 100 && initial.gap <= 2 && Math.abs(initial.userTop - 12) <= 2,
        `没有进入短消息尾部留白场景：${JSON.stringify(initial)}`
      )
      const removed = await removeImage(client, `${viewport.width}：移除最后一张图片`)
      assert.ok(removed.after.viewport > removed.before.viewport + 50, '图片栏没有收起')
      assert.ok(removed.after.gap <= 2, '删除图片后没有保持跟底')

      await pasteImages(client, 2)
      const partial = await removeImage(client, `${viewport.width}：两张图片删为一张`)
      assert.equal(partial.before.viewport, partial.after.viewport, '图片栏仍存在时高度不应变化')
      await removeImage(client, `${viewport.width}：再删除剩余图片`, 1)

      await evaluate(client, 'window.__chatScroll.scrollTop -= 250')
      await settle(client)
      await pasteImages(client, 1)
      const reading = await evaluate(client, 'window.__measureChat()')
      assert.ok(reading.gap > 100, '没有进入历史阅读状态')
      await removeImage(client, `${viewport.width}：历史阅读时删除图片`)

      await evaluate(
        client,
        `(() => {
        window.__chatScroll.scrollTop = window.__chatScroll.scrollHeight;
        document.querySelector('textarea').focus({ preventScroll: true });
      })()`
      )
      await settle(client)
      await evaluate(client, 'window.__probeFrames()')
      await client.send('Input.insertText', { text: '输入框高度检查\n'.repeat(6) })
      const growing = await evaluate(client, 'window.__frameSamples')
      results.push({ label: `${viewport.width}：输入框增高`, samples: growing })
      assert.ok(growing.at(-1).viewport < growing[0].viewport - 30, '输入框没有增高')
      assert.ok(
        growing.every((sample) => sample.gap <= 2),
        `输入框增高时没有同步跟底：${JSON.stringify(growing)}`
      )
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
      await evaluate(client, 'window.__probeFrames()')
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8
      })
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8
      })
      const shrinking = await evaluate(client, 'window.__frameSamples')
      results.push({ label: `${viewport.width}：输入框收缩`, samples: shrinking })
      assert.ok(shrinking.at(-1).viewport > shrinking[0].viewport + 30, '输入框没有收缩')
      assert.ok(
        shrinking.every((sample) => Math.abs(sample.userTop - shrinking[0].userTop) <= 2),
        `输入框收缩时消息跳动：${JSON.stringify(shrinking)}`
      )
    }
    success = true
    console.log('图片增删、历史阅读和输入框高度回归通过。')
  } finally {
    await writeFile(join(runRoot, 'measurements.json'), JSON.stringify(results, null, 2))
    await writeFile(join(runRoot, 'server.log'), serverOutput)
    client?.close()
    try {
      await stopBrowserTree(browser, cdpPort)
    } finally {
      if (server) await stopE2eServerTree(server)
    }
    console.log('测试进程树已结束，端口已释放。')
    if (success) {
      await rm(agentRoot, { recursive: true, force: true })
      await rm(buildRoot, { recursive: true, force: true })
      await rm(join(runRoot, 'browser'), { recursive: true, force: true })
    } else {
      console.error(`失败现场：${runRoot}`)
    }
  }
}

await main()
