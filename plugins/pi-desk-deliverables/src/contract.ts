export interface DeliverableItem {
  path: string
  title: string
  // 旧记录缺少类型，按文件处理。
  kind?: 'file' | 'directory'
}

export interface DeliverableBatch {
  entryId: string
  items: DeliverableItem[]
}

export interface DeliverableListResult {
  deliveries: DeliverableBatch[]
  hasMore: boolean
}
