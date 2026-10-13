import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateVersions } from './commit-versions.mjs'
import { createReleasePlan, git, latestSuccessfulRelease } from './release-plan.mjs'
import { createGitHubClient, sha256 } from './release-github.mjs'
import {
  clientFilename,
  clientPlatforms,
  releaseTagPattern,
  validateRecord
} from './release-record.mjs'
import { loadReleaseRecord, saveReleaseRecord } from './release-metadata.mjs'
import { renderReleaseNotes, validateChanges } from './release-notes.mjs'
import { findReleasePlan, restoreReleaseArtifacts } from './restore-release-artifacts.mjs'

const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const archiveName = (item) => `${item.name.slice(1).replace('/', '-')}-${item.version}.tgz`
const createdReleaseFile = 'created-release-id'

function completedPlan(record) {
  return {
    record,
    npm: [],
    clients: record.clients.map((item) => ({ ...item, build: false })),
    tunnel: false
  }
}

async function restoreDraft({ github, release, plan, directory, runId }) {
  if (!release?.draft) return
  const has = (name) => release.assets.some((item) => item.name === name)
  if (has('changes.json')) {
    const changes = validateChanges(JSON.parse(await github.asset(release, 'changes.json')))
    await mkdir(join(directory, 'notes'), { recursive: true })
    await writeFile(join(directory, 'notes/changes.json'), jsonBytes(changes))
  }
  for (const item of plan.clients.filter(
    (item) => item.build && has(clientFilename(item.platform))
  )) {
    const file = clientFilename(item.platform)
    const bytes = await github.asset(release, file)
    const hash = sha256(bytes)
    const asset = release.assets.find((entry) => entry.name === file)
    if (asset.digest) assert.equal(asset.digest, `sha256:${hash}`, '旧草稿安装包摘要不匹配')
    const folder = join(directory, 'clients', `client-${item.platform}-${runId}`)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, file), bytes)
    await writeFile(
      join(folder, 'release.json'),
      jsonBytes({ version: item.version, sha256: hash })
    )
  }
  for (const name of plan.npm) {
    const item = plan.record.packages.find((entry) => entry.name === `@jetcrab/${name}`)
    const file = archiveName(item)
    if (!has(file)) continue
    await mkdir(join(directory, 'npm'), { recursive: true })
    await writeFile(join(directory, 'npm', file), await github.asset(release, file))
  }
  if (has('pi-desk-docker.tar.gz') && has('docker-image.json')) {
    await mkdir(join(directory, 'docker'), { recursive: true })
    for (const file of ['pi-desk-docker.tar.gz', 'docker-image.json'])
      await writeFile(join(directory, 'docker', file), await github.asset(release, file))
  }
}

export async function prepareBatch(
  root,
  {
    github,
    source,
    output,
    plan: fixedPlan,
    runId = process.env.GITHUB_RUN_ID,
    repository = process.env.GITHUB_REPOSITORY,
    download
  }
) {
  assert.match(source, /^[a-f0-9]{40}$/)
  const releases = await github.releases()
  const latest = latestSuccessfulRelease(releases)
  const previous = latest ? await loadReleaseRecord(github, latest.tag_name) : null
  await validateVersions(root, { base: previous?.source.head ?? null, head: source })
  const release = releases.find(
    (item) => releaseTagPattern.test(item.tag_name) && item.target_commitish === source
  )
  let plan = fixedPlan
  if (release && !release.draft) {
    plan = completedPlan(await loadReleaseRecord(github, release.tag_name))
  } else if (!plan && release?.assets.some((item) => item.name === 'plan.json')) {
    plan = JSON.parse(await github.asset(release, 'plan.json'))
  } else if (!plan) {
    plan = await findReleasePlan({ github, source, runId, repository, directory: output, download })
  }
  assert.ok(plan || !release, '已有草稿缺少未过期的固定计划，不能重新分配批次')
  const reusable = !!plan
  plan ??= createReleasePlan(root, {
    head: source,
    previous,
    reservedTags: [
      ...releases.map((item) => item.tag_name),
      ...git(root, 'tag', '--list', 'v*').split('\n')
    ]
  })
  validateRecord(plan.record)
  assert.equal(plan.record.source.head, source, '固定计划源码不同，停止发布')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'plan.json'), jsonBytes(plan))
  const published = !!release && !release.draft
  const restored = join(output, 'restored')
  if (!published) {
    await restoreDraft({ github, release, plan, directory: restored, runId })
    if (reusable)
      await restoreReleaseArtifacts({
        github,
        plan,
        runId,
        repository,
        directory: restored,
        download
      })
  }
  const values = {
    sha: source,
    check_base: plan.record.source.base ?? '0000000000000000000000000000000000000000',
    tag: plan.record.tag,
    published,
    deploy: !published || latest?.tag_name === plan.record.tag,
    npm: JSON.stringify(plan.npm),
    npm_ready: plan.npm.every((name) => {
      const item = plan.record.packages.find((entry) => entry.name === `@jetcrab/${name}`)
      return existsSync(join(restored, 'npm', archiveName(item)))
    }),
    notes_ready: published || existsSync(join(restored, 'notes/changes.json')),
    tunnel: !published && plan.tunnel,
    docker: !published && plan.npm.includes('pi-desk'),
    ...Object.fromEntries(
      clientPlatforms.map((platform) => [
        platform,
        !published &&
          plan.clients.some((item) => item.platform === platform && item.build) &&
          !existsSync(join(restored, 'clients', `client-${platform}-${runId}`, 'release.json'))
      ])
    )
  }
  console.info(
    `已固定 ${plan.record.tag} 的源码与计划；${published ? '版本已公开，仅检查官网部署' : '准备阶段不创建Release，制品保存在Actions中'}。`
  )
  return { plan, release, outputs: values }
}

export async function prepareResumeBatch(
  root,
  {
    github,
    tag,
    source,
    output,
    runId = process.env.GITHUB_RUN_ID,
    repository = process.env.GITHUB_REPOSITORY,
    download
  }
) {
  assert.match(tag, releaseTagPattern)
  assert.match(source, /^[a-f0-9]{40}$/)
  const release = (await github.releases()).find((item) => item.tag_name === tag)
  assert.ok(!release || (release.draft && !release.prerelease), '只能续跑尚未公开的正式批次')
  const plan = release?.assets.some((item) => item.name === 'plan.json')
    ? JSON.parse(await github.asset(release, 'plan.json'))
    : await findReleasePlan({ github, tag, runId, repository, directory: output, download })
  assert.ok(plan, '找不到未过期的固定发布计划，不能猜测版本或源码续跑')
  validateRecord(plan.record)
  assert.equal(plan.record.tag, tag)
  if (release)
    assert.equal(release.target_commitish, plan.record.source.head, '草稿源码与固定计划不一致')
  git(root, 'merge-base', '--is-ancestor', plan.record.source.head, source)
  const latest = latestSuccessfulRelease(await github.releases())
  if (latest) {
    const previous = await loadReleaseRecord(github, latest.tag_name)
    assert.equal(plan.record.source.base, previous.source.head, '已有较新正式版本，不能续跑旧批次')
  }
  const result = await prepareBatch(root, {
    github,
    source: plan.record.source.head,
    output,
    plan,
    runId,
    repository,
    download
  })
  assert.equal(result.outputs.tag, tag, '续跑不能重新分配批次')
  return result
}

export async function prepareWebsiteBatch({ github, tag, source, output }) {
  assert.match(tag, releaseTagPattern)
  assert.match(source, /^[a-f0-9]{40}$/)
  const release = latestSuccessfulRelease(await github.releases())
  assert.equal(release?.tag_name, tag, '只能重新部署最新已公开版本，不能回退官网')
  const record = await loadReleaseRecord(github, tag)
  const plan = completedPlan(record)
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'plan.json'), jsonBytes(plan))
  return {
    plan,
    release,
    outputs: {
      sha: source,
      tag,
      published: true,
      deploy: true,
      npm: '[]',
      npm_ready: true,
      notes_ready: true,
      tunnel: false,
      docker: false,
      windows: false,
      macos: false,
      linux: false,
      android: false
    }
  }
}

export async function assembleBatch({ github, plan, directory, output, changes }) {
  validateChanges(changes)
  await mkdir(output, { recursive: true })
  const clients = []
  for (const item of plan.clients) {
    const file = clientFilename(item.platform)
    let bytes, hash
    if (item.build) {
      const entries = await readdir(directory)
      const folder = entries.find((name) => name.startsWith(`client-${item.platform}-`))
      assert.ok(folder, `缺少 ${item.platform} 构建制品`)
      const root = join(directory, folder)
      const manifest = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'))
      assert.equal(manifest.version, item.version)
      const names = (await readdir(root)).filter((name) => /\.(exe|dmg|apk|AppImage)$/.test(name))
      assert.equal(names.length, 1, '每个平台必须只有一个安装包')
      assert.ok(!names[0].includes('-unsigned'), '正式发布不能使用未签名Android安装包')
      hash = manifest.sha256
      bytes = await readFile(join(root, names[0]))
    } else {
      const previous = (await github.releases()).find(
        (entry) => entry.tag_name === item.reuse.tag && !entry.draft && !entry.prerelease
      )
      assert.ok(previous, '无法找到已成功发布的复用来源')
      hash = item.reuse.sha256
      bytes = await github.asset(previous, item.reuse.file)
    }
    assert.equal(sha256(bytes), hash, `${item.platform} 安装包摘要不匹配`)
    const client = { platform: item.platform, version: item.version, file, sha256: hash }
    validateRecord({ ...plan.record, clients: [client], changes })
    await writeFile(join(output, file), bytes)
    clients.push(client)
  }
  const record = validateRecord({ ...plan.record, clients, changes })
  assert.ok(
    clientPlatforms.every((platform) =>
      record.clients.some((client) => client.platform === platform)
    ),
    '正式Release必须附带所有平台的当前安装包'
  )
  await writeFile(join(output, 'release.json'), jsonBytes(record))
  return record
}

export async function cleanupBatch({ github, plan, directory, id }) {
  if (id === undefined) {
    const marker = join(directory, createdReleaseFile)
    if (!existsSync(marker)) return
    id = (await readFile(marker, 'utf8')).trim()
  }
  assert.match(String(id), /^\d+$/)
  const release = await github.request(`/releases/${id}`, { allow404: true })
  if (!release || !release.draft) return
  assert.equal(release.tag_name, plan.record.tag, '草稿不属于本批，拒绝清理')
  assert.equal(release.target_commitish, plan.record.source.head, '草稿源码不同，拒绝清理')
  await github.request(`/releases/${id}`, { method: 'DELETE' })
  console.info(`已清理本次未公开草稿 ${release.tag_name}；原制品、tag及固定记录保留供重试。`)
}

export async function publishBatch({ github, record, directory, repository }) {
  validateRecord(record)
  assert.ok(
    clientPlatforms.every((platform) =>
      record.clients.some((client) => client.platform === platform)
    ),
    '正式Release必须包含全部客户端制品'
  )
  const existing = await github.request(`/git/ref/tags/${record.tag}`, { allow404: true })
  if (existing) {
    const commit = await github.request(`/commits/${record.tag}`)
    assert.equal(commit.sha, record.source.head, '已有tag指向不同提交，拒绝移动')
  }
  const releases = await github.releases()
  let release = releases.find((item) => item.tag_name === record.tag)
  if (release) {
    assert.equal(release.target_commitish, record.source.head, '已有Release源码不同，拒绝覆盖')
    if (!release.draft) {
      assert.deepEqual(
        await loadReleaseRecord(github, record.tag),
        record,
        '已公开记录不同，拒绝覆盖'
      )
      return record
    }
  }
  const latest = latestSuccessfulRelease(releases)
  if (latest) {
    const previous = await loadReleaseRecord(github, latest.tag_name)
    assert.equal(record.source.base, previous.source.head, '已有较新正式版本，停止旧批次发布')
  }
  for (const item of record.clients)
    assert.equal(
      sha256(await readFile(join(directory, item.file))),
      item.sha256,
      `${item.platform} 安装包摘要不匹配`
    )
  let created = false
  try {
    if (!release) {
      release = await github.request('/releases', {
        method: 'POST',
        body: {
          tag_name: record.tag,
          target_commitish: record.source.head,
          name: record.tag,
          body: renderReleaseNotes(record, { repository }),
          draft: true,
          prerelease: false
        }
      })
      created = true
      await writeFile(join(directory, createdReleaseFile), String(release.id))
      console.info(`全部发布门禁已通过，末端创建 ${record.tag} 并上传安装包。`)
    }
    for (const item of record.clients)
      await github.putAsset(release, item.file, await readFile(join(directory, item.file)))
    await saveReleaseRecord(github, record)
    if (!existing)
      await github.request('/git/refs', {
        method: 'POST',
        body: { ref: `refs/tags/${record.tag}`, sha: record.source.head }
      })
    for (const entry of release.assets.filter(
      (item) =>
        [
          'plan.json',
          'changes.json',
          'release.json',
          'release.md',
          'docker-image.json',
          'pi-desk-docker.tar.gz'
        ].includes(item.name) || item.name.endsWith('.tgz')
    ))
      await github.request(`/releases/assets/${entry.id}`, { method: 'DELETE' })
    await github.request(`/releases/${release.id}`, {
      method: 'PATCH',
      body: {
        name: record.tag,
        draft: false,
        make_latest: 'true',
        body: renderReleaseNotes(record, { repository })
      }
    })
    return record
  } catch (error) {
    if (created) {
      try {
        await cleanupBatch({ github, plan: { record }, directory, id: release.id })
      } catch (cleanupError) {
        console.error(`本次草稿清理失败：${cleanupError.message}；请检查 ${record.tag}。`)
      }
    }
    throw error
  }
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', '正式批次仅在GitHub Actions执行')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', '正式批次仅允许main')
  const root = resolve(import.meta.dirname, '../..')
  const output = resolve(process.env.RELEASE_ROOT)
  const repository = process.env.GITHUB_REPOSITORY
  const github = createGitHubClient({ repository, token: process.env.GH_TOKEN })
  const [command] = process.argv.slice(2)
  if (command === 'prepare') {
    const repositoryInfo = await github.request('')
    assert.equal(
      repositoryInfo.private,
      false,
      '官网使用GitHub Release下载；首次启用前须确认仓库公开，流程不会自行改变可见性'
    )
    assert.ok(
      !(process.env.WEBSITE_RELEASE_TAG && process.env.RESUME_RELEASE_TAG),
      '官网重部署与批次续跑不能同时选择'
    )
    const result = process.env.RESUME_RELEASE_TAG
      ? await prepareResumeBatch(root, {
          github,
          tag: process.env.RESUME_RELEASE_TAG,
          source: process.env.GITHUB_SHA,
          output
        })
      : process.env.WEBSITE_RELEASE_TAG
        ? await prepareWebsiteBatch({
            github,
            tag: process.env.WEBSITE_RELEASE_TAG,
            source: process.env.GITHUB_SHA,
            output
          })
        : await prepareBatch(root, { github, source: process.env.GITHUB_SHA, output })
    for (const [key, value] of Object.entries(result.outputs))
      await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
    return
  }
  const directory = join(output, 'release')
  if (command === 'cleanup' && !existsSync(join(directory, createdReleaseFile))) return
  const plan = JSON.parse(await readFile(join(output, 'plan.json'), 'utf8'))
  if (command === 'save-notes') {
    validateChanges(JSON.parse(await readFile(join(output, 'changes.json'), 'utf8')))
  } else if (command === 'assemble') {
    await assembleBatch({
      github,
      plan,
      directory: join(output, 'clients'),
      output: directory,
      changes: JSON.parse(await readFile(join(output, 'changes.json'), 'utf8'))
    })
  } else if (command === 'publish') {
    const record = validateRecord(
      JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'))
    )
    assert.equal(record.tag, plan.record.tag, '发布包版本与固定计划不同')
    assert.deepEqual(record.source, plan.record.source, '发布包源码与固定计划不同')
    assert.deepEqual(record.packages, plan.record.packages, '发布包组件版本与固定计划不同')
    await publishBatch({ github, record, directory, repository })
  } else if (command === 'cleanup') {
    await cleanupBatch({ github, plan, directory })
  } else if (command === 'website') {
    const published = await github.releases()
    const release = published.find((item) => item.tag_name === plan.record.tag)
    assert.ok(release && !release.draft, '未正式发布的记录不能部署官网')
    assert.equal(
      latestSuccessfulRelease(published)?.tag_name,
      release.tag_name,
      '已有较新正式版本，拒绝回退官网'
    )
    const websiteRoot = join(root, 'apps/website')
    const { syncRelease } = await import(
      pathToFileURL(join(websiteRoot, 'scripts/sync-release.mjs')).href
    )
    for (const item of published.filter(
      (item) => !item.draft && !item.prerelease && releaseTagPattern.test(item.tag_name)
    )) {
      const record = await loadReleaseRecord(github, item.tag_name)
      await syncRelease({
        websiteRoot,
        record,
        repository,
        markdown: `## Pi Desk ${record.tag}\n\n${renderReleaseNotes(record, { repository })}`
      })
    }
    // 最后再次写入本批，避免历史遍历顺序改变首页当前版本。
    const record = await loadReleaseRecord(github, release.tag_name)
    await syncRelease({
      websiteRoot,
      record,
      repository,
      markdown: `## Pi Desk ${record.tag}\n\n${renderReleaseNotes(record, { repository })}`
    })
  } else throw new Error('未知正式发布阶段')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
