import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = resolve(desktopRoot, '../..')
const buildRoot = resolve(process.argv[2] ?? '')
assert.equal(process.platform, 'win32', '安装迁移验收仅支持 Windows')
assert.ok(process.argv[2], '请传入已经完成 tauri build 的 Cargo 产物目录')
const generatedRoot = join(buildRoot, 'i686-pc-windows-msvc/release/nsis/x86')
const makensis = join(buildRoot, '.tauri/NSIS/makensis.exe')
const template = await readFile(join(generatedRoot, 'installer.nsi'), 'utf8')
const hook = await readFile(join(desktopRoot, 'src-tauri/installer-hooks.nsh'), 'utf8')
const id = `migration-${process.pid}-${Date.now()}`
const root = join(projectRoot, 'temp/run/desktop-installer', id)
await mkdir(root, { recursive: true })
let commandIndex = 0

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`
}

async function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd: generatedRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024
  })
  await writeFile(
    join(root, `command-${++commandIndex}.log`),
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  )
  if (result.error) throw result.error
  if (!allowFailure)
    assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`)
  return result
}

async function powershell(command) {
  return run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop'; ${command}`
  ])
}

function define(source, name, value) {
  const pattern = new RegExp(`^!define ${name} ".*"`, 'm')
  assert.match(source, pattern)
  return source.replace(pattern, () => `!define ${name} "${value}"`)
}

async function registryExists(key) {
  const result = await powershell(`if(Test-Path ${quote(key)}) { 'yes' } else { 'no' }`)
  return result.stdout.trim() === 'yes'
}

async function scenario(name, prepare, { sameProduct = false, previousArchitecture = 'x86' } = {}) {
  if (process.env.DESKTOP_INSTALLER_SCOPE && !name.includes(process.env.DESKTOP_INSTALLER_SCOPE))
    return
  const directory = join(root, name)
  const oldName = `Pi Desk Legacy Fixture ${id}-${name}`
  const newName = sameProduct ? oldName : `Pi Desk Current Fixture ${id}-${name}`
  const oldBinary = `legacy-fixture-${id}-${name}`
  const newBinary = sameProduct ? oldBinary : `current-fixture-${id}-${name}`
  const oldDirectory = join(directory, 'legacy')
  const currentDirectory = sameProduct ? oldDirectory : join(directory, 'current')
  const desktop = join(directory, 'desktop')
  const startMenu = join(directory, 'start-menu')
  const data = join(directory, 'data')
  const oldKey = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${oldName}`
  const currentKey = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${newName}`
  const hookFile = join(directory, 'installer-hooks.nsh')
  let passed = false
  await mkdir(desktop, { recursive: true })
  await mkdir(startMenu, { recursive: true })
  await mkdir(join(data, 'roaming'), { recursive: true })
  await mkdir(join(data, 'local'), { recursive: true })
  await writeFile(join(data, 'roaming/config.json'), '{"keep":"configuration"}')
  await writeFile(join(data, 'local/session.jsonl'), 'keep-session\n')
  const oldShortcut = join(desktop, `${oldName}.lnk`)
  const isolatePaths = (source) =>
    source
      .replaceAll('$DESKTOP', desktop)
      .replaceAll('$SMPROGRAMS', startMenu)
      .replaceAll('$APPDATA\\${BUNDLEID}', join(data, 'roaming'))
      .replaceAll('$LOCALAPPDATA\\${BUNDLEID}', join(data, 'local'))
  let fixtureHook = define(
    hook,
    'LEGACY_NAME',
    sameProduct ? `Unused Legacy Fixture ${id}` : oldName
  )
  fixtureHook = define(fixtureHook, 'LEGACY_BINARY', `${oldBinary}.exe`)
  await writeFile(hookFile, isolatePaths(fixtureHook))

  async function compile(productName, binaryName, withHook, architecture, version) {
    const binary = join(directory, `${binaryName}.exe`)
    await writeFile(binary, `fixture-program-not-executed-${architecture}`)
    let source = template.replace(
      /^!include ".*installer-hooks\.nsh"\r?$/m,
      withHook ? `!include "${hookFile}"` : ''
    )
    for (const [key, value] of Object.entries({
      ARCH: architecture,
      VERSION: version,
      VERSIONWITHBUILD: `${version}.0`,
      PRODUCTNAME: productName,
      STARTMENUFOLDER: productName,
      MAINBINARYNAME: binaryName,
      MAINBINARYSRCPATH: binary,
      BUNDLEID: `com.jetcrab.fixture.${id}.${name}`,
      OUTFILE: join(directory, `${binaryName}-${architecture}-setup.exe`)
    }))
      source = define(source, key, value)
    source = isolatePaths(source)
    const script = join(directory, `${binaryName}-${architecture}.nsi`)
    await writeFile(script, source)
    await run(makensis, ['/V2', '/NOCD', script])
    return join(directory, `${binaryName}-${architecture}-setup.exe`)
  }

  try {
    const oldInstaller = await compile(oldName, oldBinary, false, previousArchitecture, '0.3.21')
    const newInstaller = await compile(newName, newBinary, true, 'x86', '0.3.22')
    const installOld = async () => run(oldInstaller, ['/S', `/D=${oldDirectory}`])
    const fixture = {
      directory,
      oldDirectory,
      currentDirectory,
      oldName,
      oldBinary,
      oldKey,
      oldShortcut,
      installOld
    }
    const expectation = await prepare(fixture)
    const result = await run(
      newInstaller,
      sameProduct ? ['/S'] : ['/S', `/D=${currentDirectory}`],
      true
    )
    assert.equal(
      await readFile(join(data, 'roaming/config.json'), 'utf8'),
      '{"keep":"configuration"}'
    )
    assert.equal(await readFile(join(data, 'local/session.jsonl'), 'utf8'), 'keep-session\n')
    if (expectation === 'reject') {
      assert.notEqual(result.status, 0, '迁移失败必须中止新安装')
      assert.ok(existsSync(join(oldDirectory, `${oldBinary}.exe`)))
      assert.ok(await registryExists(oldKey))
      assert.ok(!existsSync(join(currentDirectory, `${newBinary}.exe`)))
    } else {
      assert.equal(result.status, 0)
      assert.ok(await registryExists(currentKey))
      if (!sameProduct) assert.ok(!(await registryExists(oldKey)))
      if (!sameProduct) assert.ok(!existsSync(join(oldDirectory, `${oldBinary}.exe`)))
      assert.equal(
        await readFile(join(currentDirectory, `${newBinary}.exe`), 'utf8'),
        'fixture-program-not-executed-x86',
        '原安装目录必须被新版32位内容替换'
      )
      assert.ok(existsSync(join(desktop, `${newName}.lnk`)))
      assert.equal(existsSync(oldShortcut), sameProduct || expectation === 'keep-custom-shortcut')
      if (!sameProduct) assert.ok(!existsSync(join(startMenu, oldName, `${oldName}.lnk`)))
      if (expectation === 'keep-custom-shortcut') {
        const target = await powershell(
          `$s=New-Object -ComObject WScript.Shell; $s.CreateShortcut(${quote(oldShortcut)}).TargetPath`
        )
        assert.equal(
          target.stdout.trim().toLowerCase(),
          join(process.env.WINDIR, 'notepad.exe').toLowerCase()
        )
      }
    }
    passed = true
    console.info(`通过：${name}`)
  } finally {
    // 测试只清理本次唯一名称的注册项，文件在项目独立运行目录中。
    const keys = [
      oldKey,
      currentKey,
      `HKCU:\\Software\\jetcrab\\${oldName}`,
      `HKCU:\\Software\\jetcrab\\${newName}`
    ]
    await powershell(
      keys
        .map((key) => `if(Test-Path ${quote(key)}) { Remove-Item ${quote(key)} -Recurse -Force }`)
        .join('; ')
    )
    if (passed) await rm(directory, { recursive: true, force: true })
  }
}

try {
  await scenario('new-install', async () => 'success')
  await scenario('rename-migration', async ({ installOld }) => {
    await installOld()
    return 'success'
  })
  await scenario(
    'x64-to-x86-upgrade',
    async ({ installOld }) => {
      await installOld()
      return 'success'
    },
    { sameProduct: true, previousArchitecture: 'x64' }
  )
  await scenario(
    'x64-legacy-migration',
    async ({ installOld }) => {
      await installOld()
      return 'success'
    },
    { previousArchitecture: 'x64' }
  )
  await scenario('custom-shortcut', async ({ installOld, oldShortcut }) => {
    await installOld()
    await powershell(
      `$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut(${quote(oldShortcut)}); $l.TargetPath=${quote(join(process.env.WINDIR, 'notepad.exe'))}; $l.Save()`
    )
    return 'keep-custom-shortcut'
  })
  await scenario('unknown-installation', async ({ installOld, oldKey }) => {
    await installOld()
    await powershell(
      `Set-ItemProperty ${quote(oldKey)} -Name Publisher -Value 'unknown-fixture-publisher'`
    )
    return 'reject'
  })
  await scenario('uninstall-failure', async ({ installOld, directory, oldDirectory }) => {
    await installOld()
    const script = join(directory, 'failed-uninstaller.nsi')
    const executable = join(directory, 'failed-uninstaller.exe')
    await writeFile(
      script,
      `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${executable}"\nSection\nSetErrorLevel 9\nQuit\nSectionEnd\n`
    )
    await run(makensis, ['/V2', '/NOCD', script])
    await copyFile(executable, join(oldDirectory, 'uninstall.exe'))
    return 'reject'
  })
  await rm(root, { recursive: true, force: true })
  console.info('安装迁移验收通过；所有测试注册项和运行文件已清理。')
} catch (error) {
  console.error(`安装迁移验收失败，现场：${root}`)
  throw error
}
