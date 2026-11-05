import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { terminateManagedTree } from '../../src/server/l4_foundation/process/l4-process-tree.js'

const executable = resolve(process.argv[2])
const parent = resolve('temp/run/desktop-tunnel-check')
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(join(parent, 'entry-'))
const config = join(directory, 'config.json')
const secret = 'invalid-key-fixture'
await writeFile(
  config,
  JSON.stringify({ tunnel: { controlServerUrl: 'http://tunnel.example:7001', controlKey: secret } })
)

async function invoke(args) {
  let child
  try {
    return await new Promise((resolveResult) => {
      child = execFile(
        executable,
        args,
        {
          env: { ...process.env, PI_DESK_DESKTOP_CONFIG: config },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 64 * 1024
        },
        (error, stdout, stderr) => resolveResult({ error, stdout, stderr })
      )
    })
  } finally {
    if (child) await terminateManagedTree(child)
  }
}

try {
  if (process.platform === 'win32') {
    const bytes = await readFile(executable)
    const peHeader = bytes.readUInt32LE(0x3c)
    assert.equal(
      bytes.readUInt16LE(peHeader + 24 + 68),
      2,
      '桌面安装包必须使用 Windows GUI 子系统，不能携带调试控制台'
    )
  }
  const resources =
    process.platform === 'darwin'
      ? resolve(dirname(executable), '../Resources')
      : dirname(executable)
  for (const file of [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'licenses/iroh-APACHE-2.0.txt',
    'licenses/iroh-MIT.txt',
    'licenses/iroh-BSD-3-Clause.txt',
    'licenses/iroh-relay-BSD-3-Clause.txt'
  ]) {
    const expected = await readFile(new URL(`../../apps/tunnel/${file}`, import.meta.url))
    const actual = await readFile(join(resources, 'third-party/tunnel', file))
    assert.deepEqual(actual, expected, `桌面传输许可资源不一致：${file}`)
  }
  const info = await invoke(['--tunnel-info'])
  assert.equal(info.error, null, info.stderr)
  assert.deepEqual(JSON.parse(info.stdout), { controlServerUrl: 'http://tunnel.example:7001' })
  for (const options of [[], ['--stats']]) {
    const failure = await invoke([
      '--tunnel-client',
      '--local',
      '127.0.0.1:6233',
      '--public-port',
      '11001',
      ...options
    ])
    assert.equal(failure.error?.code, 1)
    const event = JSON.parse(failure.stdout.trim())
    assert.equal(event.type, 'failed')
    assert.match(event.detail, /控制密钥/, '参数应被接受，再由配置校验拒绝无效密钥')
    assert.ok(!`${info.stdout}${info.stderr}${failure.stdout}${failure.stderr}`.includes(secret))
  }
  console.info('桌面无界面隧道、统计参数与错误输出检查通过。')
} finally {
  await rm(directory, { recursive: true, force: true })
}
