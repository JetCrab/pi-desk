'use client'

import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { L4_DEFAULT_THEME, type L4Theme } from '@common/l4_foundation/theme/l4-theme'
import { L4ChoiceGroup } from '@client/l4_foundation/ui/l4-choice-group'
import {
  readL4Theme,
  saveL4Theme,
  subscribeL4Theme
} from '@client/l4_foundation/theme/l4-theme-provider'
import { L4_DEFAULT_DISPLAY_SIZE, type L4DisplaySize } from '@common/l4_foundation/l4-display-size'
import {
  readL4DisplaySize,
  saveL4DisplaySize,
  subscribeL4DisplaySize
} from '@client/l4_foundation/ui/l4-display-size-provider'
import { L3ConversationMarkdown } from '@client/l3_modules/conversation/l3-conversation-markdown'
import { saveL4PowerSaving, useL4PowerSaving } from '@client/l4_foundation/ui/l4-power-saving'

const THEME_OPTIONS = [
  { value: 'system', label: 'common:system', icon: MonitorIcon },
  { value: 'light', label: 'themeLight', icon: SunIcon },
  { value: 'dark', label: 'themeDark', icon: MoonIcon }
] as const

const DISPLAY_SIZE_OPTIONS = [
  { value: 'compact', label: 'sizeCompact' },
  { value: 'standard', label: 'sizeStandard' },
  { value: 'large', label: 'sizeLarge' }
] as const

export function L2AppearanceSettings(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const theme = useSyncExternalStore(subscribeL4Theme, readL4Theme, () => L4_DEFAULT_THEME)
  const powerSaving = useL4PowerSaving()
  const size = useSyncExternalStore(
    subscribeL4DisplaySize,
    readL4DisplaySize,
    () => L4_DEFAULT_DISPLAY_SIZE
  )

  return (
    <section aria-labelledby="settings-appearance-title" className="@container grid gap-6">
      <h2 id="settings-appearance-title" className="text-xl font-semibold">
        {t('appearance')}
      </h2>
      <div className="grid min-w-0 gap-6 @min-[40rem]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="min-w-0 space-y-4">
          <div className="space-y-2 border-b pb-4">
            <h3 className="text-sm font-medium">{t('theme')}</h3>
            <L4ChoiceGroup<L4Theme>
              label={t('theme')}
              layout="segmented"
              value={theme}
              options={THEME_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))}
              onChange={saveL4Theme}
            />
          </div>
          <div className="space-y-2 border-b pb-4">
            <h3 className="text-sm font-medium">{t('displaySize')}</h3>
            <L4ChoiceGroup<L4DisplaySize>
              label={t('displaySize')}
              layout="segmented"
              value={size}
              options={DISPLAY_SIZE_OPTIONS.map((option) => ({
                ...option,
                label: t(option.label)
              }))}
              onChange={saveL4DisplaySize}
            />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t('powerSaving')}</h3>
            <L4ChoiceGroup<'off' | 'on'>
              label={t('powerSaving')}
              layout="segmented"
              value={powerSaving ? 'on' : 'off'}
              options={[
                { value: 'off', label: t('powerSavingOff'), testId: 'power-saving-off' },
                { value: 'on', label: t('powerSavingOn'), testId: 'power-saving-on' }
              ]}
              onChange={(value) => saveL4PowerSaving(value === 'on')}
            />
          </div>
        </div>
        <div className="min-w-0 space-y-2">
          <h3 className="text-sm font-medium">{t('displayPreview')}</h3>
          <div aria-label={t('displayPreview')} className="min-w-0 rounded-xl bg-muted p-4">
            <L3ConversationMarkdown mode="static" isAnimating={false}>
              {t('displayPreviewContent')}
            </L3ConversationMarkdown>
          </div>
        </div>
      </div>
    </section>
  )
}
