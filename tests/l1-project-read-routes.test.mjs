import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

const testPiRoot = join(
  process.cwd(),
  'temp/pi/l1-project-read-routes',
  `host-review-${process.pid}`
)
const agentDir = join(testPiRoot, 'agent')
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
await mkdir(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true })
test.after(async () => {
  await rm(testPiRoot, { recursive: true, force: true })
})

const require = createRequire(import.meta.url)
const serverOnlyEntry = require.resolve('server-only')
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})
const { projectFileGet, projectFileList } = await jiti.import(
  '../src/server/l1_entry/api/l1-project-read-routes.ts'
)

function post(body) {
  return new Request('http://localhost/api/project-files/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function envelope(response) {
  return { response, body: await response.json() }
}

test('Project L1按Request Schema执行并保留错误Envelope状态码', async (context) => {
  const testRoot = join(
    process.cwd(),
    'temp/tests/l1-project-read-routes',
    `host-review-${process.pid}`
  )
  await mkdir(testRoot, { recursive: true })
  const cwd = await mkdtemp(join(testRoot, 'project-'))
  context.after(() => rm(testRoot, { recursive: true, force: true }))
  await writeFile(join(cwd, 'README.md'), '# Fixture\n', 'utf8')

  const invalidJson = await projectFileList(
    new Request('http://localhost/api/project-files/list', {
      method: 'POST',
      body: '{'
    })
  )
  assert.equal(invalidJson.status, 400)
  assert.equal((await invalidJson.json()).data, null)

  const invalidCwd = await envelope(await projectFileList(post({ cwd: 'relative', path: '' })))
  assert.equal(invalidCwd.response.status, 400)
  assert.notEqual(invalidCwd.body.code, 0)
  assert.equal(invalidCwd.body.data, null)

  const success = await envelope(await projectFileList(post({ cwd, path: '' })))
  assert.equal(success.response.status, 200)
  assert.equal(success.body.code, 0)
  assert.ok(success.body.data.entries.some((entry) => entry.name === 'README.md'))

  const missing = await envelope(
    await projectFileGet(
      new Request('http://localhost/api/project-files/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, path: 'missing.txt', imagePreviewMode: 'original' })
      })
    )
  )
  assert.equal(missing.response.status, 404)
  assert.notEqual(missing.body.code, 0)
  assert.equal(missing.body.data, null)
})
