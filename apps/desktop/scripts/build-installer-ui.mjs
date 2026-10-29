import { spawnSync } from 'node:child_process'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const source = resolve(dirname(script), '../src-tauri/installer-ui')
const outputArgument = process.argv[2]

if (!outputArgument) {
  throw new Error('缺少安装界面 DLL 输出目录参数。')
}
if (process.platform !== 'win32') {
  throw new Error('安装界面 DLL 需要在 Windows 上使用 MSVC 构建。')
}

const output = resolve(outputArgument)
const dll = resolve(output, 'PiDeskUI.dll')
const cpp = resolve(source, 'installer-ui.cpp')
const rc = resolve(source, 'installer-ui.rc')
const def = resolve(source, 'installer-ui.def')
const headers = (await readdir(source))
  .filter((name) => /\.h(pp)?$/i.test(name))
  .map((name) => resolve(source, name))
const inputs = [script, cpp, rc, def, ...headers, resolve(source, '../icons/128x128@2x.png')]
const newestInput = Math.max(
  ...(await Promise.all(inputs.map((input) => stat(input)))).map((entry) => entry.mtimeMs)
)
let cached = false
try {
  cached = (await stat(dll)).mtimeMs >= newestInput
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error
  }
}
if (cached) {
  console.log(`安装界面 DLL 输入未变化，复用：${dll}`)
} else {
  await build()
}

async function build() {
  const vswhere = resolve(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe'
  )
  const installation = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
      '-utf8'
    ],
    { encoding: 'utf8', windowsHide: true }
  )
  if (installation.error || installation.status !== 0 || !installation.stdout.trim()) {
    throw new Error('找不到可用的 MSVC x86 编译工具，请安装 Visual Studio C++ 桌面开发工具。', {
      cause:
        installation.error ||
        new Error(installation.stderr || `vswhere 退出码：${installation.status}`)
    })
  }
  const vcvars = resolve(installation.stdout.trim(), 'VC/Auxiliary/Build/vcvarsall.bat')
  const commandFile = resolve(output, 'build-installer-ui.cmd')
  const resource = resolve(output, 'installer-ui.res')
  const object = resolve(output, 'installer-ui.obj')
  const commands = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'chcp 65001',
    `call "${vcvars}" x86`,
    'if errorlevel 1 exit /b %errorlevel%',
    `rc.exe /nologo /c65001 /fo "${resource}" "${rc}"`,
    'if errorlevel 1 exit /b %errorlevel%',
    `cl.exe /nologo /LD /MT /O1 /W4 /EHsc /std:c++17 /utf-8 /DNDEBUG /Fo"${object}" /Fd"${resolve(output, 'installer-ui.pdb')}" "${cpp}" "${resource}" /link /DEF:"${def}" /OUT:"${dll}" /IMPLIB:"${resolve(output, 'PiDeskUI.lib')}" /MACHINE:X86 /OPT:REF /OPT:ICF /INCREMENTAL:NO user32.lib gdi32.lib gdiplus.lib comctl32.lib shell32.lib ole32.lib dwmapi.lib uuid.lib`,
    'exit /b %errorlevel%'
  ]
  await mkdir(output, { recursive: true })
  await writeFile(commandFile, `${commands.join('\r\n')}\r\n`, 'utf8')
  await rm(dll, { force: true })
  console.log(`正在构建 Unicode x86 安装界面 DLL：${dll}`)
  const result = spawnSync(
    process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', `""${commandFile}""`],
    {
      cwd: source,
      stdio: 'inherit',
      windowsHide: true,
      windowsVerbatimArguments: true
    }
  )
  if (result.error || result.status !== 0) {
    await rm(dll, { force: true })
    throw new Error(`安装界面 DLL 编译失败，退出码：${result.status}`, { cause: result.error })
  }
  await stat(dll)
  console.log(`安装界面 DLL 构建完成：${dll}`)
}
