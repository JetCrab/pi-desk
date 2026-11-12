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
const keyFile = join(directory, 'secret-key')
const agentDir = join(directory, 'agent')
const secret = 'invalid-key-fixture'

async function writeConfig(ciphertext) {
  await writeFile(
    config,
    JSON.stringify({
      targets: [],
      tunnel: {
        controlServerUrl: 'http://tunnel.example:7001',
        controlKey: 'desktop-secret://control-key'
      },
      desktopVault: { version: 1, ciphertext: [...Buffer.from(ciphertext, 'hex')] }
    })
  )
}

async function invoke(args) {
  let child
  try {
    return await new Promise((resolveResult) => {
      child = execFile(
        executable,
        args,
        {
          env: {
            ...process.env,
            PI_DESK_DESKTOP_CONFIG: config,
            PI_DESK_DESKTOP_DATA_DIR: directory,
            PI_DESK_SECRET_KEY_FILE: keyFile,
            PI_CODING_AGENT_DIR: agentDir,
            PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions')
          },
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
  // XChaCha20-Poly1305 固定测试密文，密钥为 32 字节 0x45。
  // AAD 为 pi-desk-desktop/storage/v1，不依赖系统钥匙串。
  await writeFile(keyFile, Buffer.alloc(32, 0x45))
  await writeConfig(
    '242424242424242424242424242424242424242424242424d87d36e3a545adfc5a39c902785b62af6fd8e6fe7cf4948c90d13df85de1d0de3f5b97cea09a45dd79e197c30729d0e6255f9686581aad728daeba8e97b57d687af1c38d43843d5744b9ea72b739b69a47977ed350c1efafea15cc08ae69da81c4'
  )
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
  await writeConfig(
    '242424242424242424242424242424242424242424242424d87d36e3a545adfc5a39c902785b62a763cfe5f377f1db8697c972ff56f8c6ca2f5fd7d2686e7307032e92327b3d41789aaab42b'
  )
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
    const output = `${info.stdout}${info.stderr}${failure.stdout}${failure.stderr}`
    assert.ok(!output.includes(secret))
    assert.ok(!output.includes('ab'.repeat(32)))
  }
  console.info('桌面无界面隧道、统计参数与错误输出检查通过。')
} finally {
  await rm(directory, { recursive: true, force: true })
}
