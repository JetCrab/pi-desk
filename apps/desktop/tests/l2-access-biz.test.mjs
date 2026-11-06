import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import {
  deleteAccessPort,
  formatAccessConnectionInfo,
  openAccessUrl,
  parseAccessConnectionInfo,
  publicAccessUrl,
  saveAccessConnection,
  saveAccessPort,
  setAccessEnabled,
  setAccessMode
} from '../web/l2-access-biz.ts'

let calls
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
beforeEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  calls = []
  mockIPC((command, args) => {
    calls.push({ command, args })
  })
})
afterEach(() => {
  clearMocks()
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else delete globalThis.window
})

test('TCP 发布配置独立于网址，公网端口可留空', async () => {
  await saveAccessPort({
    kind: 'publication',
    originalPort: null,
    localPort: '5432',
    publicPort: '',
    enabled: true
  })
  await saveAccessPort({
    kind: 'publication',
    originalPort: 5432,
    localPort: '5433',
    publicPort: '41001',
    enabled: false
  })
  assert.deepEqual(calls, [
    {
      command: 'apply_tunnel_publication_command',
      args: { originalPort: null, value: { localPort: 5432, publicPort: null, enabled: true } }
    },
    {
      command: 'apply_tunnel_publication_command',
      args: { originalPort: 5432, value: { localPort: 5433, publicPort: 41001, enabled: false } }
    }
  ])
})

test('本地映射保留固定端口和稳定的提供端目标', async () => {
  await saveAccessPort({
    kind: 'forward',
    originalPort: 15432,
    connectionInfo: ` pidesk-tcp://${'AB'.repeat(32)}:5432 `,
    localPort: '15433',
    enabled: true
  })
  assert.deepEqual(calls, [
    {
      command: 'apply_tunnel_forward_command',
      args: {
        originalPort: 15432,
        value: { providerId: 'ab'.repeat(32), remotePort: 5432, localPort: 15433, enabled: true }
      }
    }
  ])
})

test('非法端口和提供端标识不进入原生命令', async () => {
  for (const localPort of ['0', '65536', '1.5', '']) {
    await assert.rejects(
      saveAccessPort({
        kind: 'publication',
        originalPort: null,
        localPort,
        publicPort: '',
        enabled: true
      }),
      /本机端口/
    )
  }
  await assert.rejects(
    saveAccessPort({
      kind: 'publication',
      originalPort: null,
      localPort: '5432',
      publicPort: '0',
      enabled: true
    }),
    /公网端口/
  )
  await assert.rejects(
    saveAccessPort({
      kind: 'forward',
      originalPort: null,
      localPort: '15432',
      connectionInfo: 'not-a-provider',
      enabled: true
    }),
    /连接信息/
  )
  assert.equal(calls.length, 0)
})

test('连接信息只包含目标公钥和端口，粘贴后恢复稳定目标', () => {
  const info = formatAccessConnectionInfo('ab'.repeat(32), 5432)
  assert.equal(info, `pidesk-tcp://${'ab'.repeat(32)}:5432`)
  assert.deepEqual(parseAccessConnectionInfo(` ${info}\n`), {
    providerId: 'ab'.repeat(32),
    remotePort: 5432
  })
  for (const input of [
    '',
    `https://${'ab'.repeat(32)}:5432`,
    `pidesk-tcp://token@${'ab'.repeat(32)}:5432`,
    `pidesk-tcp://${'ab'.repeat(32)}:0`,
    `pidesk-tcp://${'ab'.repeat(32)}:65536`,
    `pidesk-tcp://${'ab'.repeat(32)}:5432/path`,
    `pidesk-tcp://${'ab'.repeat(32)}:5432?key=secret`
  ])
    assert.throws(() => parseAccessConnectionInfo(input), /连接信息|目标端口/)
})

test('只对已有本机网页生成公网链接，保留路径且不猜测TCP协议', async () => {
  assert.equal(
    publicAccessUrl(
      ['http://127.0.0.1:30333/project?tab=files#preview'],
      30333,
      'test.example:20013'
    ),
    'http://test.example:20013/project?tab=files#preview'
  )
  assert.equal(
    publicAccessUrl(['https://localhost:3443/'], 3443, '[2001:db8::1]:20014'),
    'https://[2001:db8::1]:20014/'
  )
  assert.equal(publicAccessUrl([], 5432, 'test.example:20013'), null)
  assert.equal(publicAccessUrl(['http://remote.example:5432'], 5432, 'test.example:20013'), null)
  await openAccessUrl('https://test.example:20014/path')
  assert.deepEqual(calls, [
    { command: 'open_external_url_command', args: { url: 'https://test.example:20014/path' } }
  ])
})

test('连接设置、端口启停和策略使用统一 IPC 入口', async () => {
  await saveAccessConnection({
    controlServerUrl: 'http://control.example:7001',
    controlKey: 'ab'.repeat(32)
  })
  await setAccessEnabled('publication', 5432, false)
  await setAccessEnabled('forward', 15432, true)
  await deleteAccessPort('publication', 5432)
  await deleteAccessPort('forward', 15432)
  await setAccessMode('relay-only')
  assert.deepEqual(calls, [
    {
      command: 'apply_tunnel_connection_command',
      args: {
        value: { controlServerUrl: 'http://control.example:7001', controlKey: 'ab'.repeat(32) }
      }
    },
    {
      command: 'set_tunnel_publication_enabled_command',
      args: { localPort: 5432, enabled: false }
    },
    { command: 'set_tunnel_forward_enabled_command', args: { localPort: 15432, enabled: true } },
    { command: 'delete_tunnel_publication_command', args: { localPort: 5432 } },
    { command: 'delete_tunnel_forward_command', args: { localPort: 15432 } },
    { command: 'set_tunnel_mode_command', args: { mode: 'relay-only' } }
  ])
})
