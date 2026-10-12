import { Check } from 'lucide-react'
import type { ReactElement } from 'react'
import styles from './l2-quota-guide-figures.module.css'

export function QuotaGuideSourceFields(): ReactElement {
  return (
    <div className={styles.sourceForm}>
      <div className={styles.field}>
        <span>显示名称</span>
        <div>轻舟项目（示意）</div>
      </div>
      <div className={styles.enabled}>
        <span aria-hidden="true">
          <Check size={12} />
        </span>
        启用来源
      </div>
      <div className={styles.field}>
        <span>API Key</span>
        <div>
          <code>{'<API_KEY_PLACEHOLDER>'}</code>
        </div>
        <small>示例占位符，请使用自己的 OpenCode Go 套餐 Key。</small>
      </div>
    </div>
  )
}
