import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform, 'linux', '本入口仅用于 Linux 安装包验收')
const archive = resolve(process.argv[2])
const root = resolve(process.env.CLIENT_SMOKE_ROOT)
await mkdir(join(root, 'data'), { recursive: true })
await mkdir(join(root, 'tmp'), { recursive: true })
await writeFile(join(root, 'data/config.json'), JSON.stringify({ targets: [] }))
const env = {
  ...process.env,
  PI_DESK_DESKTOP_DATA_DIR: join(root, 'data'),
  PI_DESK_DESKTOP_DISCOVERY_PATH: '',
  PI_CODING_AGENT_DIR: join(root, 'agent'),
  PI_CODING_AGENT_SESSION_DIR: join(root, 'agent/sessions'),
  TMPDIR: join(root, 'tmp'),
  APPIMAGE_EXTRACT_AND_RUN: '1',
  WEBKIT_DISABLE_DMABUF_RENDERER: '1'
}
let stdout = ''
let stderr = ''
const processes = []
function launch(args) {
  const child = spawn(archive, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (data) => {
    stdout = (stdout + data).slice(-2 * 1024 * 1024)
  })
  child.stderr.on('data', (data) => {
    stderr = (stderr + data).slice(-2 * 1024 * 1024)
  })
  const state = { child, exited: false, code: null, error: null }
  child.on('error', (error) => {
    state.error = error
    state.exited = true
  })
  child.on('close', (code) => {
    state.code = code
    state.exited = true
  })
  processes.push(state)
  return state
}
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (!(await check())) {
    assert.ok(Date.now() < end, `Linux 安装包验收超时：${label}\n${stderr}`)
    await delay(100)
  }
}
const app = launch([])
try {
  await until(async () => {
    assert.ok(!app.exited, `桌面提前退出：${app.error ?? app.code}\n${stderr}`)
    const log = await readFile(join(root, 'data/logs/desktop.log'), 'utf8').catch(() => '')
    return /control-page-load[^\n]*Finished/.test(log)
  }, '控制中心网页加载')
  const ids = execFileSync('xdotool', ['search', '--onlyvisible', '--name', '^Pi Desk$'], {
    encoding: 'utf8'
  })
    .trim()
    .split('\n')
  assert.ok(ids[0], '没有可见的控制中心窗口')
  execFileSync('import', ['-window', ids[0], join(root, 'linux-desktop.png')], { stdio: 'pipe' })
  const quit = launch(['--exit-for-update'])
  await until(() => app.exited && quit.exited, '正常退出及单实例通知')
  assert.equal(quit.code, 0, `退出通知失败：${quit.error ?? stderr}`)
  assert.equal(app.code, 0, `桌面正常退出失败：${app.error ?? stderr}`)
  console.info('Linux AppImage 已完成界面加载、截图及正常退出验收。')
} finally {
  for (const { child } of processes) {
    if (!child.pid) continue
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  await until(() => processes.every((state) => state.exited), '测试进程清理', 10000)
  await writeFile(join(root, 'stdout.log'), stdout)
  await writeFile(join(root, 'stderr.log'), stderr)
  await rm(join(root, 'tmp'), { recursive: true, force: true })
}
