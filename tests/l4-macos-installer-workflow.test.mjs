import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'

const root = new URL('../', import.meta.url)
const workflow = parse(await readFile(new URL('.github/workflows/release-apple.yml', root), 'utf8'))
const manifest = JSON.parse(await readFile(new URL('apps/desktop/package.json', root), 'utf8'))
const steps = workflow.jobs.macos.steps
const build = steps.find((step) => step.run?.includes('exec tauri build'))
const verification = steps.find((step) => step.run?.includes('pack-client.mjs'))

function runBash(script) {
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.ifError(result.error)
  return result
}

test('本地与 CI 使用 Tauri 标准通用 DMG，iOS 保留独立构建流程', () => {
  assert.equal(
    manifest.scripts['build:mac'],
    'tauri build --target universal-apple-darwin --bundles dmg'
  )
  assert.equal(manifest.scripts['test:installer:mac'], undefined)
  assert.match(build.run, /--target universal-apple-darwin --bundles dmg/)
  assert.doesNotMatch(
    steps.map((step) => step.run ?? '').join('\n'),
    /build-macos-installer|test:installer:mac|bundle\/installer-macos/
  )
  assert.equal(workflow.jobs.macos.if, "inputs.platform == 'all' || inputs.platform == 'macos'")
  assert.equal(workflow.jobs.ios.if, "inputs.platform == 'all' || inputs.platform == 'ios'")
  assert.ok(
    workflow.jobs.ios.steps.some((step) => step.run === 'bash .github/scripts/build-ios.sh')
  )
  assert.equal(manifest.scripts['build'], 'tauri build --target i686-pc-windows-msvc')
  assert.equal(
    manifest.scripts['build:linux'],
    'tauri build --target x86_64-unknown-linux-gnu --bundles appimage'
  )
})

test('macOS 构建使用同批资源执行托管进程和端口回归', () => {
  const regression = steps.find((step) => step.run?.includes('cargo test'))
  assert.ok(regression)
  assert.match(regression.run, /export TAURI_CONFIG=/)
  assert.match(regression.run, /CARGO_TARGET_DIR.*tauri-ci\.json/)
  assert.match(regression.run, /cargo test --locked .* process:: -- --test-threads=1/)
  assert.match(regression.run, /cargo test --locked .* service_port:: -- --test-threads=1/)
})

test('挂载最终 DMG 后验证主应用、真实 Applications 目标、版本、双架构与签名', () => {
  assert.match(verification.run, /bundle\/dmg\//)
  assert.match(verification.run, /hdiutil attach .* -readonly .* -mountpoint "\$mountpoint"/)
  assert.match(verification.run, /app="\$mountpoint\/Pi Desk\.app"/)
  assert.match(verification.run, /test -d "\$app"/)
  assert.match(verification.run, /test -L "\$mountpoint\/Applications"/)
  assert.match(
    verification.run,
    /test "\$\(readlink "\$mountpoint\/Applications"\)" = "\/Applications"/
  )
  assert.match(verification.run, /Print :CFBundleIdentifier.* = "com\.jetcrab\.desktop"/)
  assert.match(verification.run, /Print :CFBundleShortVersionString.* = "\$version"/)
  assert.match(
    verification.run,
    /lipo "\$app\/Contents\/MacOS\/\$executable" -verify_arch arm64 x86_64/
  )
  assert.match(verification.run, /codesign --verify --deep --strict "\$app"/)
  assert.doesNotMatch(verification.run, /Pi Desk Installer|PayloadSHA256|PiDesk\.zip|ditto -x/)
})

test('CI 启用 Tauri Finder 布局并在最终 DMG 检查背景和 Finder 元数据', async () => {
  assert.equal(build.env?.TAURI_BUNDLER_DMG_IGNORE_CI, 'true')
  const config = JSON.parse(
    await readFile(new URL('apps/desktop/src-tauri/tauri.macos.conf.json', root), 'utf8')
  )
  assert.equal(config.bundle.macOS.dmg.background, 'dmg-background.png')
  assert.match(verification.run, /test -s "\$mountpoint\/\.DS_Store"/)
  assert.match(
    verification.run,
    /cmp .*dmg-background\.png.*"\$mountpoint\/\.background\/dmg-background\.png"/
  )
})

test('归档保留 DMG、签名后缀与 SHA，摘要在严格 shell 下输出拖拽步骤和版本', () => {
  assert.match(verification.run, /pack_args=\(macos "\$\{dmgs\[0\]\}" "\$CLIENT_OUTPUT"\)/)
  assert.match(verification.run, /suffix=adhoc/)
  assert.match(verification.run, /suffix=developer-id/)
  assert.match(verification.run, /pack_args\+=\(--developer-id\)/)
  assert.match(verification.run, /shasum -a 256 .*\.dmg > SHA256SUMS\.txt/)
  const summary = verification.run.match(/^\{\n([\s\S]*?)^\} >> "\$GITHUB_STEP_SUMMARY"/m)
  assert.ok(summary, '工作流应保留发布摘要')
  const result = runBash(`set -euo pipefail\nversion=1.2.3\nsuffix=adhoc\n${summary[1]}`)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /版本：1\.2\.3；架构：Apple Silicon \+ Intel/)
  assert.match(result.stdout, /Pi Desk\.app.*拖.*Applications/)
})

test('卸载 DMG 的 EXIT 清理保留原失败，清理自身失败也不能报告成功', () => {
  const cleanup = verification.run.match(/^(\w+)\(\) \{\n[\s\S]*?^\}\ntrap \1 EXIT/m)
  assert.ok(cleanup, '挂载后应注册 EXIT 清理')
  for (const [originalStatus, detachStatus, expectedStatus] of [
    [0, 0, 0],
    [23, 0, 23],
    [0, 17, 1],
    [23, 17, 23]
  ]) {
    const result = runBash(
      `set -euo pipefail\nmountpoint=/unused-dmg\nhdiutil() { return ${detachStatus}; }\n${cleanup[0]}\nexit ${originalStatus}`
    )
    assert.equal(
      result.status,
      expectedStatus,
      `原退出码 ${originalStatus}，卸载退出码 ${detachStatus}：${result.stderr}`
    )
  }
})
