import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runAsync, runPackageTasks, selectPackages } from './release-npm.mjs'

const root = resolve(import.meta.dirname, '../..')
const targets = JSON.parse(process.env.CHECK_PLUGINS_JSON)
const built = new Set(JSON.parse(process.env.CHECK_BUILT_PACKAGES || '[]'))
assert.ok(Array.isArray(targets))
const all = await selectPackages(root, 'all')
const selected = all.filter((entry) => {
  const name = entry.manifest.name.slice('@jetcrab/'.length)
  return (
    name !== 'pi-desk' && !built.has(name) && (targets.includes('all') || targets.includes(name))
  )
})
if (selected.length) {
  const sdk = all.find(({ manifest }) => manifest.name === '@jetcrab/pi-desk-sdk')
  await runAsync('pnpm', ['--dir', sdk.directory, 'build'], {
    env: { ...process.env, TSX_TSCONFIG_PATH: join(sdk.directory, 'tsconfig.json') }
  })
  await runPackageTasks(selected, async (entry) => {
    const agent = join(
      root,
      'temp/pi/plugin-checks',
      process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
        : `local-${process.pid}`,
      entry.manifest.name.slice('@jetcrab/'.length),
      'agent'
    )
    const env = {
      ...process.env,
      TSX_TSCONFIG_PATH: join(entry.directory, 'tsconfig.json'),
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: join(agent, 'sessions')
    }
    if (entry === sdk) {
      const tests = (await readdir(join(entry.directory, 'tests')))
        .filter((file) => file.endsWith('.test.mjs'))
        .map((file) => join('tests', file))
      await runAsync(process.execPath, ['--test', ...tests], { cwd: entry.directory, env })
    } else {
      await runAsync('pnpm', ['--dir', entry.directory, 'build'], { env })
      if (entry.manifest.scripts?.test)
        await runAsync('pnpm', ['--dir', entry.directory, 'test'], { env })
    }
    console.info(`插件检查通过：${entry.manifest.name}`)
  })
}
