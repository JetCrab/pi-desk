'use client'

import {
  CircleMinusIcon,
  ImageDownIcon,
  ImageIcon,
  MousePointerClickIcon,
  PinIcon
} from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2WorkSessionFileImagePreviewMode } from '@common/l2_biz/work-session/l2-work-session-file-contract'
import {
  readL3ImagePreviewMode,
  saveL3ImagePreviewMode,
  subscribeL3ImagePreviewMode
} from '@client/l3_modules/preferences/l3-work-session-file-preferences'
import {
  readL3NewWorkSessionBehavior,
  saveL3NewWorkSessionBehavior,
  subscribeL3NewWorkSessionBehavior,
  type L3NewWorkSessionBehavior
} from '@client/l3_modules/preferences/l3-work-session-create-preferences'
import { L4ChoiceGroup } from '@client/l4_foundation/ui/l4-choice-group'

const NEW_WORK_SESSION_BEHAVIOR_OPTIONS = [
  {
    value: 'none',
    label: 'behaviorNone',
    description: 'behaviorNoneDescription',
    icon: CircleMinusIcon,
    testId: 'new-work-session-behavior-none'
  },
  {
    value: 'activate',
    label: 'behaviorActivate',
    description: 'behaviorActivateDescription',
    icon: MousePointerClickIcon,
    testId: 'new-work-session-behavior-activate'
  },
  {
    value: 'pin',
    label: 'behaviorPin',
    description: 'behaviorPinDescription',
    icon: PinIcon,
    testId: 'new-work-session-behavior-pin'
  }
] as const

const IMAGE_PREVIEW_MODE_OPTIONS = [
  {
    value: 'compressed',
    label: 'imageCompressed',
    description: 'imageCompressedDescription',
    icon: ImageDownIcon,
    testId: 'image-preview-mode-compressed'
  },
  {
    value: 'original',
    label: 'imageOriginal',
    description: 'imageOriginalDescription',
    icon: ImageIcon,
    testId: 'image-preview-mode-original'
  }
] as const

export function L2HabitSettings(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const newWorkSessionBehavior = useSyncExternalStore(
    subscribeL3NewWorkSessionBehavior,
    readL3NewWorkSessionBehavior,
    readL3NewWorkSessionBehavior
  )
  const imagePreviewMode = useSyncExternalStore(
    subscribeL3ImagePreviewMode,
    readL3ImagePreviewMode,
    readL3ImagePreviewMode
  )

  return (
    <section aria-labelledby="settings-habits-title" className="@container grid min-w-0 gap-6">
      <div>
        <h2 id="settings-habits-title" className="text-xl font-semibold">
          {t('habits')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('browserOnly')}</p>
      </div>
      <div className="grid min-w-0 gap-6 lg:@min-[40rem]:grid-cols-2">
        <section className="hidden min-w-0 lg:block" aria-labelledby="new-session-behavior-title">
          <h3 id="new-session-behavior-title" className="mb-3 text-sm font-semibold">
            {t('newSessionBehavior')}
          </h3>
          <L4ChoiceGroup<L3NewWorkSessionBehavior>
            label={t('newSessionBehavior')}
            value={newWorkSessionBehavior}
            options={NEW_WORK_SESSION_BEHAVIOR_OPTIONS.map((option) => ({
              ...option,
              label: t(option.label),
              description: t(option.description)
            }))}
            onChange={saveL3NewWorkSessionBehavior}
          />
          <p className="mt-3 text-sm text-muted-foreground">{t('desktopOnlyBehavior')}</p>
        </section>
        <section
          className="min-w-0 lg:border-t lg:pt-4 lg:@min-[40rem]:border-t-0 lg:@min-[40rem]:border-l lg:@min-[40rem]:pt-0 lg:@min-[40rem]:pl-6"
          aria-labelledby="image-preview-mode-title"
        >
          <h3 id="image-preview-mode-title" className="mb-3 text-sm font-semibold">
            {t('imagePreviewMode')}
          </h3>
          <L4ChoiceGroup<L2WorkSessionFileImagePreviewMode>
            label={t('imagePreviewMode')}
            value={imagePreviewMode}
            options={IMAGE_PREVIEW_MODE_OPTIONS.map((option) => ({
              ...option,
              label: t(option.label),
              description: t(option.description)
            }))}
            onChange={saveL3ImagePreviewMode}
          />
          <p className="mt-3 text-sm text-muted-foreground">{t('imagePreviewApply')}</p>
        </section>
      </div>
    </section>
  )
}
