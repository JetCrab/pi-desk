import assert from 'node:assert/strict'
import test from 'node:test'
import headless from '@xterm/headless'
import serialize from '@xterm/addon-serialize'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import {
  L4TerminalOutput,
  splitL4TerminalOutput
} from '../src/server/l4_foundation/terminal/l4-terminal-output'
import { encodeL4TerminalInput } from '../src/server/l4_foundation/terminal/l4-terminal-pty'
import { suppressL4TerminalQueries } from '../src/client/l4_foundation/terminal/l4-terminal-renderer'

const { Terminal } = headless
const { SerializeAddon } = serialize

test('VT分段在完整控制序列边界形成基线且不破坏Unicode', () => {
  const framing = new L4TerminalOutput()
  assert.equal(framing.frame('标题\x1b['), '标题')
  assert.equal(framing.frame('31'), '')
  assert.equal(framing.frame('m红色\x1b]0;窗口'), '\x1b[31m红色')
  assert.equal(framing.frame('标题\x1b'), '')
  assert.equal(framing.frame('\\完成😀'), '\x1b]0;窗口标题\x1b\\完成😀')
  const text = 'a😀中'.repeat(500)
  const chunks = splitL4TerminalOutput(text, 41)
  assert.equal(chunks.join(''), text)
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk) <= 41)
    assert.equal(chunk.isWellFormed(), true)
  }
  framing.dispose()
})

test('键盘Unicode与legacy鼠标坐标在PTY入口保持各自字节语义', () => {
  const mouse = '\x1b[M' + String.fromCharCode(32, 180, 240)
  assert.deepEqual(encodeL4TerminalInput(mouse), Buffer.from([27, 91, 77, 32, 180, 240]))
  assert.deepEqual(
    encodeL4TerminalInput(`中文${mouse}😀`),
    Buffer.concat([Buffer.from('中文'), Buffer.from([27, 91, 77, 32, 180, 240]), Buffer.from('😀')])
  )
})

test('alternate屏幕和光标可恢复，观察端不会重复回答设备查询', async () => {
  const source = new Terminal({ cols: 50, rows: 12, scrollback: 100, allowProposedApi: true })
  const target = new Terminal({ cols: 50, rows: 12, scrollback: 100, allowProposedApi: true })
  const addon = new SerializeAddon()
  source.loadAddon(addon as unknown as import('@xterm/headless').ITerminalAddon)
  const replies: string[] = []
  const authorityReplies: string[] = []
  source.onData((data) => authorityReplies.push(data))
  target.onData((data) => replies.push(data))
  const handlers = suppressL4TerminalQueries(target as unknown as BrowserTerminal)
  const write = (term: typeof source, data: string): Promise<void> =>
    new Promise((resolve) => term.write(data, resolve))
  try {
    await write(
      source,
      '普通回滚\r\n\x1b[?1049h\x1b[2J\x1b[3;4H\x1b[32m全屏界面😀\x1b[0m\x1b[6n\x1b[c'
    )
    assert.ok(authorityReplies.length >= 2)
    await write(target, addon.serialize())
    assert.equal(target.buffer.active.type, 'alternate')
    assert.equal(target.buffer.active.cursorX, source.buffer.active.cursorX)
    assert.equal(target.buffer.active.cursorY, source.buffer.active.cursorY)
    for (let row = 0; row < source.rows; row++) {
      assert.equal(
        target.buffer.active.getLine(row)?.translateToString(true),
        source.buffer.active.getLine(row)?.translateToString(true)
      )
    }
    await write(target, '\x1b[6n\x1b[?6n\x1b[c\x1b[>c\x1b[?25$p\x1bP$qm\x1b\\')
    assert.deepEqual(replies, [], '浏览器不能把查询/恢复当成用户输入')
  } finally {
    for (const handler of handlers) handler.dispose()
    source.dispose()
    target.dispose()
  }
})
