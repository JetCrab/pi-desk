import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function packageClient({ platform, unsigned = false, version, source, output }) {
  if (!['windows', 'android'].includes(platform)) {
    throw new Error(`不支持的客户端平台：${platform}`)
  }
  if (
    typeof version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version !== version.trim()
  ) {
    throw new Error('客户端版本必须是正式 SemVer x.y.z')
  }
  if (unsigned && platform !== 'android') {
    throw new Error('unsigned 仅适用于 Android')
  }
  const sourceInfo = await stat(source)
  if (!sourceInfo.isFile() || sourceInfo.size === 0) {
    throw new Error('客户端安装文件必须是非空文件')
  }
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length !== 0) {
    throw new Error('客户端输出目录必须为空')
  }
  const filename =
    platform === 'windows'
      ? `pi-desk-windows-${version}-x86-setup.exe`
      : `pi-desk-android-${version}${unsigned ? '-unsigned' : ''}.apk`
  const destination = join(output, filename)
  await copyFile(source, destination)
  const sha256 = createHash('sha256')
    .update(await readFile(destination))
    .digest('hex')
  await writeFile(join(output, 'release.json'), `${JSON.stringify({ version, sha256 }, null, 2)}\n`)
}

async function main() {
  const [platform, source, output, ...flags] = process.argv.slice(2)
  if (!source || !output || flags.some((flag) => flag !== '--unsigned') || flags.length > 1) {
    throw new Error('用法：pack-client.mjs <windows|android> <source> <output> [--unsigned]')
  }
  if (!['windows', 'android'].includes(platform)) {
    throw new Error(`不支持的客户端平台：${platform}`)
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const version =
    platform === 'windows'
      ? JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version
      : (await readFile(join(root, 'apps/android/app/build.gradle.kts'), 'utf8')).match(
          /^\s*versionName\s*=\s*"([^"]+)"/m
        )?.[1]
  await packageClient({ platform, unsigned: flags.includes('--unsigned'), version, source, output })
  console.log(`已归档 ${platform} ${version}：${output}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
