export interface DeliverableItem {
  path: string
  title: string
}

export interface DeliverableBatch {
  entryId: string
  items: DeliverableItem[]
}

export interface DeliverableListResult {
  deliveries: DeliverableBatch[]
  hasMore: boolean
}
