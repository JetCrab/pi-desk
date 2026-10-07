import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { assertPortReleased } from './l4-e2e-server-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

for (const fail of [false, true]) {
  test(`候选包隔离检查${fail ? '提前退出时失败' : '健康后成功'}且释放资源`, async (context) => {
    const parent = join(projectRoot, 'temp', 'tests', 'desktop-preflight')
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(join(parent, 'package-check-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    const bin = join(root, 'bin')
    const temporary = join(root, 'temp')
    const originalAgent = join(root, 'original-agent')
    const evidence = join(root, 'fixture.json')
    await Promise.all([bin, temporary, originalAgent].map((path) => mkdir(path)))
    await writeFile(join(originalAgent, 'settings.json'), '{"sentinel":true}')
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        version: '1.2.3',
        devDependencies: { '@earendil-works/pi-coding-agent': '1.0.1' }
      })
    )
    for (const file of [
      'bin/pi-desk-preflight.js',
      'src/server/l1_entry/node/l1-preflight.js',
      'src/server/l4_foundation/process/l4-process-tree.js',
      'src/server/l4_foundation/process/l4-package-root.js',
      'src/server/l4_foundation/pi/l4-pi-global-runtime.js'
    ]) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await copyFile(join(projectRoot, file), join(root, file))
    }
    await writeFile(
      join(bin, 'pi-desk.js'),
      `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
assert.ok(process.argv.includes('--safe-mode'));
assert.ok(process.argv.includes('--no-open'));
assert.notEqual(process.env.PI_CODING_AGENT_DIR, ${JSON.stringify(originalAgent)});
assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, path.join(process.env.PI_CODING_AGENT_DIR, 'sessions'));
assert.equal(process.env.PI_DESK_LOG_FILE, '');
const port = Number(process.argv[process.argv.indexOf('-p') + 1]);
fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ port, pid: process.pid, agentDir: process.env.PI_CODING_AGENT_DIR }));
if (${fail}) {
  console.error('fixture-start-failed');
  process.exit(9);
}
const server = http.createServer((req, res) => {
  assert.equal(req.url, '/api/health');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ code: 0, data: { application: 'Pi Desk', status: 'ready', version: '1.2.3' } }));
});
server.listen(port, '127.0.0.1');
process.on('message', (message) => {
  if (message === 'pi-desk.shutdown') server.close(() => process.disconnect());
});
`
    )
    let result
    let failure
    try {
      result = await execFileAsync(process.execPath, [join(bin, 'pi-desk-preflight.js')], {
        cwd: root,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: originalAgent,
          PI_CODING_AGENT_SESSION_DIR: join(originalAgent, 'sessions'),
          PI_DESK_LOG_FILE: join(originalAgent, 'service.log')
        },
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      })
    } catch (error) {
      failure = error
    }
    if (fail) {
      assert.equal(failure?.code, 1, failure?.stderr)
      assert.match(failure.stderr, /候选服务提前退出/)
      assert.match(failure.stderr, /fixture-start-failed/)
    } else {
      assert.equal(failure, undefined, failure?.stderr)
      assert.match(result.stdout, /候选包健康检查通过/)
    }
    const probe = JSON.parse(await readFile(evidence, 'utf8'))
    await assertPortReleased(probe.port)
    assert.throws(() => process.kill(probe.pid, 0), { code: 'ESRCH' })
    assert.deepEqual(await readdir(temporary), [])
    assert.deepEqual(await readdir(originalAgent), ['settings.json'])
    assert.equal(await readFile(join(originalAgent, 'settings.json'), 'utf8'), '{"sentinel":true}')
  })
}
