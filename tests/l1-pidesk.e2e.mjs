import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createPiDeskCommandFixture } from './l4-pidesk-command-smoke.mjs'
import { reservePort, waitForHttp } from './l4-browser-cdp-runtime.mjs'
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

test('真实宿主工具入口完成关键命令、失败恢复和浏览器模块挂载', { timeout: 360_000 }, async () => {
  const projectRoot = resolve(import.meta.dirname, '..')
  const id = `command-lifecycle-${randomUUID()}`
  const root = join(projectRoot, 'temp/run/pidesk-e2e', id)
  const agentRoot = join(projectRoot, 'temp/pi/l1-pidesk', id)
  const agentDir = join(agentRoot, 'agent')
  const port = await reservePort()
  const version = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).version
  let runtime
  let fixture
  let output = ''
  let passed = false
  let failure
  try {
    await mkdir(root, { recursive: true })
    fixture = await createPiDeskCommandFixture(root, agentDir)
    runtime = spawnE2eServer({
      projectRoot,
      agentDir,
      port,
      development: true,
      managed: true,
      environment: { PI_OFFLINE: '1' },
      onOutput: (chunk) => {
        output = `${output}${chunk}`.slice(-2 * 1024 * 1024)
      }
    })
    await waitForHttp(`http://127.0.0.1:${port}/api/health`, 90_000, '验收宿主', () => output)
    await fixture.verify({ port, version })
    passed = true
  } catch (error) {
    failure = error
    throw error
  } finally {
    const cleanup = await Promise.allSettled([
      runtime ? stopE2eServerTree(runtime) : Promise.resolve(),
      fixture ? fixture.close() : Promise.resolve()
    ])
    const errors = cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason)
    await writeFile(join(root, 'server.log'), output)
    if (errors.length) {
      await writeFile(join(root, 'cleanup.log'), errors.map(String).join('\n'))
      if (!failure) throw new AggregateError(errors, '命令验收资源未确认释放')
      console.error('命令验收清理失败', errors)
    } else if (passed) {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(agentRoot, { recursive: true, force: true })
      ])
    }
    if (!passed || errors.length) console.error(`命令验收失败现场：${root}`)
  }
})
