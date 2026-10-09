import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGitHubClient } from './release-github.mjs'

export function hasNpmArtifacts(artifacts, runId, packages) {
  const available = new Set(artifacts.filter((item) => !item.expired).map((item) => item.name))
  return (
    available.has(`npm-packages-${runId}`) &&
    (!packages.includes('pi-desk') || available.has(`npm-command-smoke-${runId}`))
  )
}

async function main() {
  const github = createGitHubClient({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN
  })
  const runId = process.env.GITHUB_RUN_ID
  const artifacts = []
  for (let page = 1; ; page++) {
    const result = await github.request(
      `/actions/runs/${runId}/artifacts?per_page=100&page=${page}`
    )
    artifacts.push(...result.artifacts)
    if (result.artifacts.length < 100) break
  }
  const reusable = hasNpmArtifacts(artifacts, runId, JSON.parse(process.env.RELEASE_PACKAGES_JSON))
  await appendFile(process.env.GITHUB_OUTPUT, `reusable=${reusable}\n`)
  console.info(
    reusable ? '继续使用同批原始制品，重新执行尚未通过的验收。' : '本批没有完整有效制品，执行构建。'
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
