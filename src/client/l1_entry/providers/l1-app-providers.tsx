'use client'

import type { ReactNode } from 'react'
import type { HostSettingsSnapshot } from '@jetcrab/pi-desk-sdk/settings'
import { L2_AUTH_MESSAGES } from '@common/l2_biz/auth/l2-auth-messages'
import { L2_CAPABILITY_MODE_MESSAGES } from '@common/l2_biz/capability-modes/l2-capability-mode-messages'
import { L2_PLUGIN_MANAGEMENT_MESSAGES } from '@common/l2_biz/plugin/l2-plugin-management-messages'
import { L2_PROJECT_HISTORY_MESSAGES } from '@common/l2_biz/project-preview/l2-project-history-messages'
import { L2_SETTINGS_MESSAGES } from '@common/l2_biz/settings/l2-settings-messages'
import { L2_SKILLS_MESSAGES } from '@common/l2_biz/settings/l2-skills-messages'
import { L2_TASK_CENTER_MESSAGES } from '@common/l2_biz/task-center/l2-task-center-messages'
import { L2_WORKBENCH_LOCALE_MESSAGES } from '@common/l2_biz/workbench/l2-workbench-locale-messages'
import { L2_WORKBENCH_PICKER_MESSAGES } from '@common/l2_biz/workbench/l2-workbench-picker-messages'
import { L3_CONVERSATION_LOCALE_MESSAGES } from '@common/l3_modules/conversation/l3-conversation-locale-messages'
import { L3_PROJECT_FILES_LOCALE_MESSAGES } from '@common/l3_modules/project-files/l3-project-files-locale-messages'
import { L4_LOCALE_MESSAGES } from '@common/l4_foundation/locale/l4-locale-messages'
import { L4_HOST_ERROR_MESSAGES } from '@common/l4_foundation/locale/l4-host-error-messages'
import { L4ThemeProvider } from '@client/l4_foundation/theme/l4-theme-provider'
import { L4DisplaySizeProvider } from '@client/l4_foundation/ui/l4-display-size-provider'
import { L4CodePreferencesProvider } from '@client/l4_foundation/ui/code/l4-code-preferences-provider'
import { L4RegionProvider } from '@client/l4_foundation/locale/l4-region-provider'
import { L4RegionNotice } from '@client/l4_foundation/locale/l4-region-notice'
import { L4AppToastProvider } from '@client/l4_foundation/ui/l4-app-toast'
import { TooltipProvider } from '@client/l4_foundation/ui/shadcn/tooltip'
import { L1AppRuntimeProvider } from './l1-app-runtime-provider'

const resources = {
  en: {
    ...L4_LOCALE_MESSAGES.en,
    errors: L4_HOST_ERROR_MESSAGES.en,
    auth: L2_AUTH_MESSAGES.en,
    capabilityModes: L2_CAPABILITY_MODE_MESSAGES.en,
    pluginManagement: L2_PLUGIN_MANAGEMENT_MESSAGES.en,
    projectHistory: L2_PROJECT_HISTORY_MESSAGES.en,
    settings: L2_SETTINGS_MESSAGES.en,
    skills: L2_SKILLS_MESSAGES.en,
    taskCenter: L2_TASK_CENTER_MESSAGES.en,
    workbench: L2_WORKBENCH_LOCALE_MESSAGES.en,
    workbenchPicker: L2_WORKBENCH_PICKER_MESSAGES.en,
    conversation: L3_CONVERSATION_LOCALE_MESSAGES.en,
    projectFiles: L3_PROJECT_FILES_LOCALE_MESSAGES.en
  },
  'zh-CN': {
    ...L4_LOCALE_MESSAGES['zh-CN'],
    errors: L4_HOST_ERROR_MESSAGES['zh-CN'],
    auth: L2_AUTH_MESSAGES['zh-CN'],
    capabilityModes: L2_CAPABILITY_MODE_MESSAGES['zh-CN'],
    pluginManagement: L2_PLUGIN_MANAGEMENT_MESSAGES['zh-CN'],
    projectHistory: L2_PROJECT_HISTORY_MESSAGES['zh-CN'],
    settings: L2_SETTINGS_MESSAGES['zh-CN'],
    skills: L2_SKILLS_MESSAGES['zh-CN'],
    taskCenter: L2_TASK_CENTER_MESSAGES['zh-CN'],
    workbench: L2_WORKBENCH_LOCALE_MESSAGES['zh-CN'],
    workbenchPicker: L2_WORKBENCH_PICKER_MESSAGES['zh-CN'],
    conversation: L3_CONVERSATION_LOCALE_MESSAGES['zh-CN'],
    projectFiles: L3_PROJECT_FILES_LOCALE_MESSAGES['zh-CN']
  }
}

interface L1AppProvidersProps {
  children: ReactNode
  initialSettings: HostSettingsSnapshot
}

export function L1AppProviders({
  children,
  initialSettings
}: L1AppProvidersProps): React.JSX.Element {
  return (
    <L4ThemeProvider>
      <L4DisplaySizeProvider>
        <L4CodePreferencesProvider>
          <L4RegionProvider resources={resources} initialSettings={initialSettings}>
            <L4AppToastProvider>
              <L4RegionNotice />
              <L1AppRuntimeProvider>
                <TooltipProvider>{children}</TooltipProvider>
              </L1AppRuntimeProvider>
            </L4AppToastProvider>
          </L4RegionProvider>
        </L4CodePreferencesProvider>
      </L4DisplaySizeProvider>
    </L4ThemeProvider>
  )
}
