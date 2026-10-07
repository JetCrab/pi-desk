import 'server-only'

import type { SessionEntry } from '@earendil-works/pi-coding-agent'

export const L4_PI_MAIN_BRANCH_ID = 'v1:main'

export type L4PiBranchEntry = Pick<SessionEntry, 'id' | 'parentId'>

export interface L4PendingBranchAppend {
  parentEntryId: string | null
  branchId: string
  childOrdinal: number
}

function forkBranchId(parentEntryId: string, childOrdinal: number): string {
  return `v1:fork:e:${encodeURIComponent(parentEntryId)}:${childOrdinal}`
}

function rootBranchId(rootOrdinal: number): string {
  return rootOrdinal === 1 ? L4_PI_MAIN_BRANCH_ID : `v1:fork:r:${rootOrdinal}`
}

/** Volatile branch index built once from JSONL append order and updated incrementally. */
export class L4PiSessionBranchIndex {
  private readonly entryIds = new Set<string>()
  private readonly branchIdByEntryId = new Map<string, string>()
  private readonly childCountByParentId = new Map<string | null, number>()

  constructor(entries: readonly L4PiBranchEntry[]) {
    for (const entry of entries) this.appendEntry(entry)
  }

  branchIdForEntry(entryId: string): string {
    const branchId = this.branchIdByEntryId.get(entryId)
    if (!branchId) throw new Error(`Pi session entry has no branch identity: ${entryId}`)
    return branchId
  }

  branchIdForHead(entryId: string | null): string {
    return entryId === null ? L4_PI_MAIN_BRANCH_ID : this.branchIdForEntry(entryId)
  }

  predictAppend(parentEntryId: string | null): L4PendingBranchAppend {
    if (parentEntryId !== null && !this.entryIds.has(parentEntryId)) {
      throw new Error(`Cannot append to missing Pi session parent: ${parentEntryId}`)
    }

    const childOrdinal = (this.childCountByParentId.get(parentEntryId) ?? 0) + 1
    return {
      parentEntryId,
      childOrdinal,
      branchId: this.branchIdForChild(parentEntryId, childOrdinal)
    }
  }

  appendEntry(entry: L4PiBranchEntry): L4PendingBranchAppend {
    this.assertEntry(entry)
    const append = this.predictAppend(entry.parentId)

    this.entryIds.add(entry.id)
    this.branchIdByEntryId.set(entry.id, append.branchId)
    this.childCountByParentId.set(entry.parentId, append.childOrdinal)
    return append
  }

  confirmAppend(pending: L4PendingBranchAppend, entry: L4PiBranchEntry): string {
    const actual = this.predictAppend(entry.parentId)
    if (
      pending.parentEntryId !== actual.parentEntryId ||
      pending.childOrdinal !== actual.childOrdinal ||
      pending.branchId !== actual.branchId
    ) {
      throw new Error(
        `Pi branch append conflict: expected ${pending.branchId}/${pending.childOrdinal}, got ${actual.branchId}/${actual.childOrdinal}`
      )
    }

    this.appendEntry(entry)
    return actual.branchId
  }

  private branchIdForChild(parentEntryId: string | null, childOrdinal: number): string {
    if (parentEntryId === null) return rootBranchId(childOrdinal)
    if (childOrdinal === 1) return this.branchIdForEntry(parentEntryId)
    return forkBranchId(parentEntryId, childOrdinal)
  }

  private assertEntry(entry: L4PiBranchEntry): void {
    if (!entry.id) throw new Error('Pi session entry is missing an id')
    if (this.entryIds.has(entry.id)) {
      throw new Error(`Pi session contains duplicate entry id: ${entry.id}`)
    }
    if (entry.parentId !== null && (!entry.parentId || !this.entryIds.has(entry.parentId))) {
      throw new Error(`Pi session entry ${entry.id} has missing parent: ${entry.parentId}`)
    }
  }
}
