import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000
  }).trim()
}

function plistValue(app, key) {
  return run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Contents/Info.plist')])
}

function xml(value) {
  return String(value).replace(
    /[<>&"']/g,
    (character) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;'
      })[character]
  )
}

export async function buildMacosInstaller({
  app,
  output,
  identity = '-',
  architectures = ['arm64', 'x86_64']
}) {
  assert.equal(process.platform, 'darwin', 'macOS 安装器必须在 macOS 上构建')
  app = resolve(app)
  output = resolve(output)
  assert.ok(output !== app && !output.startsWith(`${app}/`), '输出目录不能位于主应用内')
  const { version } = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
  assert.equal(plistValue(app, 'CFBundleIdentifier'), 'com.jetcrab.desktop', '主应用身份不正确')
  assert.equal(plistValue(app, 'CFBundleShortVersionString'), version, '主应用版本与桌面清单不一致')
  assert.ok(
    architectures.length > 0 && architectures.every((arch) => ['arm64', 'x86_64'].includes(arch))
  )
  const executable = plistValue(app, 'CFBundleExecutable')
  assert.equal(executable, 'pi-desk-desktop', '主应用可执行入口不正确')
  run('/usr/bin/lipo', [join(app, 'Contents/MacOS', executable), '-verify_arch', ...architectures])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  await mkdir(output, { recursive: true })
  assert.equal((await readdir(output)).length, 0, '安装器输出目录必须为空，避免混入旧制品')
  const media = join(output, 'media')
  const installer = join(media, 'Pi Desk Installer.app')
  const resources = join(installer, 'Contents/Resources')
  const binaries = join(installer, 'Contents/MacOS')
  await mkdir(resources, { recursive: true })
  await mkdir(binaries, { recursive: true })
  const archive = join(resources, 'PiDesk.zip')
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive])
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  const iconName = plistValue(app, 'CFBundleIconFile')
  const icon = iconName.endsWith('.icns') ? iconName : `${iconName}.icns`
  await copyFile(join(app, 'Contents/Resources', icon), join(resources, 'AppIcon.icns'))
  await writeFile(
    join(installer, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.jetcrab.desktop.installer</string>
<key>CFBundleName</key><string>Pi Desk Installer</string>
<key>CFBundleDisplayName</key><string>Pi Desk 安装器</string>
<key>CFBundleExecutable</key><string>PiDeskInstaller</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${xml(version)}</string>
<key>CFBundleVersion</key><string>${xml(version)}</string>
<key>CFBundleIconFile</key><string>AppIcon.icns</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>PayloadSHA256</key><string>${sha256}</string>
<key>PayloadBundleIdentifier</key><string>com.jetcrab.desktop</string>
</dict></plist>
`
  )
  const source = join(desktop, 'installer-macos')
  const sources = ['l4-installer-engine.swift', 'l2-installer-window.swift', 'main.swift'].map(
    (file) => join(source, file)
  )
  const slices = []
  for (const arch of architectures) {
    const slice = join(output, `installer-${arch}`)
    run('/usr/bin/xcrun', [
      'swiftc',
      '-swift-version',
      '5',
      '-warnings-as-errors',
      '-O',
      '-target',
      `${arch}-apple-macosx11.0`,
      '-module-cache-path',
      join(output, 'module-cache'),
      ...sources,
      '-o',
      slice
    ])
    slices.push(slice)
  }
  const binary = join(binaries, 'PiDeskInstaller')
  run('/usr/bin/lipo', ['-create', ...slices, '-output', binary])
  run('/usr/bin/strip', ['-x', binary])
  const signing = ['--force', '--sign', identity]
  if (identity !== '-') signing.push('--options', 'runtime', '--timestamp')
  run('/usr/bin/codesign', [...signing, installer])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installer])
  run('/usr/bin/lipo', [binary, '-verify_arch', ...architectures])
  const dmg = join(output, `PiDesk-${version}-Installer.dmg`)
  run('/usr/bin/hdiutil', [
    'create',
    '-volname',
    'Pi Desk 安装器',
    '-srcfolder',
    media,
    '-format',
    'UDZO',
    dmg
  ])
  run('/usr/bin/hdiutil', ['verify', dmg])
  assert.ok((await stat(dmg)).size > 0)
  console.log(
    `macOS 离线安装器已生成：${dmg}（${identity === '-' ? 'ad-hoc' : 'Developer ID'}，未公证）`
  )
  return { dmg, installer }
}

async function main() {
  const [appArgument, outputArgument, ...extra] = process.argv.slice(2)
  assert.equal(extra.length, 0, '用法：build-macos-installer.mjs [Pi Desk.app] [输出目录]')
  const target = resolve(
    desktop,
    process.env.CARGO_TARGET_DIR || '../../temp/build/desktop-rust/local'
  )
  const release = join(target, 'universal-apple-darwin/release')
  const outputRoot = join(release, 'bundle/installer-macos')
  await mkdir(outputRoot, { recursive: true })
  await buildMacosInstaller({
    app: appArgument || join(release, 'bundle/macos/Pi Desk.app'),
    output: outputArgument || (await mkdtemp(join(outputRoot, 'run-'))),
    identity: process.env.APPLE_SIGNING_IDENTITY || '-'
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.stderr?.toString() || error.stack)
    process.exitCode = 1
  })
}
