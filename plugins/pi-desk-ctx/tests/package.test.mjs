import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('环境归档仅声明上下文配置文件', () => {
  assert.deepEqual(packageJson.piDesk.environment.files, [
    {
      base: 'config',
      path: 'pi-desk-ctx.json',
      format: 'json',
      secretPaths: []
    }
  ])
})

test('Package 同时声明原生 Extension 与 Pi Desk 设置入口', () => {
  assert.deepEqual(packageJson.pi?.extensions, ['./dist/index.js'])
  assert.equal(packageJson.piDesk?.entry, './dist/pi-desk.js')
})
