import assert from 'node:assert/strict'
import test from 'node:test'
import { computeL4LineChanges } from '../src/client/l4_foundation/ui/code/l4-code-line-changes'

test('空基线为新增，全文清空为删除，两个空文件没有标记', () => {
  assert.deepEqual(computeL4LineChanges('', ''), [])
  assert.deepEqual(computeL4LineChanges('', 'first\nsecond'), [
    {
      kind: 'added',
      originalStartLineNumber: 1,
      originalEndLineNumberExclusive: 1,
      modifiedStartLineNumber: 1,
      modifiedEndLineNumberExclusive: 3
    }
  ])
  assert.deepEqual(computeL4LineChanges('first\nsecond', ''), [
    {
      kind: 'deleted',
      originalStartLineNumber: 1,
      originalEndLineNumberExclusive: 3,
      modifiedStartLineNumber: 1,
      modifiedEndLineNumberExclusive: 1
    }
  ])
})

test('行替换使用修改标记，不将变化块全部当作新增', () => {
  assert.deepEqual(computeL4LineChanges('header\nold value\nfooter', 'header\nnew value\nfooter'), [
    {
      kind: 'modified',
      originalStartLineNumber: 2,
      originalEndLineNumberExclusive: 3,
      modifiedStartLineNumber: 2,
      modifiedEndLineNumberExclusive: 3
    }
  ])
})

test('文件头尾删除保留空的修改侧范围，不染色正常行', () => {
  assert.deepEqual(computeL4LineChanges('deleted\nkeep', 'keep'), [
    {
      kind: 'deleted',
      originalStartLineNumber: 1,
      originalEndLineNumberExclusive: 2,
      modifiedStartLineNumber: 1,
      modifiedEndLineNumberExclusive: 1
    }
  ])
  assert.deepEqual(computeL4LineChanges('keep\ndeleted', 'keep'), [
    {
      kind: 'deleted',
      originalStartLineNumber: 2,
      originalEndLineNumberExclusive: 3,
      modifiedStartLineNumber: 2,
      modifiedEndLineNumberExclusive: 2
    }
  ])
})

test('CRLF和LF不制造整文件变更，真正的空白修改仍可见', () => {
  assert.deepEqual(computeL4LineChanges('first\r\nsecond\r\n', 'first\nsecond\n'), [])
  const changes = computeL4LineChanges('first\n  second\n', 'first\n    second\n')
  assert.equal(changes?.length, 1)
  assert.equal(changes?.[0]?.kind, 'modified')
  assert.equal(changes?.[0]?.modifiedStartLineNumber, 2)
})

test('超出计算大小和行数预算返回不可用，不误报零变更', () => {
  assert.equal(computeL4LineChanges('x'.repeat(2 * 1024 * 1024 + 1), ''), null)
  assert.equal(computeL4LineChanges('x\n'.repeat(50_000), ''), null)
})
