import { createRoot, type Root } from 'react-dom/client'
import { DesktopApp } from '../web/l1-desktop-app'
import { DesktopConfirmProvider, useDesktopConfirm } from '../web/l4-desktop-confirm'
import type { ControlState, ServerConfig, TargetConfig } from '../web/l4-desktop-ipc'

import type { Call, Result } from './l4-desktop-test'

const localUrl = 'http://127.0.0.1:43001/'
const remoteUrl = 'https://remote.example.test/'
const secondRemoteUrl = 'https://second.example.test/'
const settingsHash = `#/settings/target?url=${encodeURIComponent(localUrl)}`
const defaultServer: ServerConfig = {
  startCommand: 'node_modules/.bin/pi-desk start -p {port}',
  readyPath: '/api/health',
  package: {
    name: '@jetcrab/pi-desk',
    startupUpdate: 'check',
    periodicUpdate: 'none',
    channel: 'stable'
  }
}
let state: ControlState
let target: TargetConfig
let calls: Call[] = []
let root: Root | null = null
const listeners = new Set<() => void>()
const results: Result[] = []
let clipboard = ''
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    async writeText(value: string): Promise<void> {
      clipboard = value
    }
  }
})

window.__desktopTest = {
  results,
  current: '',
  done: false,
  async invoke(command, args = {}): Promise<unknown> {
    calls.push({ command, args })
    if (command === 'get_control_state') return structuredClone(state)
    if (command === 'get_target_settings') {
      return {
        target: args.url === localUrl ? target : { url: args.url, server: null },
        defaultServer
      }
    }
    if (command === 'get_environment_download_source') return { mode: 'official' }
    if (command === 'get_tunnel_connection') {
      return { controlServerUrl: 'http://tunnel.example.test:7001', controlKey: 'ab'.repeat(32) }
    }
    return undefined
  },
  async listen(_name, listener): Promise<() => void> {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

function fixtureState(): ControlState {
  return {
    hideOnStartup: false,
    hideOnOpen: true,
    showOnClose: true,
    targets: [
      {
        url: localUrl,
        server: {
          status: 'running',
          detail: '',
          version: '1.1.0',
          autoStart: true,
          needsSetup: false,
          update: { status: 'available', version: '1.1.1', error: null }
        }
      },
      { url: remoteUrl, server: null },
      { url: secondRemoteUrl, server: null }
    ],
    tunnel: {
      providerId: 'ab'.repeat(32),
      mode: 'auto',
      restartRequired: false,
      publications: [
        {
          localPort: 43001,
          publicPort: 43001,
          enabled: true,
          phase: 'listening',
          detail: '',
          publicAddr: 'public.example.test:43001'
        }
      ],
      forwards: [],
      connections: [],
      error: null
    },
    environment: {
      status: 'ready',
      step: '',
      error: null,
      components: (['node', 'pi', 'bash'] as const).map((name) => ({
        name,
        status: 'ready',
        version: '1.0.0',
        path: `/fixture/${name}`,
        detail: null,
        download: null
      })),
      piUpdate: { status: 'available', version: '1.2.0', error: null }
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

// 无可见窗口时 WKWebView 会节流 setTimeout，消息通道仍可驱动隔离组件验证。
function pause(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

async function until(probe: () => unknown, message: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!probe()) {
    assert(Date.now() < deadline, `timeout: ${message}; ${document.body.innerText.slice(0, 300)}`)
    await pause()
  }
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const matches = [...scope.querySelectorAll<HTMLButtonElement>('button')].filter(
    (item) => item.textContent?.trim() === text
  )
  assert(matches.length === 1, `expected one button ${text}, got ${matches.length}`)
  assert(!matches[0].disabled, `disabled button: ${text}`)
  return matches[0]
}

function commandCount(command: string): number {
  return calls.filter((call) => call.command === command).length
}

function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function mount(hash = '#/'): Promise<void> {
  root?.unmount()
  await pause()
  assert(listeners.size === 0, 'old state subscription was not released')
  state = fixtureState()
  target = {
    url: localUrl,
    server: structuredClone(defaultServer)
  }
  calls = []
  clipboard = ''
  history.replaceState(null, '', hash)
  root = createRoot(document.getElementById('root')!)
  root.render(<DesktopApp />)
  await until(() => commandCount('get_control_state') && document.querySelector('main'), 'mount')
  if (hash === '#/') await until(() => document.querySelector('article'), 'targets loaded')
  if (hash === settingsHash)
    await until(() => document.querySelector('input[inputmode="url"]'), 'settings loaded')
  if (hash.includes('access'))
    await until(() => {
      const create = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === '共享端口'
      )
      return (
        document.querySelector('button[role="tab"][aria-selected="true"]') &&
        create &&
        !create.disabled
      )
    }, 'access loaded')
}

async function openMenu(label: string, scope: ParentNode = document): Promise<void> {
  const trigger = scope.querySelector<HTMLElement>(`summary[aria-label="${label}"]`)
  assert(trigger, `missing menu: ${label}`)
  trigger.focus()
  trigger.click()
  await until(() => trigger.closest('details')?.open, `menu open: ${label}`)
}

async function selectAccessTab(label: '本机共享' | '远端连接'): Promise<void> {
  button(label).click()
  await until(() => button(label).getAttribute('aria-selected') === 'true', `tab: ${label}`)
}

async function accessDialog(title: string): Promise<HTMLDialogElement> {
  await until(
    () =>
      [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].some(
        (item) => item.querySelector('h2')?.textContent === title
      ),
    `dialog: ${title}`
  )
  return [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].find(
    (item) => item.querySelector('h2')?.textContent === title
  )!
}

async function confirmDialog(accepted: boolean, beforeResolve?: () => void): Promise<void> {
  await until(() => document.querySelector('dialog.desktop-confirm[open]'), 'in-app confirmation')
  const dialog = document.querySelector<HTMLDialogElement>('dialog.desktop-confirm[open]')!
  assert(document.activeElement?.textContent === '取消', 'cancel should have initial focus')
  beforeResolve?.()
  const buttons = dialog.querySelectorAll<HTMLButtonElement>('button')
  buttons[accepted ? 1 : 0].click()
  await until(() => !document.querySelector('dialog.desktop-confirm[open]'), 'confirmation closed')
  await pause()
}

async function checkCommand(command: string, accepted: boolean): Promise<void> {
  if (accepted) await until(() => commandCount(command) === 1, command)
  else assert(commandCount(command) === 0, `${command} invoked after cancel`)
}

async function test(name: string, operation: () => Promise<void>): Promise<void> {
  window.__desktopTest.current = name
  try {
    await operation()
    results.push({ name, passed: true })
  } catch (cause) {
    results.push({ name, passed: false, detail: String(cause) })
  }
}

async function run(): Promise<void> {
  // 不替换 window.confirm：与有缺陷的桌面壳相同，不安装原生确认处理器。
  assert(
    window.confirm('native confirmation probe') === false,
    'probe requires no native confirm handler'
  )
  for (const accepted of [false, true]) {
    for (const [label, command] of [
      ['停止', 'stop_server_command'],
      ['重启', 'restart_server_command'],
      ['删除', 'delete_target_command']
    ] as const) {
      await test(`${label}:${accepted}`, async () => {
        await mount()
        const trigger =
          label === '删除'
            ? document.querySelector<HTMLButtonElement>(
                `button[aria-label="删除地址 ${localUrl}"]`
              )!
            : button(label)
        trigger.click()
        await confirmDialog(accepted, () => {
          assert(commandCount(command) === 0, 'command sent before confirmation')
          trigger.click()
        })
        await checkCommand(command, accepted)
      })
    }
    for (const [field, value] of [
      ['periodicUpdate', 'update'],
      ['channel', 'dev']
    ] as const) {
      await test(`${field}:${accepted}`, async () => {
        await mount(settingsHash)
        const radio = document.querySelector<HTMLInputElement>(
          `input[name="${field}"][value="${value}"]`
        )!
        radio.click()
        await confirmDialog(accepted)
        assert(radio.checked === accepted, `${field} did not respect confirmation`)
      })
    }
    for (const viaHash of [false, true]) {
      await test(`dirty-navigation:${viaHash}:${accepted}`, async () => {
        await mount(settingsHash)
        const input = document.querySelector<HTMLInputElement>('input[inputmode="url"]')!
        inputValue(input, 'http://127.0.0.1:43002/')
        await pause()
        if (viaHash) location.hash = '#/'
        else document.querySelector<HTMLButtonElement>('button[aria-label="返回"]')!.click()
        await confirmDialog(accepted, () => {
          assert(
            Boolean(document.querySelector('input[inputmode="url"]')),
            'draft unmounted before confirmation'
          )
          assert(location.hash === settingsHash, 'hash changed before confirmation')
        })
        assert(
          Boolean(document.querySelector('.desktop-control')) === accepted,
          'incorrect navigation result'
        )
        if (!accepted) assert(input.value === 'http://127.0.0.1:43002/', 'draft lost on cancel')
      })
    }
    await test(`address-editor:${accepted}`, async () => {
      await mount()
      document
        .querySelector<HTMLButtonElement>(`button[aria-label="编辑地址 ${remoteUrl}"]`)!
        .click()
      await until(
        () =>
          document.querySelector<HTMLInputElement>('input[inputmode="url"]')?.value === remoteUrl,
        'first editor'
      )
      document
        .querySelector<HTMLButtonElement>(`button[aria-label="编辑地址 ${secondRemoteUrl}"]`)!
        .click()
      await confirmDialog(accepted)
      await until(
        () =>
          document.querySelector<HTMLInputElement>('input[inputmode="url"]')?.value ===
          (accepted ? secondRemoteUrl : remoteUrl),
        'selected editor'
      )
    })
    await test(`access-mode:${accepted}`, async () => {
      await mount('#/access')
      await selectAccessTab('远端连接')
      await openMenu('远端连接策略')
      button('仅中继').click()
      await confirmDialog(accepted, () =>
        assert(commandCount('set_tunnel_mode_command') === 0, 'mode changed before confirmation')
      )
      await checkCommand('set_tunnel_mode_command', accepted)
      if (!accepted)
        assert(
          document
            .querySelector('summary[aria-label="远端连接策略"]')
            ?.textContent?.includes('自动'),
          'cancel changed policy'
        )
    })
    for (const [label, command] of [
      ['停止共享', 'set_tunnel_publication_enabled_command'],
      ['删除', 'delete_tunnel_publication_command']
    ] as const) {
      await test(`publication-${label}:${accepted}`, async () => {
        await mount('#/access?port=43001')
        const row = document.querySelector('article[aria-label="本机共享 43001"]')!
        await openMenu('本机端口 43001 的更多操作', row)
        button(label, row).click()
        await confirmDialog(accepted, () =>
          assert(commandCount(command) === 0, 'port changed before confirmation')
        )
        await checkCommand(command, accepted)
        if (accepted)
          assert(
            calls.find((call) => call.command === command)?.args.localPort === 43001,
            'wrong local port'
          )
      })
    }
    await test(`pi-update:${accepted}`, async () => {
      await mount()
      button('安装与版本').click()
      await until(
        () =>
          [...document.querySelectorAll('button')].some(
            (item) => item.textContent?.trim() === '更新 Pi 1.2.0'
          ),
        'Pi update entry'
      )
      button('更新 Pi 1.2.0').click()
      await confirmDialog(accepted)
      await checkCommand('update_pi_command', accepted)
    })
  }
  await test('tunnel-is-available-without-node-or-a-local-server', async () => {
    await mount()
    state.targets = []
    state.environment.status = 'required'
    state.environment.components.forEach((item) => {
      item.status = 'missing'
      item.version = null
    })
    listeners.forEach((listener) => listener())
    await until(() => document.body.innerText.includes('连接你的 Pi Desk'), 'no local server')
    button('远程访问').click()
    await until(() => document.querySelector('button[role="tab"]'), 'remote access entry')
    await selectAccessTab('远端连接')
    button('添加连接').click()
    const editor = await accessDialog('添加远端连接')
    button('连接', editor)
    assert(commandCount('prepare_environment_command') === 0, 'tunnel attempted to install Node')
  })
  await test('tunnel-displays-real-paths-and-tcp-counts-separately-from-policy', async () => {
    await mount('#/access')
    state.tunnel.forwards = [
      {
        providerId: 'cd'.repeat(32),
        remotePort: 5432,
        localPort: 15432,
        enabled: true,
        phase: 'listening',
        detail: '',
        path: 'relay'
      }
    ]
    state.tunnel.connections = [
      { peerId: 'cd'.repeat(32), localPort: 43001, source: 'client', path: 'direct', activeTcp: 2 },
      { peerId: 'cd'.repeat(32), localPort: 43002, source: 'client', path: 'relay', activeTcp: 1 },
      { peerId: 'ef'.repeat(32), localPort: 43001, source: 'public', path: 'direct', activeTcp: 2 }
    ]
    state.tunnel.restartRequired = true
    listeners.forEach((listener) => listener())
    await until(
      () => document.body.innerText.includes('设置已更新，重启应用后生效'),
      'restart-required hint'
    )
    assert(!document.body.innerText.includes('cd'.repeat(32)), 'full peer key leaked into overview')
    button('连接详情', document.querySelector('article[aria-label="本机共享 43001"]')!).click()
    const details = await accessDialog('连接详情')
    const count = [...details.querySelectorAll('dt')].find(
      (item) => item.textContent === '活动 TCP 连接'
    )?.nextElementSibling?.textContent
    assert(count === '4', 'details should count only this shared port')
    assert(
      details.textContent?.includes('公网转发') && details.textContent.includes('客户端直连'),
      'source/path classification lost'
    )
    assert(!details.textContent?.includes('3 条 TCP'), 'other shared port included in details')
    button('关闭', details).click()
    await selectAccessTab('远端连接')
    const mapping = document.querySelector('article[aria-label="远端连接 15432"]')!
    assert(
      mapping.textContent?.includes('中继') && !mapping.textContent.includes('连接失败'),
      'auto relay treated as failure or inferred direct'
    )
    assert(
      document.querySelector('summary[aria-label="远端连接策略"]')?.textContent?.includes('自动'),
      'path changed configured policy'
    )
  })
  await test('远程访问页签与键盘切换', async () => {
    await mount('#/access')
    assert(
      document.querySelectorAll('[role="tabpanel"]').length === 1,
      'multiple task panels visible'
    )
    assert(!document.querySelector('input[type="password"]'), 'settings permanently visible')
    const tab = button('本机共享')
    tab.focus()
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await until(
      () => button('远端连接').getAttribute('aria-selected') === 'true',
      'keyboard remote tab'
    )
    assert(
      !document.querySelector('article[aria-label="本机共享 43001"]'),
      'old task remained visible'
    )
    assert(document.activeElement === button('远端连接'), 'tab focus did not follow keyboard')
    button('远端连接').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await until(
      () => button('本机共享').getAttribute('aria-selected') === 'true',
      'keyboard local tab'
    )
  })
  await test('复制粘贴连接信息并保留固定本地端口', async () => {
    await mount('#/access')
    button('复制连接信息').click()
    await until(() => clipboard.startsWith('pidesk-tcp://'), 'connection clipboard')
    assert(
      clipboard === `pidesk-tcp://${'ab'.repeat(32)}:43001`,
      'clipboard target changed or contains extra credentials'
    )
    await selectAccessTab('远端连接')
    await until(
      () =>
        [...document.querySelectorAll<HTMLButtonElement>('button')].some(
          (item) => item.textContent?.trim() === '添加连接' && !item.disabled
        ),
      'copy operation settled'
    )
    button('添加连接').click()
    const editor = await accessDialog('添加远端连接')
    const info = editor.querySelector<HTMLTextAreaElement>('textarea')!
    const local = editor.querySelector<HTMLInputElement>('input[type="number"]')!
    inputValue(info, clipboard)
    await until(() => local.value === '43001', 'default local port')
    inputValue(local, '40333')
    await pause()
    inputValue(info, `pidesk-tcp://${'ab'.repeat(32)}:30333`)
    await pause()
    assert(local.value === '40333', 'changing target replaced fixed local port')
    button('连接', editor).click()
    await until(() => commandCount('apply_tunnel_forward_command') === 1, 'save connection')
    const saved = calls.find((call) => call.command === 'apply_tunnel_forward_command')!.args
    const value = saved.value as {
      providerId: string
      remotePort: number
      localPort: number
      enabled: boolean
    }
    assert(
      saved.originalPort === null &&
        value.providerId === 'ab'.repeat(32) &&
        value.remotePort === 30333 &&
        value.localPort === 40333 &&
        value.enabled,
      'connection did not preserve native contract'
    )
    await until(() => !document.querySelector('dialog[open]'), 'connection dialog closed')
  })
  await test('无效连接保留输入且Escape返回焦点', async () => {
    await mount('#/access')
    await selectAccessTab('远端连接')
    const trigger = button('添加连接')
    trigger.focus()
    trigger.click()
    const editor = await accessDialog('添加远端连接')
    const info = editor.querySelector<HTMLTextAreaElement>('textarea')!
    inputValue(info, 'not-a-connection')
    inputValue(editor.querySelector<HTMLInputElement>('input[type="number"]')!, '43002')
    await pause()
    button('连接', editor).click()
    await until(() => editor.textContent?.includes('连接信息无效'), 'inline connection error')
    assert(commandCount('apply_tunnel_forward_command') === 0, 'invalid connection reached native')
    assert(info.value === 'not-a-connection', 'failed input lost')
    editor.dispatchEvent(new Event('cancel', { cancelable: true }))
    await until(() => !document.querySelector('dialog[open]'), 'draft escaped')
    assert(document.activeElement === trigger, 'draft focus did not return')
  })
  await test('本机共享不要求公网端口或网址', async () => {
    await mount('#/access')
    button('共享端口').click()
    const editor = await accessDialog('添加本机共享')
    assert(
      !editor.querySelector<HTMLInputElement>('input[role="switch"]')!.checked,
      'public access unexpectedly enabled'
    )
    assert(
      editor.querySelectorAll('input[type="number"]').length === 1,
      'private sharing asks for public port'
    )
    inputValue(editor.querySelector<HTMLInputElement>('input[type="number"]')!, '5432')
    await pause()
    button('开始共享', editor).click()
    await until(
      () => commandCount('apply_tunnel_publication_command') === 1,
      'private sharing saved'
    )
    const saved = calls.find((call) => call.command === 'apply_tunnel_publication_command')!.args
    const value = saved.value as { localPort: number; publicPort: number | null; enabled: boolean }
    assert(
      saved.originalPort === null &&
        value.localPort === 5432 &&
        value.publicPort === null &&
        value.enabled,
      'private sharing became public or URL bound'
    )
    assert(commandCount('apply_target_command') === 0, 'sharing creates unrelated URL target')
  })
  await test('公网网页只打开浏览器不启动本机服务', async () => {
    await mount('#/access')
    const row = document.querySelector('article[aria-label="本机共享 43001"]')!
    button('打开网页', row).click()
    await until(() => commandCount('open_external_url_command') === 1, 'external link')
    assert(
      calls.find((call) => call.command === 'open_external_url_command')!.args.url ===
        'http://public.example.test:43001/',
      'public link incorrect'
    )
    assert(
      commandCount('open_target_command') === 0 && commandCount('start_server_command') === 0,
      'link started or changed local service'
    )
  })
  await test('取消服务器设置不改变运行连接', async () => {
    await mount('#/access')
    button('设置').click()
    let editor = await accessDialog('服务器设置')
    const address = editor.querySelector<HTMLInputElement>('input[type="url"]')!
    inputValue(address, 'http://another.example.test:7001')
    await pause()
    button('取消', editor).click()
    await until(() => !document.querySelector('dialog[open]'), 'settings cancelled')
    button('设置').click()
    editor = await accessDialog('服务器设置')
    assert(
      editor.querySelector<HTMLInputElement>('input[type="url"]')!.value ===
        'http://tunnel.example.test:7001',
      'cancelled settings were retained'
    )
    assert(
      commandCount('apply_tunnel_connection_command') === 0 &&
        commandCount('set_tunnel_publication_enabled_command') === 0,
      'settings cancel changed running tunnel'
    )
  })
  await test('escape-and-focus-return', async () => {
    await mount()
    const trigger = button('停止')
    trigger.focus()
    trigger.click()
    await until(() => document.querySelector('dialog.desktop-confirm[open]'), 'confirmation')
    const event = new Event('cancel', { cancelable: true })
    document.querySelector('dialog.desktop-confirm')!.dispatchEvent(event)
    await until(() => !document.querySelector('dialog.desktop-confirm'), 'Escape cancel')
    assert(commandCount('stop_server_command') === 0, 'Escape sent stop command')
    assert(document.activeElement === trigger, 'focus did not return to trigger')
  })
  await test('unmount-cancels-pending-operation', async () => {
    await mount()
    button('停止').click()
    await until(() => document.querySelector('dialog.desktop-confirm[open]'), 'confirmation')
    root?.unmount()
    root = null
    await pause()
    assert(commandCount('stop_server_command') === 0, 'unmount sent stop command')
  })
  await test('provider-unmount-resolves-false', async () => {
    let result: boolean | undefined
    function Probe(): React.JSX.Element {
      const confirm = useDesktopConfirm()
      return (
        <button
          onClick={() => {
            void confirm({ title: '测试', description: '测试取消', confirmLabel: '继续' }).then(
              (value) => {
                result = value
              }
            )
          }}
        >
          测试确认
        </button>
      )
    }
    root = createRoot(document.getElementById('root')!)
    root.render(
      <DesktopConfirmProvider>
        <Probe />
      </DesktopConfirmProvider>
    )
    await until(() => document.body.innerText.includes('测试确认'), 'probe mount')
    button('测试确认').click()
    await until(() => document.querySelector('dialog[open]'), 'probe confirmation')
    root.unmount()
    root = null
    await until(() => result !== undefined, 'pending confirmation settled on unmount')
    assert(result === false, 'unmount must resolve false')
  })
  root?.unmount()
  root = null
  window.__desktopTest.done = true
}

async function visual(scene: string): Promise<void> {
  if (scene.startsWith('tunnel')) {
    await mount('#/access?port=43001')
    state.tunnel.forwards = [
      {
        providerId: 'cd'.repeat(32),
        remotePort: 5432,
        localPort: 15432,
        enabled: true,
        phase: scene === 'tunnel-failure' ? 'failed' : 'listening',
        detail: scene === 'tunnel-failure' ? '本地端口 15432 已被占用，请释放此端口后重试。' : '',
        path: scene === 'tunnel-failure' ? 'unknown' : 'relay'
      }
    ]
    state.tunnel.publications.push({
      localPort: 5432,
      publicPort: null,
      enabled: true,
      phase: 'listening',
      detail: '',
      publicAddr: null
    })
    state.tunnel.forwards.push({
      providerId: 'ef'.repeat(32),
      remotePort: 30333,
      localPort: 40333,
      enabled: true,
      phase: 'listening',
      detail: '',
      path: 'direct'
    })
    state.tunnel.connections = [
      { peerId: 'ef'.repeat(32), localPort: 43001, source: 'public', path: 'direct', activeTcp: 3 },
      { peerId: 'cd'.repeat(32), localPort: 43001, source: 'client', path: 'direct', activeTcp: 1 }
    ]
    listeners.forEach((listener) => listener())
    await until(
      () => document.querySelector('article[aria-label="本机共享 5432"]'),
      'shared scene data'
    )
    if (scene === 'tunnel-mapping' || scene === 'tunnel-failure' || scene === 'tunnel-connect') {
      await selectAccessTab('远端连接')
      await until(
        () => document.querySelector('article[aria-label="远端连接 15432"]'),
        'remote scene data'
      )
    }
    if (scene === 'tunnel-connections') {
      button('连接详情', document.querySelector('article[aria-label="本机共享 43001"]')!).click()
      await accessDialog('连接详情')
    } else if (scene === 'tunnel-share') {
      button('共享端口').click()
      await accessDialog('添加本机共享')
    } else if (scene === 'tunnel-connect') {
      button('添加连接').click()
      const editor = await accessDialog('添加远端连接')
      inputValue(
        editor.querySelector<HTMLTextAreaElement>('textarea')!,
        `pidesk-tcp://${'cd'.repeat(32)}:30333`
      )
      await until(
        () => editor.querySelector<HTMLInputElement>('input[type="number"]')?.value === '30333',
        'pasted target preview'
      )
    } else if (scene === 'tunnel-settings') {
      button('设置').click()
      await accessDialog('服务器设置')
    }
    results.push({ name: `visual:${scene}`, passed: true })
    window.__desktopTest.done = true
    return
  }
  await mount()
  if (scene === 'pi') {
    button('安装与版本').click()
    await until(
      () =>
        [...document.querySelectorAll('button')].some(
          (item) => item.textContent?.trim() === '更新 Pi 1.2.0'
        ),
      'Pi entry'
    )
    button('更新 Pi 1.2.0').click()
  } else {
    button('停止').click()
  }
  await until(() => document.querySelector('dialog.desktop-confirm[open]'), 'visual confirmation')
  results.push({ name: `visual:${scene}`, passed: true })
  window.__desktopTest.done = true
}

const scene = new URLSearchParams(location.search).get('scene')
void (scene ? visual(scene) : run()).catch((cause) => {
  results.push({ name: 'fixture', passed: false, detail: String(cause) })
  window.__desktopTest.done = true
})
