import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function waitForDevBatch({ repository, runId, token }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/)
  assert.match(runId, /^\d+$/)
  const api = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000)
    })
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
      assert.ok(Number.isFinite(reset) && reset > 0, 'GitHub 未提供有效限流恢复时间')
      await response.body?.cancel()
      console.info(`开发批次 ${runId} 等待 GitHub 查询额度恢复，不取消任务。`)
      await new Promise((done) => setTimeout(done, Math.max(1000, reset - Date.now() + 1000)))
      return api(path)
    }
    assert.ok(response.ok, `无法确认开发批次状态：HTTP ${response.status}`)
    return response.json()
  }
  const { workflow_id: workflow } = await api(`runs/${runId}`)
  while (true) {
    const active = []
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      let page = 1
      while (true) {
        const { workflow_runs: runs } = await api(
          `workflows/${workflow}/runs?branch=dev&status=${status}&per_page=100&page=${page}`
        )
        active.push(
          ...runs.filter((run) => run.head_branch === 'dev' && Number(run.id) < Number(runId))
        )
        if (runs.length < 100) break
        page += 1
      }
    }
    if (!active.length) {
      console.info(`开发批次 ${runId} 可以开始；不取消任何较早提交。`)
      return
    }
    console.info(
      `开发批次 ${runId} 等待前序批次：${[...new Set(active.map((run) => run.id))].join('、')}`
    )
    await new Promise((done) => setTimeout(done, 15_000))
  }
}

async function main() {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/dev')
  await waitForDevBatch({
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    token: process.env.GH_TOKEN
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
