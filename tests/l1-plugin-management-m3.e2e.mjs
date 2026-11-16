import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import {
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'
import {
  createCdpPage,
  evaluate,
  navigate,
  reservePort,
  screenshot,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForBrowserReady,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'

// 原先的“所有会话空闲/任意Node Owner存在就等待重启”已由l1-plugin-apply的热更新链路替代。
test('基础服务不导入坏插件，管理UI仍可用且拒绝启用外部能力', { timeout: 240000 }, async () => {
  const projectRoot = resolve('.')
  const runId = `basic-plugin-isolation-${randomUUID()}`
  const root = join(projectRoot, 'temp/pi/l1-plugin-management-m3', runId)
  const agentDir = join(root, 'agent')
  const pluginRoot = join(root, 'must-not-load')
  const marker = join(root, 'plugin-imported.txt')
  const nextDirectory = process.env.PI_PLUGIN_APPLY_E2E_NEXT_DIR
    ? resolve(process.env.PI_PLUGIN_APPLY_E2E_NEXT_DIR)
    : join(projectRoot, 'temp/build/l1-plugin-management-m3', runId, 'next')
  const evidence = join(projectRoot, 'temp/run/plugin-hot-update', runId)
  const clientId = randomUUID()
  const tsconfigBefore = await readFile('tsconfig.json', 'utf8')
  const nextEnvBefore = await readFile('next-env.d.ts', 'utf8')
  let output = ''
  let app
  let browser
  let page
  let cdpPort
  let success = false
  const cleanupErrors = []
  try {
    await prepareIsolatedPiDirectory(agentDir)
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(
      join(pluginRoot, 'package.json'),
      JSON.stringify({ name: 'must-not-load', type: 'module', piDesk: { entry: './entry.mjs' } })
    )
    await writeFile(
      join(pluginRoot, 'entry.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); throw new Error('must not import in basic mode')`
    )
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [pluginRoot] }))
    const port = await reservePort()
    app = spawnE2eServer({
      projectRoot,
      agentDir,
      port,
      development: true,
      managed: true,
      safeMode: true,
      nextDirectory,
      environment: {
        HOME: join(agentDir, 'home'),
        USERPROFILE: join(agentDir, 'home'),
        PI_OFFLINE: '1'
      },
      onOutput: (text) => {
        output += text
      }
    })
    const baseUrl = `http://127.0.0.1:${port}`
    await waitForHttp(`${baseUrl}/api/health`, 120000, '基础服务', () => output.slice(-4000))
    const post = async (path, body) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Pi-Desk-Client-Id': clientId,
          Origin: baseUrl
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      })
      return { response, envelope: await response.json() }
    }
    const list = await post('/api/plugins/list', {})
    assert.equal(list.envelope.code, 0)
    assert.deepEqual(list.envelope.data.plugins, [])
    assert.equal(list.envelope.data.restartRequired, false)
    const denied = await post('/api/plugins/add', { source: pluginRoot })
    assert.equal(denied.response.status, 409)
    assert.equal(existsSync(marker), false)
    await fetch(baseUrl, { signal: AbortSignal.timeout(120000) }).then((response) =>
      response.text()
    )
    cdpPort = await reservePort()
    browser = spawnEdge(
      process.env.PI_DESK_E2E_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      cdpPort,
      join(root, 'edge-profile')
    )
    await waitForBrowserReady(browser, cdpPort)
    page = await createCdpPage(cdpPort)
    await navigate(page, baseUrl)
    await waitFor(
      page,
      `Array.from(document.querySelectorAll('button[aria-label]')).some(button => /settings|设置/i.test(button.getAttribute('aria-label') || ''))`,
      '设置入口'
    )
    await evaluate(
      page,
      `Array.from(document.querySelectorAll('button[aria-label]')).find(button => /settings|设置/i.test(button.getAttribute('aria-label') || '')).click()`
    )
    await waitFor(page, `Boolean(document.querySelector('[role="dialog"]'))`, '设置对话框')
    assert.equal(
      await evaluate(
        page,
        `(() => {
      const button = Array.from(document.querySelectorAll('[role="dialog"] button')).find(item => /^(plugins|插件)$/i.test(item.textContent.trim()));
      if (!button) return false; button.click(); return true;
    })()`
      ),
      true
    )
    await waitFor(
      page,
      `/Basic mode|基础模式/.test(document.body.innerText) && /No plugins found|暂无插件/.test(document.body.innerText)`,
      '基础插件管理提示'
    )
    assert.equal(existsSync(marker), false)
    assert.equal(output.includes('插件能力盘点完成'), false)
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'basic-plugin-management.png'), await screenshot(page))
    success = true
  } catch (error) {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'failure.txt'), error.stack || String(error))
    if (page) await writeFile(join(evidence, 'failure.png'), await screenshot(page)).catch(() => {})
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
    if (app) await clean(() => stopE2eServerTree(app))
    await clean(async () => {
      const markerPath = `${relative(projectRoot, nextDirectory).replaceAll('\\', '/')}/`
      const current = await readFile('tsconfig.json', 'utf8')
      const restored = current
        .split('\n')
        .filter((line) => !line.includes(markerPath))
        .join('\n')
      if (restored !== current) {
        const normalized = restored.replace(/,(\s*[\]}])/g, '$1')
        const original = tsconfigBefore.replace(/,(\s*[\]}])/g, '$1')
        await writeFile(
          'tsconfig.json',
          JSON.stringify(JSON.parse(normalized)) === JSON.stringify(JSON.parse(original))
            ? tsconfigBefore
            : restored
        )
      }
      if ((await readFile('next-env.d.ts', 'utf8')).includes(markerPath))
        await writeFile('next-env.d.ts', nextEnvBefore)
    })
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'server.log'), output)
    await writeFile(join(evidence, 'cleanup.json'), JSON.stringify(cleanupErrors))
    assert.deepEqual(cleanupErrors, [])
    if (success) {
      await rm(root, { recursive: true, force: true })
      if (!process.env.PI_PLUGIN_APPLY_E2E_NEXT_DIR)
        await rm(join(projectRoot, 'temp/build/l1-plugin-management-m3', runId), {
          recursive: true,
          force: true
        })
    }
    console.log(`证据目录：${evidence}`)
  }
})
