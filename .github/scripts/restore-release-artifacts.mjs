import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { sha256 } from './release-github.mjs'
import { validateRecord } from './release-record.mjs'
import { validateChanges } from './release-notes.mjs'
import { assertPackedManifest, readNpmArchiveManifest } from './release-npm.mjs'

const execute = promisify(execFile)
const npmFilename = (item) => `${item.name.slice(1).replace('/', '-')}-${item.version}.tgz`

async function downloadArtifact(run, name, output, repository) {
  console.info(`下载可恢复制品：${name}`)
  await execute(
    'gh',
    ['run', 'download', String(run), '--repo', repository, '--name', name, '--dir', output],
    {
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }
  )
}

async function listArtifacts(github, runId) {
  const artifacts = []
  for (let page = 1; ; page++) {
    const result = await github.request(
      `/actions/runs/${runId}/artifacts?per_page=100&page=${page}`
    )
    artifacts.push(...result.artifacts)
    if (result.artifacts.length < 100) return artifacts
  }
}

async function* artifactRuns(github, runId, source) {
  if (runId) yield { id: Number(runId), artifacts: await listArtifacts(github, runId) }
  for (let page = 1; page <= 5; page++) {
    const { workflow_runs: runs } = await github.request(
      `/actions/workflows/release-main.yml/runs?branch=main&status=completed&per_page=30&page=${page}${source ? `&head_sha=${source}` : ''}`
    )
    for (const run of runs) {
      if (String(run.id) === String(runId)) continue
      yield { id: run.id, artifacts: await listArtifacts(github, run.id) }
    }
    if (runs.length < 30) return
  }
}

export async function findReleasePlan({
  github,
  tag,
  source,
  runId,
  repository,
  directory,
  download = (run, name, output) => downloadArtifact(run, name, output, repository)
}) {
  const search = join(directory, 'plan-search')
  try {
    for await (const run of artifactRuns(github, runId, source)) {
      const name = `release-plan-${run.id}`
      const artifact = run.artifacts.find((item) => item.name === name)
      if (!artifact) continue
      if (String(run.id) === String(runId))
        assert.equal(artifact.expired, false, '本次运行的固定计划已过期，停止重试')
      if (artifact.expired) continue
      const output = join(search, String(run.id))
      await download(run.id, name, output)
      const plan = JSON.parse(await readFile(join(output, 'plan.json'), 'utf8'))
      validateRecord(plan.record)
      if (String(run.id) === String(runId)) {
        if (tag) assert.equal(plan.record.tag, tag, '本次运行的固定版本不同，停止重试')
        if (source)
          assert.equal(plan.record.source.head, source, '本次运行的固定源码不同，停止重试')
      }
      if (tag && plan.record.tag !== tag) continue
      if (source && plan.record.source.head !== source) continue
      return plan
    }
    return null
  } finally {
    await rm(search, { recursive: true, force: true })
  }
}

export async function restoreReleaseArtifacts({
  github,
  plan,
  runId,
  repository,
  directory,
  download = (run, name, output) => downloadArtifact(run, name, output, repository)
}) {
  const clientDirectory = (platform) => join(directory, 'clients', `client-${platform}-${runId}`)
  const pendingClients = () =>
    plan.clients.filter(
      (item) => item.build && !existsSync(join(clientDirectory(item.platform), 'release.json'))
    )
  const pendingNpm = () =>
    plan.npm.filter((name) => {
      const item = plan.record.packages.find((item) => item.name === `@jetcrab/${name}`)
      return !existsSync(join(directory, 'npm', npmFilename(item)))
    })
  const pendingNotes = () => !existsSync(join(directory, 'notes/changes.json'))
  const pendingDocker = () =>
    plan.npm.includes('pi-desk') && !existsSync(join(directory, 'docker/docker-image.json'))
  const pending = () =>
    pendingClients().length || pendingNpm().length || pendingNotes() || pendingDocker()
  if (!pending()) return
  const search = join(directory, 'artifact-search')
  try {
    for await (const run of artifactRuns(github, runId)) {
      const has = (name) =>
        run.artifacts.some((item) => item.name === `${name}-${run.id}` && !item.expired)
      if (!has('release-plan')) continue
      const folder = join(search, String(run.id))
      const oldPlan = join(folder, 'plan')
      await download(run.id, `release-plan-${run.id}`, oldPlan)
      const saved = JSON.parse(await readFile(join(oldPlan, 'plan.json'), 'utf8'))
      if (!isDeepStrictEqual(saved, plan)) continue
      const jobs = []
      for (let page = 1; ; page++) {
        const result = await github.request(
          `/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`
        )
        jobs.push(...result.jobs)
        if (result.jobs.length < 100) break
      }
      const passed = (name) => jobs.some((job) => job.name === name && job.conclusion === 'success')
      const restored = (name) =>
        passed('prepare') &&
        !jobs.some(
          (job) =>
            (job.name === name || job.name.startsWith(`${name} /`)) && job.conclusion !== 'skipped'
        )
      for (const item of pendingClients()) {
        const job = `${item.platform} / ${item.platform}`
        if (!has(`client-${item.platform}`) || (!passed(job) && !restored(item.platform))) continue
        const client = join(folder, item.platform)
        await download(run.id, `client-${item.platform}-${run.id}`, client)
        const manifest = JSON.parse(await readFile(join(client, 'release.json'), 'utf8'))
        assert.equal(manifest.version, item.version, `${item.platform} 恢复版本与发布计划不一致`)
        const files = (await readdir(client)).filter((name) =>
          /\.(exe|dmg|apk|AppImage)$/.test(name)
        )
        assert.equal(files.length, 1, '恢复的平台必须只有一个安装包')
        assert.ok(!files[0].includes('-unsigned'), '正式恢复不能使用未签名 Android 包')
        const bytes = await readFile(join(client, files[0]))
        assert.ok(bytes.length > 0, '恢复的安装包为空')
        assert.equal(sha256(bytes), manifest.sha256, `${item.platform} 恢复产物摘要不一致`)
        await cp(client, clientDirectory(item.platform), { recursive: true })
        console.info(`复用成功客户端：${item.platform} ${item.version}，运行 ${run.id}`)
      }
      const hostVerified =
        !plan.npm.includes('pi-desk') ||
        (passed('npm-build / installed-commands (ubuntu-latest)') &&
          passed('npm-build / installed-commands (windows-latest)'))
      const npmVerified = (passed('npm-build / build') && hostVerified) || restored('npm-build')
      if (pendingNpm().length && has('npm-packages') && npmVerified) {
        const packages = join(folder, 'npm')
        await download(run.id, `npm-packages-${run.id}`, packages)
        for (const name of plan.npm) {
          const item = plan.record.packages.find((item) => item.name === `@jetcrab/${name}`)
          assertPackedManifest(readNpmArchiveManifest(join(packages, npmFilename(item))), item)
        }
        await cp(packages, join(directory, 'npm'), { recursive: true })
        console.info(`复用已验收 npm 包，运行 ${run.id}`)
      }
      if (pendingNotes() && has('release-review') && (passed('notes') || restored('notes'))) {
        const notes = join(folder, 'notes')
        await download(run.id, `release-review-${run.id}`, notes)
        // 旧工作流的审查附件只有证据，不能将其当作完整更新说明。
        if (existsSync(join(notes, 'changes.json'))) {
          validateChanges(JSON.parse(await readFile(join(notes, 'changes.json'), 'utf8')))
          await cp(notes, join(directory, 'notes'), { recursive: true })
        }
      }
      if (
        pendingDocker() &&
        has('docker-image') &&
        (passed('docker-build / build') || restored('docker-build'))
      ) {
        const docker = join(folder, 'docker')
        await download(run.id, `docker-image-${run.id}`, docker)
        const record = JSON.parse(await readFile(join(docker, 'docker-image.json'), 'utf8'))
        const host = plan.record.packages.find((item) => item.name === '@jetcrab/pi-desk')
        assert.equal(record.source, plan.record.source.head, '镜像属于不同源码批次')
        assert.equal(record.version, host.version, '镜像版本与固定计划不同')
        assert.match(record.imageId, /^sha256:[a-f0-9]{64}$/)
        assert.equal(
          record.sha256,
          sha256(await readFile(join(docker, 'pi-desk-docker.tar.gz'))),
          '镜像归档摘要不一致'
        )
        await cp(docker, join(directory, 'docker'), { recursive: true })
      }
      if (!pending()) return
    }
    console.info(
      `缺少可复用产物：客户端=${
        pendingClients()
          .map((item) => item.platform)
          .join('、') || '无'
      }；npm=${pendingNpm().join('、') || '无'}，由本批构建补齐。`
    )
  } finally {
    await rm(search, { recursive: true, force: true })
  }
}
