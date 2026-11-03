import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildMacosInstaller } from '../scripts/build-macos-installer.mjs'

export async function testInstallerPackage(root, desktop) {
  const run = (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000
    }).trim()
  const { version } = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
  const app = join(root, 'package-fixture/Pi Desk.app')
  const contents = join(app, 'Contents')
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await mkdir(join(contents, 'Resources'), { recursive: true })
  // 只验证制品组装，不运行这个测试应用，也不从真实安装复制主程序。
  const source = join(root, 'fixture.swift')
  await writeFile(
    source,
    'print("Pi Desk installer packaging fixture; not the real application")\n'
  )
  const slices = []
  for (const arch of ['arm64', 'x86_64']) {
    const slice = join(root, `fixture-${arch}`)
    run('/usr/bin/xcrun', [
      'swiftc',
      '-target',
      `${arch}-apple-macosx11.0`,
      '-module-cache-path',
      join(root, 'module-cache'),
      source,
      '-o',
      slice
    ])
    slices.push(slice)
  }
  run('/usr/bin/lipo', ['-create', ...slices, '-output', join(contents, 'MacOS/pi-desk-desktop')])
  const iconset = join(root, 'Fixture.iconset')
  await mkdir(iconset)
  await copyFile(join(desktop, 'src-tauri/icons/128x128@2x.png'), join(iconset, 'icon_256x256.png'))
  await copyFile(join(desktop, 'src-tauri/icons/icon.png'), join(iconset, 'icon_256x256@2x.png'))
  run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(contents, 'Resources/Fixture.icns')])
  await writeFile(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.jetcrab.desktop</string>
<key>CFBundleExecutable</key><string>pi-desk-desktop</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleIconFile</key><string>Fixture.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>\n`
  )
  run('/usr/bin/codesign', ['--force', '--sign', '-', app])
  const { dmg } = await buildMacosInstaller({ app, output: join(root, 'package-output') })
  const mount = join(root, 'mounted')
  await mkdir(mount)
  run('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount])
  try {
    const installer = join(mount, 'Pi Desk Installer.app')
    assert.ok((await readdir(mount)).includes('Pi Desk Installer.app'))
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installer])
    run('/usr/bin/lipo', [
      join(installer, 'Contents/MacOS/PiDeskInstaller'),
      '-verify_arch',
      'arm64',
      'x86_64'
    ])
    const plist = join(installer, 'Contents/Info.plist')
    const read = (key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])
    assert.equal(read('CFBundleShortVersionString'), version)
    const archive = join(installer, 'Contents/Resources/PiDesk.zip')
    assert.equal(
      createHash('sha256')
        .update(await readFile(archive))
        .digest('hex'),
      read('PayloadSHA256')
    )
    const unpacked = join(root, 'unpacked-package')
    run('/usr/bin/ditto', ['-x', '-k', archive, unpacked])
    const payload = join(unpacked, 'Pi Desk.app')
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', payload])
    run('/usr/bin/lipo', [
      join(payload, 'Contents/MacOS/pi-desk-desktop'),
      '-verify_arch',
      'arm64',
      'x86_64'
    ])
  } finally {
    run('/usr/bin/hdiutil', ['detach', mount])
  }
  await assert.rejects(
    buildMacosInstaller({ app, output: join(root, 'package-output') }),
    /必须为空/
  )
  console.log(
    'PASS 通用离线安装器 DMG、双架构、ad-hoc 签名、内置包校验与拒绝混入旧制品（主应用为隔离 fixture）'
  )
}
