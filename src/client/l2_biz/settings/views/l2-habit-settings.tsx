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
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Switch } from '@client/l4_foundation/ui/shadcn/switch'
import { useL2CompletionReminderSettings } from '../hooks/l2-use-completion-reminder-settings'

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
  const reminders = useL2CompletionReminderSettings()
  const desktop = reminders.platform === 'windows' || reminders.platform === 'macos'
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
      <section aria-labelledby="completion-reminder-title" className="min-w-0 border-t pt-4">
        <h3 id="completion-reminder-title" className="text-sm font-semibold">
          {t('completionReminders')}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('completionRemindersDescription')}</p>
        <div className="mt-3 grid gap-2">
          <label className="flex min-h-8 cursor-pointer items-center justify-between gap-4 text-sm">
            {t('reminderSystem')}
            <Switch
              checked={reminders.preferences.system}
              onCheckedChange={reminders.setSystem}
              aria-label={t('reminderSystem')}
              disabled={reminders.busy}
            />
          </label>
          {reminders.preferences.system && reminders.permission === 'default' ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>{t('reminderPermissionNeeded')}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={reminders.busy}
                onClick={reminders.authorize}
              >
                {t('reminderAuthorize')}
              </Button>
            </div>
          ) : null}
          {reminders.preferences.system &&
          (reminders.permission === 'denied' || reminders.permission === 'unsupported') ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t(
                reminders.permission === 'denied'
                  ? 'reminderPermissionDenied'
                  : 'reminderUnsupported'
              )}
            </p>
          ) : null}
          <label className="flex min-h-8 cursor-pointer items-center justify-between gap-4 text-sm">
            {t('reminderSound')}
            <Switch
              checked={reminders.preferences.sound}
              onCheckedChange={reminders.setSound}
              aria-label={t('reminderSound')}
              disabled={reminders.busy}
            />
          </label>
          {desktop ? (
            <label className="flex min-h-8 cursor-pointer items-center justify-between gap-4 text-sm">
              {t(reminders.platform === 'macos' ? 'reminderDock' : 'reminderTaskbar')}
              <Switch
                checked={reminders.preferences.attention}
                onCheckedChange={reminders.setAttention}
                aria-label={t(reminders.platform === 'macos' ? 'reminderDock' : 'reminderTaskbar')}
                disabled={reminders.busy}
              />
            </label>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={
              reminders.busy ||
              !(
                reminders.preferences.system ||
                reminders.preferences.sound ||
                (desktop && reminders.preferences.attention)
              )
            }
            onClick={() => reminders.test(t('reminderTitle'), t('reminderTestBody'))}
          >
            {t('reminderTest')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('reminderSystemSettings')}</span>
        </div>
        {reminders.error ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {t('reminderFailed')}
          </p>
        ) : null}
      </section>
    </section>
  )
}
