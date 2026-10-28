import type { L2WorkbenchBranchTreeFilter } from './l2-workbench-branch-tree'

const STORAGE_KEY = 'pi-desk:workbench-branch-filter'

export const L2_WORKBENCH_BRANCH_FILTER_OPTIONS: ReadonlyArray<{
  value: L2WorkbenchBranchTreeFilter
  label: string
}> = [
  { value: 'default', label: 'filterDefault' },
  { value: 'no-tools', label: 'filterNoTools' },
  { value: 'user-only', label: 'filterUserOnly' },
  { value: 'labeled-only', label: 'filterLabeled' },
  { value: 'all', label: 'filterAll' }
]

export function loadL2WorkbenchBranchFilter(): L2WorkbenchBranchTreeFilter {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    return (
      L2_WORKBENCH_BRANCH_FILTER_OPTIONS.find((option) => option.value === saved)?.value ??
      'default'
    )
  } catch {
    return 'default'
  }
}

export function saveL2WorkbenchBranchFilter(filter: L2WorkbenchBranchTreeFilter): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, filter)
  } catch (error) {
    console.warn('[Pi Desk][Workbench] 保存分支筛选失败，仅当前选择器生效', error)
  }
}
