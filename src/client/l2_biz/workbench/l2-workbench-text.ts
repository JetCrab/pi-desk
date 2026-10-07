'use client'

import { L2_WORKBENCH_LOCALE_MESSAGES } from '@common/l2_biz/workbench/l2-workbench-locale-messages'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'

export function l2WorkbenchText(
  key: keyof (typeof L2_WORKBENCH_LOCALE_MESSAGES)['zh-CN'],
  params?: Record<string, string | number>
): string {
  return l4LocalizedErrorMessage({
    msg: L2_WORKBENCH_LOCALE_MESSAGES['zh-CN'][key],
    i18n: { key: `workbench:${key}`, ...(params ? { params } : {}) }
  })
}
