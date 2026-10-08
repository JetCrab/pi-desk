import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareStableVersions } from './prepare-stable-release.mjs'
import { createReleasePlan, git, latestSuccessfulRelease } from './release-plan.mjs'
import { createGitHubClient, sha256 } from './release-github.mjs'
import { validateRecord } from './release-record.mjs'
import { renderReleaseNotes, validateChanges } from './release-notes.mjs'

const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const archiveName = (item) => `${item.name.slice(1).replace('/', '-')}-${item.version}.tgz`

export async function prepareBatch(
  root,
  {
    github,
    source,
    output,
    prepareVersions = prepareStableVersions,
    refreshLock = () =>
      execFileSync(
        'pnpm',
        ['install', '--lockfile-only', '--ignore-scripts', '--registry=https://registry.npmjs.org'],
        { cwd: root, stdio: 'inherit' }
      )
  }
) {
  assert.match(source, /^[a-f0-9]{40}$/)
  // 重跑原始合并事件时，继续使用此前已回写的正式版本提交。
  const releases = await github.releases()
  const latest = latestSuccessfulRelease(releases)
  const previous = latest
    ? validateRecord(JSON.parse(await github.asset(latest, 'release.json')))
    : null
  const message = `chore(release): prepare ${source}`
  const prepared = git(
    root,
    'log',
    'origin/main',
    '--format=%H',
    '--fixed-strings',
    `--grep=${message}`
  )
    .split('\n')
    .filter(Boolean)
    .find((sha) => git(root, 'show', '-s', '--format=%P', sha) === source)
  const candidate = prepared || source
  const fixed = releases.find((item) => item.tag_name === `release-${candidate.slice(0, 12)}`)
  git(root, 'checkout', '--detach', candidate)
  if (!prepared && !fixed) {
    const result = await prepareVersions(root, { base: previous?.source.head ?? null })
    if (result.changedFiles.length) {
      await refreshLock()
      git(root, 'add', '--', ...result.changedFiles, 'pnpm-lock.yaml')
      git(
        root,
        '-c',
        'user.name=github-actions[bot]',
        '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit',
        '-m',
        message
      )
      git(root, 'push', 'origin', 'HEAD:refs/heads/main')
    }
  }
  const head = git(root, 'rev-parse', 'HEAD')
  const tag = `release-${head.slice(0, 12)}`
  let release = releases.find((item) => item.tag_name === tag)
  let plan
  if (release && !release.draft) {
    const record = validateRecord(JSON.parse(await github.asset(release, 'release.json')))
    assert.equal(record.source.head, head)
    plan = {
      record,
      npm: [],
      clients: record.clients.map((item) => ({ ...item, build: false })),
      tunnel: false
    }
  } else if (release?.assets.some((item) => item.name === 'plan.json')) {
    plan = JSON.parse(await github.asset(release, 'plan.json'))
    validateRecord(plan.record)
    assert.equal(plan.record.source.head, head)
  } else {
    plan = createReleasePlan(root, { head, previous })
    if (!release)
      release = await github.request('/releases', {
        method: 'POST',
        body: {
          tag_name: tag,
          target_commitish: head,
          name: `Pi Desk ${plan.record.packages.find((item) => item.name === '@jetcrab/pi-desk').version} · ${new Date(plan.record.date).toISOString().slice(0, 10)}`,
          body: '正在验证本批发布内容。',
          draft: true,
          prerelease: false
        }
      })
    await github.putAsset(release, 'plan.json', jsonBytes(plan))
  }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'plan.json'), jsonBytes(plan))
  const npmReady = plan.npm.every((name) => {
    const item = plan.record.packages.find((entry) => entry.name === `@jetcrab/${name}`)
    return release.assets.some((entry) => entry.name === archiveName(item))
  })
  const clientsReady = release.assets.some((entry) => entry.name === 'release.json')
  const notesReady = !release.draft || release.assets.some((entry) => entry.name === 'changes.json')
  const values = {
    sha: head,
    tag,
    published: !release.draft,
    deploy: release.draft || latestSuccessfulRelease(releases)?.tag_name === tag,
    npm: JSON.stringify(plan.npm),
    npm_ready: npmReady,
    notes_ready: notesReady,
    tunnel: plan.tunnel,
    windows:
      !clientsReady && plan.clients.some((item) => item.platform === 'windows' && item.build),
    macos: !clientsReady && plan.clients.some((item) => item.platform === 'macos' && item.build),
    android: !clientsReady && plan.clients.some((item) => item.platform === 'android' && item.build)
  }
  return { plan, release, outputs: values }
}

export async function stageNpm({ github, release, plan, directory }) {
  await mkdir(directory, { recursive: true })
  for (const name of plan.npm) {
    const item = plan.record.packages.find((entry) => entry.name === `@jetcrab/${name}`)
    const filename = archiveName(item)
    if (release.assets.some((entry) => entry.name === filename)) {
      await writeFile(join(directory, filename), await github.asset(release, filename))
    } else {
      await github.putAsset(release, filename, await readFile(join(directory, filename)))
    }
  }
}

export async function assembleBatch({ github, release, plan, directory, repository }) {
  if (release.assets.some((entry) => entry.name === 'release.json')) {
    const record = validateRecord(JSON.parse(await github.asset(release, 'release.json')))
    assert.equal(record.source.head, plan.record.source.head)
    for (const item of record.clients)
      assert.equal(sha256(await github.asset(release, item.file)), item.sha256)
    await github.putAsset(
      release,
      'release.md',
      Buffer.from(renderReleaseNotes(record, { repository }))
    )
    return record
  }
  const changes = validateChanges(JSON.parse(await github.asset(release, 'changes.json')))
  const clients = []
  for (const item of plan.clients) {
    let bytes, file, hash
    if (item.build) {
      const entries = await readdir(directory)
      const folder = entries.find((name) => name.startsWith(`client-${item.platform}-`))
      assert.ok(folder, `缺少 ${item.platform} 构建制品`)
      const root = join(directory, folder)
      const manifest = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'))
      assert.equal(manifest.version, item.version)
      const names = (await readdir(root)).filter((name) => /\.(exe|dmg|apk)$/.test(name))
      assert.equal(names.length, 1, '每个平台必须只有一个安装包')
      file = names[0]
      hash = manifest.sha256
      bytes = await readFile(join(root, file))
      assert.equal(sha256(bytes), hash, `${item.platform} 安装包摘要不匹配`)
      const saved = release.assets.find((entry) => entry.name === file)
      if (saved) {
        // 同一固定源码批次里已上传的文件优先，避免签名时间戳导致重建摘要变化。
        bytes = await github.asset(release, file)
        hash = sha256(bytes)
        if (saved.digest) assert.equal(saved.digest, `sha256:${hash}`, '草稿附件摘要不匹配')
      }
    } else {
      const previous = (await github.releases()).find(
        (entry) => entry.tag_name === item.reuse.tag && !entry.draft && !entry.prerelease
      )
      assert.ok(previous, '无法找到已成功发布的复用来源')
      file = item.reuse.file
      hash = item.reuse.sha256
      bytes = await github.asset(previous, file)
    }
    assert.equal(sha256(bytes), hash, `${item.platform} 安装包摘要不匹配`)
    const client = { platform: item.platform, version: item.version, file, sha256: hash }
    validateRecord({ ...plan.record, clients: [client], changes })
    await github.putAsset(release, file, bytes)
    clients.push(client)
  }
  const record = validateRecord({ ...plan.record, clients, changes })
  assert.equal(record.clients.length, 3, '正式 Release 必须附带三个平台的当前安装包')
  await github.putAsset(release, 'release.json', jsonBytes(record))
  await github.putAsset(
    release,
    'release.md',
    Buffer.from(renderReleaseNotes(record, { repository }))
  )
  return record
}

export async function publishBatch({ github, release, repository }) {
  const record = validateRecord(JSON.parse(await github.asset(release, 'release.json')))
  if (!release.draft) return record
  const existing = await github.request(`/git/ref/tags/${record.tag}`, { allow404: true })
  if (existing) {
    const commit = await github.request(`/commits/${record.tag}`)
    assert.equal(commit.sha, record.source.head, '已有 tag 指向不同提交，拒绝移动')
  } else {
    await github.request('/git/refs', {
      method: 'POST',
      body: { ref: `refs/tags/${record.tag}`, sha: record.source.head }
    })
  }
  await github.request(`/releases/${release.id}`, {
    method: 'PATCH',
    body: {
      draft: false,
      make_latest: 'true',
      body: renderReleaseNotes(record, { repository })
    }
  })
  for (const entry of release.assets.filter(
    (item) => ['plan.json', 'changes.json'].includes(item.name) || item.name.endsWith('.tgz')
  )) {
    try {
      await github.request(`/releases/assets/${entry.id}`, { method: 'DELETE' })
    } catch {
      console.warn(`正式发布已完成，暂存附件清理未确认：${entry.name}`)
    }
  }
  return record
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', '正式批次仅在 GitHub Actions 执行')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', '正式批次仅允许 main')
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
      '官网使用 GitHub Release 下载；首次启用前须确认仓库公开，流程不会自行改变可见性'
    )
    const result = await prepareBatch(root, { github, source: process.env.GITHUB_SHA, output })
    for (const [key, value] of Object.entries(result.outputs))
      await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
    return
  }
  const plan = JSON.parse(await readFile(join(output, 'plan.json'), 'utf8'))
  const release = (await github.releases()).find((item) => item.tag_name === plan.record.tag)
  assert.ok(release, '发布草稿不存在')
  if (command === 'save-notes') {
    const changes = validateChanges(
      JSON.parse(await readFile(join(output, 'changes.json'), 'utf8'))
    )
    await github.putAsset(release, 'changes.json', jsonBytes(changes))
  } else if (command === 'stage-npm') {
    await stageNpm({ github, release, plan, directory: resolve(process.env.NPM_ARTIFACT_DIR) })
  } else if (command === 'assemble') {
    await assembleBatch({ github, release, plan, directory: join(output, 'clients'), repository })
  } else if (command === 'publish') {
    await publishBatch({ github, release, repository })
  } else if (command === 'website') {
    assert.equal(release.draft, false, '未正式发布的记录不能部署官网')
    const published = await github.releases()
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
      (item) => !item.draft && !item.prerelease && /^release-[a-f0-9]{12}$/.test(item.tag_name)
    )) {
      const record = validateRecord(JSON.parse(await github.asset(item, 'release.json')))
      await syncRelease({
        websiteRoot,
        record,
        repository,
        markdown: renderReleaseNotes(record, { repository })
      })
    }
    // 最后再次写入本批，避免历史遍历顺序改变首页当前版本。
    const record = validateRecord(JSON.parse(await github.asset(release, 'release.json')))
    await syncRelease({
      websiteRoot,
      record,
      repository,
      markdown: renderReleaseNotes(record, { repository })
    })
  } else throw new Error('未知正式发布阶段')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
