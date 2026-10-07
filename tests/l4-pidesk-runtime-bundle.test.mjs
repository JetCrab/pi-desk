import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { bundleL4ServerModule } from './l4-webpack-test-runtime.mjs'

const execute = promisify(execFile)

test('生产打包后按实际安装目录解析 SDK，支持普通安装和 pnpm 链接布局', async (context) => {
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
          await copyFile('plugins/pi-desk-sdk/README.md', join(sdk, 'README.md'))
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
                const skill = commands.readL4PiDeskSkills()[0];
                const text = await readFile(skill.filePath, 'utf8');
                const readme = ${JSON.stringify(join(sdk, 'README.md').replaceAll('\\', '/'))};
                assert.ok(text.includes(readme), '生成的 Skill 必须指向当前安装目录的 SDK 文档');
                assert.match(await readFile(readme, 'utf8'), /Pi Desk/);
                assert.ok(text.includes('公开类型声明'));
                assert.ok(text.includes('先向用户取得对应版本的 UI 标准及分册'));
                assert.equal(text.includes('PLUGIN-UI-STANDARD.md'), false);
                assert.equal(skill.filePath, join(process.env.PI_CODING_AGENT_DIR, 'pi-desk/skills/pi-desk/SKILL.md'));
                console.log('SDK 路径验证通过');
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
          assert.match(result.stdout, /SDK 路径验证通过/)
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
      console.error(`SDK 路径回归失败，构建：${build}；运行目录：${run}`)
    }
  }
})
