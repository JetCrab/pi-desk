import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

/** @returns {Promise<string | null>} */
async function readExisting(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** @returns {string} */
function downloadUrl(repository, tag, file) {
  assert.ok(typeof file === 'string' && file && !/[\\/]/u.test(file), '下载文件名无效')
  assert.ok(file !== '.' && file !== '..', '下载文件名无效')
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`
}

/** @returns {Promise<{ changelogPath: string, recordPath: string, siteReleasePath: string }>} */
export async function syncRelease({ websiteRoot, record, repository, markdown }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/u, 'GitHub 仓库名称无效')
  assert.ok(
    repository.split('/').every((part) => part !== '.' && part !== '..'),
    'GitHub 仓库名称无效'
  )
  assert.match(record.tag, /^[\w.-]+$/u, '发布标签无效')
  assert.ok(Number.isSafeInteger(record.date) && record.date > 0, '发布日期无效')
  assert.ok(
    typeof markdown === 'string' && /^##\s+\S/u.test(markdown),
    '更新日志必须以批次标题开始'
  )

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(record.date))
      .map(({ type, value }) => [type, value])
  )
  const timestamp = `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}${parts.second}`
  const directory = path.join(websiteRoot, 'content/changelog')
  await mkdir(directory, { recursive: true })
  const matches = (await readdir(directory)).filter(
    (file) => file.endsWith(`-${record.tag}.md`) || file.endsWith(`-${record.tag}.json`)
  )
  const existingSlugs = [...new Set(matches.map((file) => file.replace(/\.(?:md|json)$/u, '')))]
  assert.ok(existingSlugs.length <= 1, `同标签存在多个发布记录：${record.tag}`)
  const slug = existingSlugs[0] ?? `${timestamp}-${record.tag}`
  const changelogPath = path.join(directory, `${slug}.md`)
  const recordPath = path.join(directory, `${slug}.json`)
  const siteReleasePath = path.join(websiteRoot, 'site-release.json')
  const release = JSON.parse(await readFile(siteReleasePath, 'utf8'))
  const mainPackage = record.packages.find((item) => item.name === '@jetcrab/pi-desk')
  if (mainPackage) {
    assert.match(mainPackage.version, /^\d+\.\d+\.\d+$/u, '主包必须使用正式版本')
    release.installCommand = `npm install -g @jetcrab/pi-desk@${mainPackage.version}`
  }
  if (release.installCommand) {
    release.installCommand = release.installCommand.replace(/ --registry=\S+/gu, '')
  }
  delete release.desktop
  delete release.androidUrl
  release.downloads = {}
  for (const client of record.clients) {
    if (['windows', 'macos', 'linux', 'android'].includes(client.platform)) {
      release.downloads[client.platform] = downloadUrl(repository, record.tag, client.file)
    }
  }

  const existingMarkdown = await readExisting(changelogPath)
  const existingRecord = await readExisting(recordPath)
  const payload = { repository, record }
  assert.ok(
    existingMarkdown === null || existingMarkdown === markdown,
    `拒绝覆盖不同内容的更新日志：${record.tag}`
  )
  assert.ok(
    existingRecord === null || isDeepStrictEqual(JSON.parse(existingRecord), payload),
    `拒绝覆盖不同内容的发布记录：${record.tag}`
  )

  if (existingMarkdown === null) await writeFile(changelogPath, markdown, { flag: 'wx' })
  if (existingRecord === null) {
    await writeFile(recordPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' })
  }
  await writeFile(siteReleasePath, `${JSON.stringify(release, null, 2)}\n`)
  return { changelogPath, recordPath, siteReleasePath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [recordFile, markdownFile, ...extra] = process.argv.slice(2)
    assert.ok(
      recordFile && markdownFile && !extra.length,
      '用法：node scripts/sync-release.mjs <record.json> <markdown-file>'
    )
    await syncRelease({
      websiteRoot: fileURLToPath(new URL('../', import.meta.url)),
      record: JSON.parse(await readFile(recordFile, 'utf8')),
      repository: process.env.GITHUB_REPOSITORY,
      markdown: await readFile(markdownFile, 'utf8')
    })
    console.log('官网发布记录和下载入口同步完成。')
  } catch (error) {
    console.error(`官网发布同步失败：${error.message}`)
    process.exitCode = 1
  }
}
