import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32', '安装界面验收仅支持 Windows')
assert.ok(process.argv[2] && process.argv[3], '请传入生成的 installer.nsi 和 makensis.exe')
const generated = resolve(process.argv[2])
const makensis = resolve(process.argv[3])
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const id = `native-ui-${process.pid}-${Date.now()}`
const root = join(project, 'temp/run/desktop-installer', id)
const build = join(project, 'temp/build/desktop-installer', id)
const product = `PiDeskFixture-${id}`
const manufacturer = `PiDeskFixture-${id}`
const binary = `fixture-${id}`
const install = join(root, '安装目录')
const desktop = join(root, 'desktop')
const menu = join(root, 'start-menu')
const productKey = `HKCU:\\Software\\${manufacturer}\\${product}`
const uninstallKey = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}`
const active = new Set()
let commandIndex = 0
await mkdir(root, { recursive: true })
await mkdir(build, { recursive: true })
await mkdir(desktop, { recursive: true })
await mkdir(menu, { recursive: true })

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`
}
async function run(command, args, cwd = dirname(generated), timeout = 120_000) {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  active.add(child)
  let output = ''
  child.stdout.on('data', (data) => (output += data))
  child.stderr.on('data', (data) => (output += data))
  const log = join(root, `command-${++commandIndex}.log`)
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  }, timeout)
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', resolveExit)
    })
    await writeFile(log, output)
    assert.ok(!expired, `命令超时：${command}`)
    assert.equal(code, 0, `${command}: ${output}`)
    return output
  } finally {
    clearTimeout(timer)
    active.delete(child)
  }
}
function ps(command) {
  return run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop'; ${command}`
  ])
}
function define(source, name, value) {
  const pattern = new RegExp(`^!define ${name} ".*"`, 'm')
  assert.match(source, pattern)
  return source.replace(pattern, () => `!define ${name} "${value}"`)
}
const payload = join(build, `${binary}.exe`)
const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework/v4.0.30319/csc.exe')
const fixtureSource = join(build, 'fixture.cs')
await writeFile(
  fixtureSource,
  `using System; using System.IO; using System.Reflection;
public class Fixture {
  public static void Main() {
    string folder = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    File.WriteAllText(Path.Combine(folder, "opened.txt"), "opened");
  }
}`
)
await run(compiler, [
  '/nologo',
  '/target:winexe',
  '/platform:x86',
  `/out:${payload}`,
  fixtureSource
])
let script = await readFile(generated, 'utf8')
for (const [name, value] of Object.entries({
  PRODUCTNAME: product,
  STARTMENUFOLDER: product,
  MANUFACTURER: manufacturer,
  MAINBINARYNAME: binary,
  MAINBINARYSRCPATH: payload,
  BUNDLEID: `com.jetcrab.fixture.${id}`,
  VERSION: '1.0.0',
  VERSIONWITHBUILD: '1.0.0.0',
  INSTALLWEBVIEW2MODE: 'skip',
  OUTFILE: join(build, 'setup.exe')
})) {
  script = define(script, name, value)
}
script = script
  .replaceAll('$DESKTOP', desktop)
  .replaceAll('$SMPROGRAMS', menu)
  .replaceAll('$LOCALAPPDATA\\${PRODUCTNAME}', install)
  .replaceAll('$APPDATA\\${BUNDLEID}', join(root, 'roaming-data'))
  .replaceAll('$LOCALAPPDATA\\${BUNDLEID}', join(root, 'local-data'))
  // 为可观察的真实NSIS阶段留出操作时间，不修改生产进度算法。
  .replace(
    'Section Install\n',
    `Section Install\n  StrCpy $R7 0\n  fixture_wait:\n    Call CheckCancellation\n    Sleep 100\n    IntOp $R7 $R7 + 1\n    IntCmp $R7 30 fixture_ready fixture_wait fixture_ready\n  fixture_ready:\n`
  )
  .replace('Call BeginFileReplacement\n', 'Call BeginFileReplacement\n  Sleep 800\n')
const fixtureScript = join(build, 'installer.nsi')
await writeFile(fixtureScript, script)
await run(makensis, ['/V2', '/NOCD', fixtureScript])
const config = join(root, 'config.json')
await writeFile(
  config,
  JSON.stringify({
    setup: join(build, 'setup.exe'),
    root,
    install,
    product,
    binary,
    desktop,
    menu,
    productKey,
    uninstallKey
  })
)
let passed = false
try {
  const output = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(dirname(fileURLToPath(import.meta.url)), 'test-installer-ui.ps1'),
      '-Config',
      config
    ],
    project,
    180_000
  )
  console.info(output)
  const installed = await readFile(join(install, `${binary}.exe`))
  assert.equal(
    createHash('sha256').update(installed).digest('hex'),
    createHash('sha256')
      .update(await readFile(payload))
      .digest('hex')
  )
  const uninstaller = join(install, 'uninstall.exe')
  // /S在隔离目标运行，_?=阻止卸载器复制到公共临时目录后脱离父进程。
  await run(uninstaller, ['/S', `_?=${install}`], project)
  await ps(
    `if(Test-Path ${quote(join(install, `${binary}.exe`))}) { throw '卸载未删除程序' }; if(Test-Path ${quote(uninstallKey)}) { throw '卸载未清理登记项' }`
  )
  await writeFile(
    join(root, 'result.json'),
    JSON.stringify(
      { passed: true, id, payloadHash: createHash('sha256').update(installed).digest('hex') },
      null,
      2
    )
  )
  passed = true
  console.info(`原生安装界面验收通过，截图与日志：${root}`)
} finally {
  for (const child of active) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
  await ps(
    `Get-Process -Name ${quote(binary)} -ErrorAction SilentlyContinue | Stop-Process -Force; ${[uninstallKey, productKey, `HKCU:\\Software\\${manufacturer}`].map((key) => `if(Test-Path -LiteralPath ${quote(key)}) { Remove-Item -LiteralPath ${quote(key)} -Recurse -Force }`).join('; ')}`
  )
  if (passed) {
    for (const directory of [
      install,
      desktop,
      menu,
      join(root, 'roaming-data'),
      join(root, 'local-data')
    ]) {
      await rm(directory, { recursive: true, force: true })
    }
    await rm(build, { recursive: true, force: true })
  } else {
    console.error(`安装界面验收失败，现场：${root}；构建：${build}`)
  }
}
