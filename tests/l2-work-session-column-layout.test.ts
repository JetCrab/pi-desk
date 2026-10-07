import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateL2WorkSessionColumnModes,
  calculateL2WorkSessionExpandedColumnCount
} from '../src/client/l2_biz/workbench/l2-work-session-column-layout'

function expandedIndexes(modes: readonly ('expanded' | 'collapsed')[]): number[] {
  return modes.flatMap((mode, index) => (mode === 'expanded' ? [index] : []))
}

test('根据 300px 展开列和 48px 折叠列计算最大展开数量', () => {
  assert.equal(calculateL2WorkSessionExpandedColumnCount(1_800, 6), 6)
  assert.equal(calculateL2WorkSessionExpandedColumnCount(1_799, 6), 5)
  assert.equal(calculateL2WorkSessionExpandedColumnCount(1_548, 6), 5)
  assert.equal(calculateL2WorkSessionExpandedColumnCount(1_547, 6), 4)
  assert.equal(calculateL2WorkSessionExpandedColumnCount(588, 7), 1)
  assert.equal(calculateL2WorkSessionExpandedColumnCount(0, 0), 0)
})

test('没有保护位置时始终从最右侧开始折叠', () => {
  assert.deepEqual(expandedIndexes(calculateL2WorkSessionColumnModes(6, 4, null)), [0, 1, 2, 3])
})

test('点击最右侧折叠位置后跳过该位置并继续向左折叠', () => {
  assert.deepEqual(expandedIndexes(calculateL2WorkSessionColumnModes(6, 4, 5)), [0, 1, 2, 5])
})

test('保护位置变化后原保护位置重新参与从右向左折叠', () => {
  assert.deepEqual(expandedIndexes(calculateL2WorkSessionColumnModes(6, 4, 4)), [0, 1, 2, 4])
  assert.deepEqual(expandedIndexes(calculateL2WorkSessionColumnModes(6, 4, 3)), [0, 1, 2, 3])
})

test('窗口继续缩小时仍保护同一位置并折叠右侧其他位置', () => {
  assert.deepEqual(expandedIndexes(calculateL2WorkSessionColumnModes(6, 3, 5)), [0, 1, 5])
})

test('只允许一个展开位置时被保护位置独占展开空间', () => {
  assert.deepEqual(expandedIndexes(calculateL2WorkSessionColumnModes(6, 1, 5)), [5])
})
