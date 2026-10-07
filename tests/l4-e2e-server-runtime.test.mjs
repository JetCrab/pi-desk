import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { spawnE2eServer, stopE2eServerTree, assertPortReleased } from './l4-e2e-server-runtime.mjs'

async function reservePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  )
  return port
}

for (const previous of ['original development declarations\r\n', null]) {
  test(`停止隔离E2E恢复Next声明（原文件${previous === null ? '缺失' : '存在'}）`, async () => {
    const fixtures = resolve('temp/tests/e2e-server-runtime/config-restore')
    await mkdir(fixtures, { recursive: true })
    const projectRoot = await mkdtemp(join(fixtures, 'project-'))
    const agentDir = join(projectRoot, 'temp/pi/config-restore/current/agent')
    await mkdir(join(agentDir, 'sessions'), { recursive: true })
    await symlink(
      resolve('node_modules'),
      join(projectRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await writeFile(
      join(projectRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS' } })
    )
    await mkdir(join(projectRoot, 'src/server/l1_entry/node'), { recursive: true })
    await writeFile(
      join(projectRoot, 'src/server/l1_entry/node/l1-server.ts'),
      `
      import { writeFileSync } from 'node:fs'
      import { createServer } from 'node:http'
      writeFileSync('next-env.d.ts', 'import "./' + process.env.PI_DESK_E2E_NEXT_DIR + '/dev/types/routes.d.ts";\\n')
      createServer((_request, response) => response.end('ok')).listen(Number(process.env.PORT), '127.0.0.1', () => process.send?.({ ready: true }))
    `
    )
    const nextEnv = join(projectRoot, 'next-env.d.ts')
    if (previous !== null) await writeFile(nextEnv, previous)
    const port = await reservePort()
    let runtime
    try {
      runtime = spawnE2eServer({ projectRoot, agentDir, port, development: true })
      await once(runtime.child, 'message', { signal: AbortSignal.timeout(15000) })
      assert.match(await readFile(nextEnv, 'utf8'), /config-restore/)
      await stopE2eServerTree(runtime)
      runtime = null
      if (previous === null) await assert.rejects(readFile(nextEnv), { code: 'ENOENT' })
      else assert.equal(await readFile(nextEnv, 'utf8'), previous)
      await assertPortReleased(port)
    } finally {
      if (runtime) await stopE2eServerTree(runtime)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
}
