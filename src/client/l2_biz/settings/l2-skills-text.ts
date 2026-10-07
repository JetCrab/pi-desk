'use client'

import { L2_SKILLS_MESSAGES } from '@common/l2_biz/settings/l2-skills-messages'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'

export function l2SkillsText(key: keyof (typeof L2_SKILLS_MESSAGES)['zh-CN']): string {
  return l4LocalizedErrorMessage({
    msg: L2_SKILLS_MESSAGES['zh-CN'][key],
    i18n: { key: `skills:${key}` }
  })
}
