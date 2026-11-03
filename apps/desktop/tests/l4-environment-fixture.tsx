import { createRoot, type Root } from 'react-dom/client'
import { DesktopApp } from '../web/l1-desktop-app'
import type { ControlState } from '../web/l4-desktop-ipc'
import type { Call, Result } from './l4-desktop-test'

const isWindows = /Windows/u.test(navigator.userAgent)
const waiting = isWindows
  ? '正在安装 Node.js。若 Windows 询问，请确认本次安装。'
  : '正在等待系统工具安装。请在 macOS 弹窗中安装“命令行开发者工具”，完成后会自动继续准备 Pi Desk。'
const windowsCancelWaiting = '正在等待 Node.js 安装结束，随后停止本次准备。'
let finishWindowsInstaller: (() => void) | null = null
const localUrl = 'http://127.0.0.1:43001/'
const results: Result[] = []
const calls: Call[] = []
const listeners = new Set<() => void>()
let state: ControlState
let root: Root | null = null

function fixtureState(): ControlState {
  return {
    hideOnStartup: null,
    hideOnOpen: true,
    showOnClose: true,
    targets: [
      {
        url: localUrl,
        server: {
          status: 'stopped',
          detail: '',
          version: null,
          autoStart: false,
          needsSetup: true,
          update: { status: 'idle', version: null, error: null }
        },
        tunnel: null
      }
    ],
    environment: {
      status: 'required',
      step: '需要准备运行环境',
      error: null,
      components: (['node', 'pi', 'bash'] as const).map((name) => ({
        name,
        status: !isWindows && name === 'bash' ? 'invalid' : 'missing',
        version: null,
        path: null,
        detail:
          !isWindows && name === 'bash' ? '需要安装 macOS 命令行开发者工具，以使用 Git' : null,
        download: null
      })),
      piUpdate: { status: 'idle', version: null, error: null }
    }
  }
}

function publish(): void {
  listeners.forEach((listener) => listener())
}

function setFailure(message: string): void {
  state.environment.status = 'failed'
  state.environment.error = message
  state.environment.components.forEach((item) => {
    item.status = item.name === 'bash' ? 'ready' : 'missing'
    item.detail = null
  })
  publish()
}

function setWaiting(): void {
  state.environment.status = 'installing'
  state.environment.step = waiting
  state.environment.error = null
  const component = state.environment.components.find(
    (item) => item.name === (isWindows ? 'node' : 'bash')
  )!
  component.status = 'missing'
  component.detail = waiting
  publish()
}

function setWindowsGitWaiting(): void {
  state.environment.status = 'installing'
  state.environment.step = '正在安装 Git。若 Windows 询问，请确认本次安装。'
  state.environment.components.forEach((item) => {
    item.status = item.name === 'bash' ? 'missing' : 'ready'
    item.detail = item.name === 'bash' ? state.environment.step : null
    item.download = null
  })
  state.targets[0].server!.update!.status = 'installed'
  publish()
}

function setWindowsParallelDownloads(): void {
  state.environment.status = 'installing'
  state.environment.step = '正在下载 Node.js；正在下载 Git Bash'
  state.environment.components.forEach((item) => {
    item.status = 'missing'
    item.detail =
      item.name === 'node' ? '正在下载 Node.js' : item.name === 'bash' ? '正在下载 Git Bash' : null
    item.download =
      item.name === 'pi'
        ? null
        : {
            received: (item.name === 'node' ? 1 : 2) * 1024 * 1024,
            total: 10 * 1024 * 1024
          }
  })
  publish()
}

window.__desktopTest = {
  results,
  current: '',
  done: false,
  async invoke(command, args = {}): Promise<unknown> {
    calls.push({ command, args })
    if (command === 'get_control_state') return structuredClone(state)
    if (command === 'get_environment_download_source') return { mode: 'official' }
    if (command === 'prepare_environment_command') setWaiting()
    else if (command === 'cancel_environment_command') {
      const finish = (): void => {
        state.environment.status = 'required'
        state.environment.error = null
        state.environment.components.forEach((item) => {
          item.detail = null
          item.download = null
        })
        publish()
      }
      if (isWindows) {
        state.environment.step = windowsCancelWaiting
        state.environment.components.find((item) => item.name === 'node')!.detail =
          windowsCancelWaiting
        publish()
        return new Promise<void>((resolve) => {
          finishWindowsInstaller = (): void => {
            finishWindowsInstaller = null
            finish()
            resolve()
          }
        })
      }
      finish()
    } else if (command === 'set_startup_preference_command') {
      Object.assign(state, args)
      publish()
    } else if (command === 'select_environment_command') return
    else throw new Error(`隔离引导未声明命令：${command}`)
    return undefined
  },
  async listen(_name, listener): Promise<() => void> {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

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
    assert(Date.now() < deadline, `timeout: ${message}; ${document.body.innerText.slice(0, 400)}`)
    await pause()
  }
}

function button(text: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (item) => item.textContent?.trim() === text && item.checkVisibility()
  )
  assert(matches.length === 1 && !matches[0].disabled, `按钮不可用：${text}`)
  return matches[0]
}

function commandCount(command: string): number {
  return calls.filter((call) => call.command === command).length
}

async function mount(): Promise<void> {
  finishWindowsInstaller?.()
  root?.unmount()
  await pause()
  assert(listeners.size === 0, '旧监听未释放')
  calls.length = 0
  state = fixtureState()
  history.replaceState(null, '', '#/')
  root = createRoot(document.getElementById('root')!)
  root.render(<DesktopApp />)
  await until(() => document.querySelector('.setup-steps'), '准备页')
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

function assertFits(): void {
  assert(document.documentElement.scrollWidth <= innerWidth, '页面横向溢出')
  for (const selector of ['.setup-footer button', '.setup-caption']) {
    const rect = document.querySelector(selector)!.getBoundingClientRect()
    assert(rect.right <= innerWidth && rect.bottom <= innerHeight, `主要内容超出窗口：${selector}`)
  }
}

async function run(): Promise<void> {
  await test('初次准备不预授权、不弹偏好、不展开维护信息', async () => {
    await mount()
    assert(!document.querySelector('dialog[open]'), '环境未就绪就询问显示偏好')
    assert(!document.querySelector('.launch-actions'), '重复展示打开/重启按钮')
    assert(!document.querySelector('[role="alert"]'), '缺少系统工具被当作失败')
    assert(commandCount('prepare_environment_command') === 0, '首次检测自动执行安装')
    assert(commandCount('get_environment_download_source') === 0, '未使用下载选项就查询下载源')
    const labels = [...document.querySelectorAll('.step-heading strong')].map(
      (item) => item.textContent
    )
    assert(
      labels.join(',') ===
        (isWindows ? 'Node.js,Git Bash,Pi,Pi Desk' : '系统工具,Node.js,Pi,Pi Desk'),
      '平台步骤顺序不正确'
    )
    if (isWindows)
      assert(
        !document.body.innerText.includes('命令行开发者工具'),
        'Windows 混入 macOS 系统工具提示'
      )
    assert(!document.body.innerText.includes('选择已有 Node.js 目录'), '手动路径抢占主流程')
    assert(!document.body.innerText.includes('下载设置'), '下载设置未收起')
    assertFits()
  })
  await test('系统安装正常等待、取消准备不重发请求', async () => {
    await mount()
    button('安装并打开').click()
    await until(() => document.body.innerText.includes(waiting), '系统工具等待说明')
    assert(!document.querySelector('[role="alert"]'), '等待系统安装时出现错误')
    assert(!document.body.innerText.includes('重试'), '等待时出现重试入口')
    assert(!document.querySelector('.install-options'), '等待时展示维护操作')
    assert(
      document
        .querySelector('.setup-step[data-active="true"]')
        ?.textContent?.includes(isWindows ? 'Node.js' : '系统工具'),
      '当前安装步骤未保留'
    )
    button('取消准备').click()
    if (isWindows) {
      await until(
        () => document.body.innerText.includes(windowsCancelWaiting),
        '等待已启动的 Windows 安装器结束'
      )
      assert(!document.querySelector('[role="alert"]'), '正常等待安装器结束被当作错误')
      assert(!document.body.innerText.includes('完成后自动打开'), '取消后仍承诺自动打开')
      assert(!document.body.innerText.includes('安装并打开'), '安装器尚未退出就允许重复安装')
      assert(state.environment.status === 'installing', '系统安装未结束就清理准备状态')
      assert(finishWindowsInstaller, '缺少隔离安装完成回调')
      finishWindowsInstaller()
    }
    await until(() => document.body.innerText.includes('安装并打开'), '取消后返回准备入口')
    assert(commandCount('prepare_environment_command') === 1, '取消触发重复准备')
    assert(commandCount('cancel_environment_command') === 1, '未取消当前等待')
  })
  await test('前置组件完成后展示下一步、不要求重新安装', async () => {
    await mount()
    setWaiting()
    const bash = state.environment.components.find((item) => item.name === 'bash')!
    bash.status = 'ready'
    bash.detail = null
    const node = state.environment.components.find((item) => item.name === 'node')!
    if (isWindows) {
      node.status = 'ready'
      node.detail = null
      const pi = state.environment.components.find((item) => item.name === 'pi')!
      pi.detail = '正在安装 Pi'
      state.environment.step = '正在安装 Pi；正在安装 Pi Desk'
      state.targets[0].server!.update!.status = 'installing'
    } else {
      state.environment.step = '正在下载 Node.js'
      node.detail = '正在下载 Node.js'
      node.download = { received: 1024 * 1024, total: 10 * 1024 * 1024 }
    }
    publish()
    await until(
      () =>
        document
          .querySelector('.setup-description')
          ?.textContent?.includes(isWindows ? '正在安装 Pi' : '正在下载 Node.js'),
      '后续步骤'
    )
    assert(!document.querySelector('[role="alert"]'), '继续安装被展示为失败')
    if (isWindows) {
      for (const label of ['Pi', 'Pi Desk']) {
        const progress = document.querySelector(`progress[aria-label="${label}安装进度"]`)
        assert(progress && !progress.hasAttribute('value'), 'npm 阶段伪造百分比或丢失并行进度')
      }
    } else {
      assert(
        document.querySelector('.setup-step[data-ready="true"]')?.textContent?.includes('系统工具'),
        '系统工具完成状态丢失'
      )
      assert(
        document.querySelector('progress[aria-label="Node.js下载进度"]')?.getAttribute('value') ===
          '10',
        '下载未使用真实进度'
      )
    }
  })
  await test('真实失败只展示恢复入口、技术详情按需展开', async () => {
    await mount()
    setFailure('下载连接失败（download.example.test:443），请检查网络。')
    await until(() => document.querySelector('[role="alert"]'), '真实失败反馈')
    assert(
      document.querySelector('[role="alert"] details')?.hasAttribute('open') === false,
      '技术详情默认展开'
    )
    assert(!document.body.innerText.includes('download.example.test'), '长错误暴露在主页面')
    button('重试')
    const options = document.querySelector<HTMLDetailsElement>('.install-options')!
    options.open = true
    const nodeOptions = [...options.querySelectorAll<HTMLDetailsElement>('.component')].find(
      (item) => item.querySelector('summary')?.textContent?.trim() === 'Node.js'
    )!
    nodeOptions.open = true
    await until(() => document.body.innerText.includes('选择已有 Node.js 目录'), '手动选项')
    button('选择已有 Node.js 目录').click()
    assert(commandCount('select_environment_command') === 1, '已有环境入口不可用')
    if (isWindows) {
      await pause()
      await until(
        () =>
          [...nodeOptions.querySelectorAll<HTMLButtonElement>('button')].some(
            (item) => item.textContent?.trim() === '选择已下载的安装包' && !item.disabled
          ),
        '前一个选择操作结束'
      )
      button('选择已下载的安装包').click()
      await until(
        () =>
          calls.some(
            (call) =>
              call.command === 'select_environment_command' &&
              call.args.component === 'node' &&
              call.args.archive === true
          ),
        'Windows MSI 入口'
      )
    }
  })
  if (isWindows) {
    await test('Git 安装等待是正常步骤、不要求全局管理员运行', async () => {
      await mount()
      setWindowsGitWaiting()
      await until(() => document.body.innerText.includes('若 Windows 询问'), 'Git 安装说明')
      assert(!document.querySelector('[role="alert"]'), 'Git 等待授权被当作失败')
      assert(
        document
          .querySelector('.setup-step[data-active="true"]')
          ?.textContent?.includes('Git Bash'),
        'Git 步骤丢失'
      )
      assert(!document.body.innerText.includes('以管理员身份运行'), '要求整个应用提权')
      assert(!document.body.innerText.includes('命令行开发者工具'), 'Windows 展示了 Mac 引导')
    })
    await test('Node 与 Git 并行下载只展示实际进度', async () => {
      await mount()
      setWindowsParallelDownloads()
      await until(
        () => document.querySelectorAll('.setup-step[data-active="true"]').length === 2,
        '并行准备状态'
      )
      for (const [label, value] of [
        ['Node.js', '10'],
        ['Git Bash', '20']
      ]) {
        assert(
          document
            .querySelector(`progress[aria-label="${label}下载进度"]`)
            ?.getAttribute('value') === value,
          '并行下载进度不真实'
        )
      }
      assert(!document.querySelector('[role="alert"]'), '并行准备被当作故障')
    })
  }
  await test('显示偏好延后到环境就绪', async () => {
    await mount()
    state.environment.status = 'ready'
    state.environment.components.forEach((item) => {
      item.status = 'ready'
      item.detail = null
    })
    state.targets[0].server!.needsSetup = false
    state.targets[0].server!.status = 'running'
    publish()
    await until(() => document.querySelector('dialog[open]'), '延后显示偏好')
    button('每次显示').click()
    await until(() => !document.querySelector('dialog[open]'), '保存偏好')
    assert(commandCount('set_startup_preference_command') === 1, '偏好保存入口失效')
  })
  root?.unmount()
  root = null
  window.__desktopTest.done = true
}

async function visual(scene: string): Promise<void> {
  await mount()
  if (scene.startsWith('waiting')) {
    setWaiting()
    await until(() => document.body.innerText.includes(waiting), '等待场景')
  } else if (scene === 'git-waiting') {
    setWindowsGitWaiting()
    await until(() => document.body.innerText.includes('正在安装 Git'), 'Git 等待场景')
  } else if (scene === 'parallel') {
    setWindowsParallelDownloads()
    await until(
      () => document.querySelectorAll('.setup-step[data-active="true"]').length === 2,
      '并行下载场景'
    )
  } else if (scene === 'cancel-waiting') {
    setWaiting()
    await until(() => document.body.innerText.includes(waiting), '系统安装场景')
    button('取消准备').click()
    await until(
      () => document.body.innerText.includes(windowsCancelWaiting),
      '等待系统安装结束后取消'
    )
  } else if (scene === 'failure') {
    setFailure(`下载连接失败（download.example.test:443）。${'底层诊断信息 '.repeat(200)}`)
    await until(() => document.querySelector('[role="alert"]'), '失败场景')
  }
  if (scene.endsWith('large')) {
    document.documentElement.style.fontSize = '20px'
    await pause()
  }
  assertFits()
  results.push({ name: `visual:${scene}`, passed: true })
  window.__desktopTest.done = true
}

const scene = new URLSearchParams(location.search).get('scene')
void (scene ? visual(scene) : run()).catch((cause) => {
  results.push({ name: 'fixture', passed: false, detail: String(cause) })
  window.__desktopTest.done = true
})
