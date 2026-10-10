import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { sha256 } from './release-github.mjs'
import { clientFilename } from './release-record.mjs'
import { assertPackedManifest, readNpmArchiveManifest } from './release-npm.mjs'

const execute = promisify(execFile)

const npmFilename = (item) => `${item.name.slice(1).replace('/', '-')}-${item.version}.tgz`

export async function restoreReleaseArtifacts({
  github,
  release,
  plan,
  runId,
  repository,
  directory,
  download = async (run, name, output) => {
    console.info(`下载可恢复附件：${name}`)
    await execute(
      'gh',
      ['run', 'download', String(run), '--repo', repository, '--name', name, '--dir', output],
      { timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true }
    )
  }
}) {
  const pendingClients = () =>
    plan.clients.filter(
      (item) =>
        item.build && !release.assets.some((asset) => asset.name === clientFilename(item.platform))
    )
  const pendingNpm = () =>
    plan.npm.filter((name) => {
      const item = plan.record.packages.find((item) => item.name === `@jetcrab/${name}`)
      return !release.assets.some((asset) => asset.name === npmFilename(item))
    })
  if (!pendingClients().length && !pendingNpm().length) return
  assert.equal(release.draft, true, '只能向未公开草稿恢复产物')
  assert.equal(release.target_commitish, plan.record.source.head)
  const output = join(directory, 'restored-artifacts')
  await mkdir(output, { recursive: true })
  try {
    for (let page = 1; page <= 5; page++) {
      const { workflow_runs: runs } = await github.request(
        `/actions/workflows/release-main.yml/runs?branch=main&status=completed&per_page=30&page=${page}`
      )
      for (const run of runs) {
        if (String(run.id) === String(runId)) continue
        const artifacts = []
        for (let index = 1; ; index++) {
          const result = await github.request(
            `/actions/runs/${run.id}/artifacts?per_page=100&page=${index}`
          )
          artifacts.push(...result.artifacts.filter((item) => !item.expired))
          if (result.artifacts.length < 100) break
        }
        const has = (name) => artifacts.some((item) => item.name === `${name}-${run.id}`)
        if (!has('release-plan')) continue
        const folder = join(output, String(run.id))
        const oldPlan = join(folder, 'plan')
        await download(run.id, `release-plan-${run.id}`, oldPlan)
        const saved = JSON.parse(await readFile(join(oldPlan, 'plan.json'), 'utf8'))
        if (!isDeepStrictEqual(saved, plan)) continue
        const jobs = []
        for (let index = 1; ; index++) {
          const result = await github.request(
            `/actions/runs/${run.id}/jobs?per_page=100&page=${index}`
          )
          jobs.push(...result.jobs)
          if (jobs.length < 100) break
        }
        const passed = (name) =>
          jobs.some((job) => job.name === name && job.conclusion === 'success')
        for (const item of pendingClients()) {
          const job =
            item.platform === 'android'
              ? 'android / android'
              : `${item.platform} / ${item.platform}`
          const name = `client-${item.platform}`
          if (!has(name) || !passed(job)) continue
          const client = join(folder, item.platform)
          await download(run.id, `${name}-${run.id}`, client)
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
          await github.putAsset(release, clientFilename(item.platform), bytes)
          console.info(`复用成功客户端：${item.platform} ${item.version}，运行 ${run.id}`)
        }
        const npm = pendingNpm()
        const hostVerified =
          !plan.npm.includes('pi-desk') ||
          (passed('npm-build / installed-commands (ubuntu-latest)') &&
            passed('npm-build / installed-commands (windows-latest)'))
        if (npm.length && has('npm-packages') && passed('npm-build / build') && hostVerified) {
          const packages = join(folder, 'npm')
          await download(run.id, `npm-packages-${run.id}`, packages)
          for (const name of npm) {
            const expected = plan.record.packages.find((item) => item.name === `@jetcrab/${name}`)
            const filename = npmFilename(expected)
            const archive = join(packages, filename)
            assertPackedManifest(readNpmArchiveManifest(archive), expected)
            await github.putAsset(release, filename, await readFile(archive))
            console.info(`复用已验收 npm 包：${name} ${expected.version}，运行 ${run.id}`)
          }
        }
        if (!pendingClients().length && !pendingNpm().length) return
      }
      if (runs.length < 30) break
    }
    console.info(
      `缺少可复用产物：客户端=${
        pendingClients()
          .map((item) => item.platform)
          .join('、') || '无'
      }；npm=${pendingNpm().join('、') || '无'}，由本批构建补齐。`
    )
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}
