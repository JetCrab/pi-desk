import { createRoot, type Root } from 'react-dom/client'
import { DesktopApp } from '../web/l1-desktop-app'
import { DesktopConfirmProvider, useDesktopConfirm } from '../web/l4-desktop-confirm'
import type { ControlState, ServerConfig, TargetConfig } from '../web/l4-desktop-ipc'

type Result = { name: string; passed: boolean; detail?: string }
type Call = { command: string; args: Record<string, unknown> }

declare global {
  interface Window {
    __desktopTest: {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
      listen: (name: string, listener: () => void) => Promise<() => void>
      results: Result[]
      current: string
      done: boolean
    }
  }
}

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

window.__desktopTest = {
  results,
  current: '',
  done: false,
  async invoke(command, args = {}): Promise<unknown> {
    calls.push({ command, args })
    if (command === 'get_control_state') return structuredClone(state)
    if (command === 'get_target_settings') {
      return {
        target: args.url === localUrl ? target : { url: args.url, server: null, tunnel: null },
        defaultServer
      }
    }
    if (command === 'stop_tunnel_command') {
      const tunnel = state.targets.find((item) => item.url === args.url)?.tunnel
      if (tunnel) tunnel.status = 'stopped'
    }
    if (command === 'get_environment_download_source') return { mode: 'official' }
    if (command === 'get_tunnel_connection') {
      return { controlServerUrl: 'https://tunnel.example.test/', controlKey: 'test-key' }
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
        },
        tunnel: {
          status: 'listening',
          detail: '',
          publicAddr: 'public.example.test:43001',
          publicPort: 43001
        }
      },
      { url: remoteUrl, server: null, tunnel: null },
      { url: secondRemoteUrl, server: null, tunnel: null }
    ],
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

function inputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function mount(hash = '#/'): Promise<void> {
  root?.unmount()
  await pause()
  assert(listeners.size === 0, 'old state subscription was not released')
  state = fixtureState()
  target = {
    url: localUrl,
    server: structuredClone(defaultServer),
    tunnel: { enabled: true, publicPort: 43001 }
  }
  calls = []
  history.replaceState(null, '', hash)
  root = createRoot(document.getElementById('root')!)
  root.render(<DesktopApp />)
  await until(() => commandCount('get_control_state') && document.querySelector('main'), 'mount')
  if (hash === '#/') await until(() => document.querySelector('article'), 'targets loaded')
  if (hash === settingsHash)
    await until(() => document.querySelector('input[inputmode="url"]'), 'settings loaded')
  if (hash.includes('access'))
    await until(
      () => document.querySelector('form') || document.body.textContent?.includes('修改配置'),
      'access loaded'
    )
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
    await test(`access-reconnect:${accepted}`, async () => {
      await mount(`#/access?url=${encodeURIComponent(localUrl)}`)
      if (!document.querySelector('form')) button('修改配置').click()
      await until(() => document.querySelector('form'), 'access form')
      document.querySelector<HTMLFormElement>('form')!.requestSubmit()
      await confirmDialog(accepted, () =>
        assert(commandCount('stop_tunnel_command') === 0, 'tunnel stopped before confirmation')
      )
      await checkCommand('apply_tunnel_connection_command', accepted)
    })
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
