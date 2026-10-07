import assert from 'node:assert/strict'
import test from 'node:test'
import { shellInvocation } from '../src/process.js'

test('Remote Debug 独立使用 Windows Bash 与包管理器 cmd shim', () => {
  const invocation = shellInvocation('pnpm dev', 'win32', { NODE_ENV: 'test' })

  assert.equal(invocation.shell, 'bash.exe')
  assert.equal(invocation.args[0], '-c')
  assert.match(invocation.args[1]!, /pnpm\.cmd/)
  assert.match(invocation.args[1]!, /pnpm dev/)
})

test('非 Windows 使用当前 Shell', () => {
  assert.deepEqual(shellInvocation('pnpm dev', 'linux', { SHELL: '/bin/zsh' }), {
    shell: '/bin/zsh',
    args: ['-c', 'pnpm dev']
  })
})
