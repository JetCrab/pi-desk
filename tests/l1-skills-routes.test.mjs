import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

const testPiRoot = join(process.cwd(), 'temp/pi/l1-skills-routes', `host-review-${process.pid}`)
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
const routes = await jiti.import('../src/server/l1_entry/api/l1-skills-routes.ts')

function post(body) {
  return new Request('http://localhost/api/skills/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

test('Skills L1校验全局读取请求并保留缺失Skill错误响应', async () => {
  const skillPath = join(agentDir, 'skills', 'fixture-skill', 'SKILL.md')
  await mkdir(dirname(skillPath), { recursive: true })
  await writeFile(
    skillPath,
    '---\nname: fixture-skill\ndescription: Route fixture\n---\n\n# Fixture\n',
    'utf8'
  )

  const invalidJson = await routes.listSkillsPOST(
    new Request('http://localhost/api/skills/list', { method: 'POST', body: '{' })
  )
  assert.equal(invalidJson.status, 400)
  assert.equal((await invalidJson.json()).data, null)

  const invalidInput = await routes.listSkillsPOST(post({ cwd: 123 }))
  assert.equal(invalidInput.status, 400)
  assert.notEqual((await invalidInput.json()).code, 0)

  const missingProject = await routes.listSkillsPOST(post({ cwd: agentDir }))
  assert.equal(missingProject.status, 409)
  assert.notEqual((await missingProject.json()).code, 0)

  const listed = await routes.listSkillsPOST(post({ cwd: null }))
  const listBody = await listed.json()
  assert.equal(listed.status, 200)
  assert.equal(listBody.code, 0)
  assert.ok(listBody.data.skills.some((skill) => skill.name === 'fixture-skill'))

  const missing = await routes.getSkillFilePOST(
    new Request('http://localhost/api/skill-files/get', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: null,
        skillPath: join(agentDir, 'skills', 'missing', 'SKILL.md'),
        path: 'SKILL.md'
      })
    })
  )
  const missingBody = await missing.json()
  assert.equal(missing.status, 404)
  assert.notEqual(missingBody.code, 0)
  assert.equal(missingBody.data, null)
})
