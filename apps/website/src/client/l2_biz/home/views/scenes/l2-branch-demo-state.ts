export const originalBranchRequest = '还是包含已完成任务，文件名加上项目名称。'
export const revisedBranchRequest = '只导出未完成任务，文件名也加上项目名称。'
export const branchEntries = [
  {
    id: 'request',
    parent: null,
    kind: '用户',
    text: '给任务列表增加 CSV 导出，包含已完成的任务。',
    depth: 0
  },
  { id: 'clarify', parent: 'request', kind: 'AI', text: '先确认导出范围和文件名。', depth: 0 },
  { id: 'full-request', parent: 'clarify', kind: '用户', text: originalBranchRequest, depth: 1 },
  {
    id: 'working',
    parent: 'full-request',
    kind: 'AI',
    text: '我会调整导出范围和文件名。',
    depth: 1
  },
  { id: 'read', parent: 'working', kind: '工具', text: 'read: src/export.ts', depth: 1 },
  {
    id: 'complete',
    parent: 'read',
    kind: 'AI',
    text: '已包含已完成任务，文件名为 qingzhou-tasks.csv。',
    depth: 1
  },
  {
    id: 'open-request',
    parent: 'clarify',
    kind: '用户',
    text: '先试试只导出未完成任务。',
    depth: 1
  },
  {
    id: 'open-only',
    parent: 'open-request',
    kind: 'AI',
    text: '已保留未完成任务，文件名为 tasks.csv。',
    depth: 1
  },
  { id: 'dates-request', parent: 'complete', kind: '用户', text: '再加一个日期筛选。', depth: 2 }
] as const
export type BranchEntry = (typeof branchEntries)[number]
export type BranchEntryId = BranchEntry['id']
export type BranchConversation = { leaf: BranchEntryId | null; draft: string; sent: string[] }

export function branchPath(leaf: BranchEntryId | null): BranchEntry[] {
  const path: BranchEntry[] = []
  let node = branchEntries.find((entry) => entry.id === leaf)
  while (node) {
    path.unshift(node)
    node = branchEntries.find((entry) => entry.id === node?.parent)
  }
  return path
}
export function selectBranchEntry(id: BranchEntryId): BranchConversation {
  const entry = branchEntries.find((entry) => entry.id === id)!
  return {
    leaf: entry.kind === '用户' ? entry.parent : id,
    draft: entry.kind === '用户' ? entry.text : '',
    sent: []
  }
}
