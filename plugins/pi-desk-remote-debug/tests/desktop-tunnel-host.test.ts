import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { resolveDesktopTunnelHost } from '../src/desktop-tunnel-host.js'

test('未由桌面托管时不伪造隧道能力', () => {
  assert.equal(resolveDesktopTunnelHost({ NODE_ENV: 'test' }), null)
})

test('桌面能力只使用显式注入的程序与配置路径', () => {
  const executable = resolve('temp/fixture/desktop.exe')
  const configPath = resolve('temp/fixture/config.json')
  assert.deepEqual(
    resolveDesktopTunnelHost({
      NODE_ENV: 'test',
      PI_DESK_DESKTOP_EXECUTABLE: executable,
      PI_DESK_DESKTOP_CONFIG: configPath
    }),
    { executable, configPath }
  )
})

test('不完整或相对路径的能力配置明确失败', () => {
  assert.throws(() =>
    resolveDesktopTunnelHost({
      NODE_ENV: 'test',
      PI_DESK_DESKTOP_EXECUTABLE: resolve('desktop.exe')
    })
  )
  assert.throws(() =>
    resolveDesktopTunnelHost({
      NODE_ENV: 'test',
      PI_DESK_DESKTOP_EXECUTABLE: 'desktop.exe',
      PI_DESK_DESKTOP_CONFIG: 'config.json'
    })
  )
})
