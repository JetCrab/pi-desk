import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { bundleL4ServerModule } from './l4-webpack-test-runtime.mjs'

const execute = promisify(execFile)

test('系统导航指向主包文档与实际 SDK，从无关工作目录仍可读取', async (context) => {
  const id = `sdk-path-${randomUUID()}`
  const build = resolve('temp/build/pidesk-runtime', id)
  const run = resolve('temp/run/pidesk-runtime', id)
  const agent = resolve('temp/pi/pidesk-runtime', id, 'agent')
  const sdkManifest = JSON.parse(await readFile('plugins/pi-desk-sdk/package.json', 'utf8'))
  let passed = true
  try {
    await bundleL4ServerModule(build, './src/server/l4_foundation/pidesk/l4-pidesk-runtime.ts')
    for (const linked of [false, true]) {
      await context.test(linked ? 'pnpm 链接安装' : '普通 npm 安装', async () => {
        try {
          const host = join(run, linked ? 'linked' : 'installed', '应用目录 with spaces')
          const sdkLink = join(host, 'node_modules/@jetcrab/pi-desk-sdk')
          const sdk = linked
            ? join(host, 'node_modules/.pnpm/sdk-fixture/node_modules/@jetcrab/pi-desk-sdk')
            : sdkLink
          await mkdir(join(sdk, 'dist'), { recursive: true })
          await mkdir(join(host, 'dist'), { recursive: true })
          await writeFile(join(host, 'package.json'), JSON.stringify({ version: '1.2.3' }))
          await writeFile(join(sdk, 'package.json'), JSON.stringify(sdkManifest))
          await writeFile(join(sdk, 'dist/index.js'), 'export {}\n')
          await cp('docs/pi-desk', join(host, 'docs/pi-desk'), { recursive: true })
          const workspace = join(run, 'unrelated-workspace')
          await mkdir(workspace, { recursive: true })
          if (linked) {
            await mkdir(join(host, 'node_modules/@jetcrab'), { recursive: true })
            await symlink(sdk, sdkLink, process.platform === 'win32' ? 'junction' : 'dir')
          }
          const installedBundle = join(host, 'dist/runtime.mjs')
          await copyFile(join(build, 'runtime.mjs'), installedBundle)
          const isolatedAgent = join(agent, linked ? 'linked' : 'installed')
          const result = await execute(
            process.execPath,
            [
              '--input-type=module',
              '--eval',
              `
              import assert from 'node:assert/strict';
              import { readFile } from 'node:fs/promises';
              import { join } from 'node:path';
              const commands = await import(${JSON.stringify(pathToFileURL(installedBundle).href)});
              try {
                await commands.initializeL4PiDeskCommands(async () => ({ mode: 'sync', message: '' }), false);
                process.chdir(${JSON.stringify(workspace)});
                const base = ['用户原有追加提示'];
                const result = commands.appendL4PiDeskSystemPrompt(base);
                assert.deepEqual(base, ['用户原有追加提示']);
                assert.equal(result[0], base[0]);
                const text = result[1];
                const docs = ${JSON.stringify(join(host, 'docs/pi-desk').replaceAll('\\', '/'))};
                const sdkTypes = ${JSON.stringify(join(sdk, 'dist').replaceAll('\\', '/'))};
                assert.ok(text.includes(docs + '/README.md'));
                assert.equal(text.split(docs + '/').length - 1, 1, '系统提示只提供一个文档入口');
                assert.ok(text.includes(sdkTypes));
                const index = await readFile(docs + '/README.md', 'utf8');
                assert.ok(index.includes('(./commands.md)'));
                assert.ok(index.includes('(./plugins.md)'));
                assert.match(await readFile(docs + '/commands.md', 'utf8'), /mode: async/);
                assert.match(await readFile(docs + '/plugins.md', 'utf8'), /Browser Entry/);
                assert.equal(text.includes('PLUGIN-UI-STANDARD.md'), false);
                assert.equal(text.includes('/skills/'), false);
                console.log('安装态文档导航验证通过');
              } finally {
                commands.disposeL4PiDeskCommands();
              }
            `
            ],
            {
              cwd: host,
              env: {
                ...process.env,
                NODE_ENV: 'production',
                PI_CODING_AGENT_DIR: isolatedAgent,
                PI_CODING_AGENT_SESSION_DIR: join(isolatedAgent, 'sessions')
              },
              timeout: 30_000,
              windowsHide: true
            }
          )
          assert.match(result.stdout, /安装态文档导航验证通过/)
        } catch (error) {
          passed = false
          throw error
        }
      })
    }
  } catch (error) {
    passed = false
    throw error
  } finally {
    if (passed) {
      await Promise.all(
        [build, run, resolve(agent, '..')].map((path) => rm(path, { recursive: true, force: true }))
      )
    } else {
      console.error(`安装态文档导航检查失败，构建：${build}；运行目录：${run}`)
    }
  }
})
