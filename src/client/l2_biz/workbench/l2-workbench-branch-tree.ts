import type { L2WorkSessionTreeNode } from '@common/l2_biz/work-session/l2-work-session-tree-contract'

export type L2WorkbenchBranchTreeFilter =
  'default' | 'no-tools' | 'user-only' | 'labeled-only' | 'all'

export interface L2WorkbenchBranchTreeRow {
  node: L2WorkSessionTreeNode
  depth: number
  active: boolean
  current: boolean
  hasChildren: boolean
  foldable: boolean
  expanded: boolean
  connector: boolean
  lastSibling: boolean
  visibleParentEntryId: string | null
}

interface IndexedTreeNode {
  node: L2WorkSessionTreeNode
  index: number
}

const DEFAULT_HIDDEN_KINDS = new Set<L2WorkSessionTreeNode['kind']>([
  'custom',
  'model_change',
  'thinking_level_change',
  'session_info',
  'label'
])

function activePath(
  nodesById: ReadonlyMap<string, IndexedTreeNode>,
  leafEntryId: string | null
): Set<string> {
  const active = new Set<string>()
  let current = leafEntryId
  while (current && !active.has(current)) {
    const indexed = nodesById.get(current)
    if (!indexed) break
    active.add(current)
    current = indexed.node.parentEntryId
  }
  return active
}

function filterAllows(
  node: L2WorkSessionTreeNode,
  filter: L2WorkbenchBranchTreeFilter,
  leafEntryId: string | null
): boolean {
  if (node.kind === 'assistant' && !node.preview && node.entryId !== leafEntryId) return false
  switch (filter) {
    case 'default':
      return !DEFAULT_HIDDEN_KINDS.has(node.kind)
    case 'no-tools':
      return !DEFAULT_HIDDEN_KINDS.has(node.kind) && node.kind !== 'tool'
    case 'user-only':
      return node.kind === 'user'
    case 'labeled-only':
      return node.label !== null
    case 'all':
      return true
  }
}

function queryAllows(node: L2WorkSessionTreeNode, query: string): boolean {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const text = [node.kind, node.preview, node.label ?? ''].join(' ').toLocaleLowerCase()
  return tokens.every((token) => text.includes(token))
}

function compareNodes(
  left: IndexedTreeNode,
  right: IndexedTreeNode,
  active: ReadonlySet<string>
): number {
  const activeDifference =
    Number(!active.has(left.node.entryId)) - Number(!active.has(right.node.entryId))
  if (activeDifference !== 0) return activeDifference
  const timestampDifference = left.node.timestampMs - right.node.timestampMs
  return timestampDifference !== 0 ? timestampDifference : left.index - right.index
}

export function buildL2WorkbenchBranchTreeRows(input: {
  nodes: readonly L2WorkSessionTreeNode[]
  leafEntryId: string | null
  filter: L2WorkbenchBranchTreeFilter
  query: string
  foldedEntryIds: ReadonlySet<string>
}): L2WorkbenchBranchTreeRow[] {
  const nodesById = new Map<string, IndexedTreeNode>()
  input.nodes.forEach((node, index) => nodesById.set(node.entryId, { node, index }))
  const active = activePath(nodesById, input.leafEntryId)
  const visible = new Set(
    input.nodes
      .filter(
        (node) =>
          filterAllows(node, input.filter, input.leafEntryId) && queryAllows(node, input.query)
      )
      .map((node) => node.entryId)
  )
  const childrenByParent = new Map<string | null, IndexedTreeNode[]>()
  const visibleParentByEntryId = new Map<string, string | null>()

  for (const indexed of nodesById.values()) {
    if (!visible.has(indexed.node.entryId)) continue
    let parentEntryId = indexed.node.parentEntryId
    const visitedParents = new Set<string>()
    while (parentEntryId && !visible.has(parentEntryId)) {
      if (visitedParents.has(parentEntryId)) {
        parentEntryId = null
        break
      }
      visitedParents.add(parentEntryId)
      parentEntryId = nodesById.get(parentEntryId)?.node.parentEntryId ?? null
    }
    if (parentEntryId === indexed.node.entryId) parentEntryId = null
    visibleParentByEntryId.set(indexed.node.entryId, parentEntryId)
    const children = childrenByParent.get(parentEntryId) ?? []
    children.push(indexed)
    childrenByParent.set(parentEntryId, children)
  }

  for (const children of childrenByParent.values()) {
    children.sort((left, right) => compareNodes(left, right, active))
  }

  const rows: L2WorkbenchBranchTreeRow[] = []
  const visited = new Set<string>()
  const appendRoots = (roots: readonly IndexedTreeNode[]): void => {
    const stack = [...roots]
      .reverse()
      .map((indexed) => ({ indexed, depth: 0, connector: false, lastSibling: true }))
    while (stack.length > 0) {
      const current = stack.pop()!
      const entryId = current.indexed.node.entryId
      if (visited.has(entryId)) continue
      visited.add(entryId)
      const children = childrenByParent.get(entryId) ?? []
      const parentEntryId = visibleParentByEntryId.get(entryId) ?? null
      const siblings = parentEntryId === null ? [] : (childrenByParent.get(parentEntryId) ?? [])
      const foldable = children.length > 0 && (parentEntryId === null || siblings.length > 1)
      const expanded = !foldable || !input.foldedEntryIds.has(entryId)
      rows.push({
        node: current.indexed.node,
        depth: current.depth,
        active: active.has(entryId),
        current: entryId === input.leafEntryId,
        hasChildren: children.length > 0,
        foldable,
        expanded,
        connector: current.connector,
        lastSibling: current.lastSibling,
        visibleParentEntryId: visibleParentByEntryId.get(entryId) ?? null
      })
      if (!expanded) continue
      const branched = children.length > 1
      for (const [reverseIndex, child] of [...children].reverse().entries()) {
        const childIndex = children.length - reverseIndex - 1
        stack.push({
          indexed: child,
          depth: current.depth + (branched ? 1 : 0),
          connector: branched,
          lastSibling: childIndex === children.length - 1
        })
      }
    }
  }

  appendRoots(childrenByParent.get(null) ?? [])
  return rows
}

export function resolveL2WorkbenchBranchTreeDraft(
  currentText: string,
  selectedUserText: string | null
): string {
  return selectedUserText ?? currentText
}

export function findNearestL2WorkbenchBranchTreeEntryId(
  nodes: readonly L2WorkSessionTreeNode[],
  rows: readonly L2WorkbenchBranchTreeRow[],
  targetEntryId: string | null
): string | null {
  if (rows.length === 0) return null
  const visible = new Set(rows.map((row) => row.node.entryId))
  const nodesById = new Map(nodes.map((node) => [node.entryId, node]))
  let current = targetEntryId
  const visited = new Set<string>()
  while (current && !visited.has(current)) {
    if (visible.has(current)) return current
    visited.add(current)
    current = nodesById.get(current)?.parentEntryId ?? null
  }
  return rows.at(-1)?.node.entryId ?? null
}
