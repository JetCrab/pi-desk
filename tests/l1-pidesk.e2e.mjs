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
  } finally {
    const cleanup = await Promise.allSettled([
      runtime ? stopE2eServerTree(runtime) : Promise.resolve(),
      fixture ? fixture.close() : Promise.resolve()
    ])
    const errors = cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason)
    await writeFile(join(root, 'server.log'), output).catch((error) => {
      console.warn(`验收日志写入失败：${root}；${error.message}`)
    })
    if (errors.length) {
      console.warn('命令验收收尾未完成，保留功能验收结果', errors)
    } else if (passed) {
      for (const path of [root, agentRoot]) {
        await rm(path, { recursive: true, force: true }).catch((error) => {
          console.warn(`验收临时目录清理未完成：${path}；${error.message}`)
        })
      }
    }
    if (!passed || errors.length) console.error(`命令验收诊断目录：${root}`)
  }
})
