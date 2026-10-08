import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32', '覆盖安装验收仅支持 Windows')
assert.ok(process.argv[2] && process.argv[3], '请传入生成的 installer.nsi 和 makensis.exe')
const generatedScript = resolve(process.argv[2])
const makensis = resolve(process.argv[3])
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const id = `overwrite-${process.pid}-${Date.now()}`
const root = join(project, 'temp/run/desktop-installer', id)
const template = await readFile(generatedScript, 'utf8')
const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework/v4.0.30319/csc.exe')
await mkdir(root, { recursive: true })
let commandIndex = 0
const active = new Set()

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function start(command, args, timeout = 120_000) {
  const child = spawn(command, args, {
    cwd: dirname(generatedScript),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (data) => (output += data))
  child.stderr.on('data', (data) => (output += data))
  const log = join(root, `command-${++commandIndex}.log`)
  let timedOut = false
  const result = new Promise((resolveRun, rejectRun) => {
    const timer = setTimeout(() => {
      timedOut = true
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    }, timeout)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      active.delete(handle)
      writeFile(log, output).then(() => {
        if (timedOut) rejectRun(new Error(`命令超时：${command}`))
        else resolveRun({ code, output })
      }, rejectRun)
    })
  })
  const handle = { child, result }
  active.add(handle)
  // 长期测试进程的结果由场景稍后读取，提前退出时也保留原始错误。
  result.catch(() => {})
  return handle
}

async function run(command, args) {
  const result = await start(command, args).result
  assert.equal(result.code, 0, `${command}: ${result.output}`)
  return result
}

async function powershell(command) {
  return run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop'; ${command}`
  ])
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 15_000
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `等待超时：${description}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
}

function define(source, key, value) {
  const pattern = new RegExp(`^!define ${key} ".*"`, 'm')
  assert.match(source, pattern)
  return source.replace(pattern, () => `!define ${key} "${value}"`)
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function scenario(name, { sameVersion = false, mode = null, reject = false } = {}) {
  const directory = join(root, name)
  const product = `Pi Desk Fixture ${id}-${name}`
  const binary = `fixture-${id}-${name}`
  const install = join(directory, 'custom-install')
  const data = join(directory, 'data')
  const manufacturer = `PiDeskFixture-${id}`
  const productKey = `HKCU:\\Software\\${manufacturer}\\${product}`
  const uninstallKey = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}`
  const installedBinary = join(install, `${binary}.exe`)
  const marker = (file) => join(install, file)
  let running
  let passed = false
  let failure
  await mkdir(data, { recursive: true })
  await mkdir(join(directory, 'desktop'), { recursive: true })
  await mkdir(join(directory, 'start-menu'), { recursive: true })
  await writeFile(join(data, 'config.json'), '{"keep":"configuration"}')
  await writeFile(join(data, 'session.jsonl'), 'keep-session\n')

  const fixture = `
using System;
using System.IO;
using System.Reflection;
using System.Threading;
public class Fixture {
  public static int Main(string[] args) {
    string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    if (args.Length > 0 && args[0] == "--exit-for-update") {
      if (File.Exists(Path.Combine(root, "mode")) && File.ReadAllText(Path.Combine(root, "mode")) != "ignore") {
        File.WriteAllText(Path.Combine(root, "exit-requested"), "yes");
      }
      return 0;
    }
    if (args.Length > 0 && args[0] == "--lock") {
      using (FileStream held = new FileStream(args[1], FileMode.Open, FileAccess.Read, FileShare.Read)) {
        File.WriteAllText(Path.Combine(root, "ready"), "locked");
        while (!File.Exists(Path.Combine(root, "manual-exit"))) Thread.Sleep(25);
      }
      return 0;
    }
    File.WriteAllText(Path.Combine(root, "ready"), "PAYLOAD");
    while (!File.Exists(Path.Combine(root, "exit-requested")) && !File.Exists(Path.Combine(root, "manual-exit"))) Thread.Sleep(25);
    if (File.Exists(Path.Combine(root, "mode")) && File.ReadAllText(Path.Combine(root, "mode")) == "busy") Thread.Sleep(1500);
    File.WriteAllText(Path.Combine(root, "cleanup-complete"), "PAYLOAD");
    return 0;
  }
}`

  async function compile(payload, version) {
    const input = join(directory, payload)
    await mkdir(input, { recursive: true })
    const executable = join(input, `${binary}.exe`)
    const source = join(input, 'fixture.cs')
    await writeFile(source, fixture.replaceAll('PAYLOAD', payload))
    await run(compiler, ['/nologo', '/target:exe', '/platform:x86', `/out:${executable}`, source])
    let script = template
    for (const [key, value] of Object.entries({
      PRODUCTNAME: product,
      STARTMENUFOLDER: product,
      MANUFACTURER: manufacturer,
      MAINBINARYNAME: binary,
      MAINBINARYSRCPATH: executable,
      BUNDLEID: `com.jetcrab.fixture.${id}.${name}`,
      VERSION: version,
      VERSIONWITHBUILD: `${version}.0`,
      OUTFILE: join(input, 'setup.exe')
    })) {
      script = define(script, key, value)
    }
    script = script
      .replaceAll('$DESKTOP', join(directory, 'desktop'))
      .replaceAll('$SMPROGRAMS', join(directory, 'start-menu'))
      .replaceAll('$APPDATA\\${BUNDLEID}', data)
      .replaceAll('$LOCALAPPDATA\\${BUNDLEID}', data)
    const installerScript = join(input, 'installer.nsi')
    await writeFile(installerScript, script)
    await run(makensis, ['/V2', '/NOCD', installerScript])
    return { setup: join(input, 'setup.exe'), bytes: await readFile(executable) }
  }

  try {
    const oldVersion = sameVersion ? '1.0.1' : '1.0.0'
    const previous = await compile('previous', oldVersion)
    const current = await compile('current', '1.0.1')
    if (name !== 'first-install') {
      await run(previous.setup, ['/S', `/D=${install}`])
      // 若覆盖流程误调用旧卸载器，安装必须失败，而不是误删数据后继续。
      await writeFile(marker('uninstall.exe'), 'not-an-uninstaller')
    }
    if (mode) {
      await writeFile(marker('mode'), mode)
      if (mode === 'locked') {
        const locker = marker(`${binary}-locker.exe`)
        await copyFile(installedBinary, locker)
        running = start(locker, ['--lock', installedBinary], 180_000)
      } else {
        running = start(installedBinary, [], 180_000)
      }
      await waitFor(() => existsSync(marker('ready')), '测试程序准备完成')
    }
    const installation = start(
      current.setup,
      name === 'first-install' ? ['/S', `/D=${install}`] : ['/S']
    )
    if (mode === 'busy') {
      await waitFor(() => existsSync(marker('exit-requested')), '收到正常退出请求')
      assert.equal(hash(await readFile(installedBinary)), hash(previous.bytes))
      assert.ok(!existsSync(marker('cleanup-complete')), '清理尚未完成时不得替换程序')
    }
    const result = await installation.result
    const versionResult = await powershell(
      `(Get-ItemProperty -LiteralPath ${quote(uninstallKey)}).DisplayVersion`
    )
    if (reject) {
      assert.notEqual(result.code, 0, '未退出或文件被占用时安装必须失败')
      assert.equal(hash(await readFile(installedBinary)), hash(previous.bytes))
      assert.equal(versionResult.output.trim(), oldVersion)
      assert.equal(running.child.exitCode, null, '安装器不得强制终止旧进程')
    } else {
      assert.equal(result.code, 0, result.output)
      assert.equal(hash(await readFile(installedBinary)), hash(current.bytes))
      assert.equal(versionResult.output.trim(), '1.0.1')
      assert.equal((await readFile(marker('uninstall.exe'))).subarray(0, 2).toString(), 'MZ')
      if (running) {
        assert.equal((await running.result).code, 0)
        assert.equal(await readFile(marker('cleanup-complete'), 'utf8'), 'previous')
      }
    }
    assert.equal(await readFile(join(data, 'config.json'), 'utf8'), '{"keep":"configuration"}')
    assert.equal(await readFile(join(data, 'session.jsonl'), 'utf8'), 'keep-session\n')
    passed = true
    console.info(`通过：${name}`)
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      if (running && running.child.exitCode === null) {
        await writeFile(marker('manual-exit'), 'yes')
        await running.result
      }
      for (const handle of [...active]) {
        if (handle.child.exitCode === null) {
          spawnSync('taskkill.exe', ['/PID', String(handle.child.pid), '/T', '/F'], {
            windowsHide: true
          })
        }
        await handle.result.catch(() => {})
      }
      await powershell(
        [uninstallKey, productKey]
          .map(
            (key) =>
              `if(Test-Path -LiteralPath ${quote(key)}) { Remove-Item -LiteralPath ${quote(key)} -Recurse -Force }`
          )
          .join('; ')
      )
      await powershell(
        `if(Test-Path -LiteralPath ${quote(`HKCU:\\Software\\${manufacturer}`)}) { Remove-Item -LiteralPath ${quote(`HKCU:\\Software\\${manufacturer}`)} -ErrorAction SilentlyContinue }`
      )
      if (passed) await rm(directory, { recursive: true, force: true })
    } catch (error) {
      if (!failure) throw error
      console.error(`清理测试现场失败：${error.message}`)
    }
  }
}

try {
  await scenario('first-install')
  await scenario('same-version', { sameVersion: true })
  await scenario('upgrade-custom-directory')
  await scenario('running-graceful', { mode: 'graceful' })
  await scenario('busy-graceful', { mode: 'busy' })
  await scenario('old-unresponsive', { mode: 'ignore', reject: true })
  await scenario('locked-file', { mode: 'locked', reject: true })
  await rm(root, { recursive: true, force: true })
  console.info('覆盖安装验收通过；测试程序、注册项和运行文件已清理。')
} catch (error) {
  console.error(`覆盖安装验收失败，现场：${root}`)
  throw error
}
