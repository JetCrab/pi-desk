import { readFile } from 'node:fs/promises'

const release = JSON.parse(await readFile(new URL('../site-release.json', import.meta.url), 'utf8'))
const errors = []
const showcase = process.argv.includes('--showcase')

/** @returns {void} */
function checkUrl(value, label) {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      /(^|\.)(localhost|example\.(com|org|net))$/.test(url.hostname)
    ) {
      errors.push(`${label}必须使用正式 HTTPS 地址`)
    }
  } catch {
    errors.push(`${label}尚未填写有效地址`)
  }
}

checkUrl(release.siteUrl, '官网地址')
checkUrl(release.license?.url, '许可证')
if (!release.license?.name?.trim()) errors.push('许可证名称尚未填写')
const platforms = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android' }
for (const [platform, label] of Object.entries(platforms)) {
  const url = release.downloads[platform]
  if (url !== undefined || (platform === 'windows' && !showcase)) {
    checkUrl(url, `${label} 下载`)
  }
}
if (showcase) {
  if (release.installCommand !== null) {
    errors.push('仅发布客户端下载时，公开安装命令必须保持 null')
  }
  if (release.sourceUrl !== null) checkUrl(release.sourceUrl, '公开源码')
} else {
  checkUrl(release.sourceUrl, '公开源码')
  if (!release.installCommand?.trim() || /@jetcrab-private|<[^>]+>/.test(release.installCommand)) {
    errors.push('请填写已在干净环境验证的公开安装命令，不能沿用当前私有分发或占位内容')
  }
}
if (errors.length) {
  console.error(`官网尚不满足正式发布条件：\n${errors.map((error) => `- ${error}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(
    showcase
      ? '官网客户端下载资料检查通过；公开安装命令保持禁用，仍需人工验证下载、首次启动和链接可达性。'
      : '官网发布资料检查通过；仍需人工验证安装、首次启动、链接可达性及授权内容。'
  )
}
