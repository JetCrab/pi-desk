import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
  const bytes = await readFile(executable)
  const peHeader = bytes.readUInt32LE(0x3c)
  assert.equal(
    bytes.readUInt16LE(peHeader + 24 + 68),
    2,
    '桌面安装包必须使用 Windows GUI 子系统，不能携带调试控制台'
  )
  const info = await invoke(['--tunnel-info'])
  assert.equal(info.error, null, info.stderr)
  assert.deepEqual(JSON.parse(info.stdout), { controlServerUrl: 'http://tunnel.example:7001' })
  const failure = await invoke([
    '--tunnel-client',
    '--local',
    '127.0.0.1:6233',
    '--public-port',
    '11001'
  ])
  assert.equal(failure.error?.code, 1)
  assert.equal(JSON.parse(failure.stdout.trim()).type, 'failed')
  assert.ok(!`${info.stdout}${info.stderr}${failure.stdout}${failure.stderr}`.includes(secret))
  console.info('桌面无界面隧道入口与错误脱敏检查通过。')
} finally {
  await rm(directory, { recursive: true, force: true })
}
