import { z } from 'zod'

const SettingsSectionSchema = z.union([
  z.enum([
    'appearance',
    'region',
    'habits',
    'auth',
    'models',
    'mcp-settings',
    'capability-modes',
    'skills',
    'plugins',
    'about'
  ]),
  z.templateLiteral(['plugin:', z.string(), ':', z.string()])
])
const ModelSettingsTabSchema = z.enum(['providers', 'presets', 'project-default'])
const SECTION_STORAGE_KEY = 'pi-super:settings:section'
const MODEL_TAB_STORAGE_KEY = 'pi-super:settings:model-tab'

export type L2SettingsSection = z.infer<typeof SettingsSectionSchema>
export type L2ModelSettingsTab = z.infer<typeof ModelSettingsTabSchema>

function readSelection<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const parsed = schema.safeParse(window.localStorage.getItem(key))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

function saveSelection(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch (error) {
    console.warn('[Pi Desk][Settings] 保存设置导航位置失败，仅当前窗口生效', error)
  }
}

export function readL2SettingsSection(): L2SettingsSection {
  return readSelection(SECTION_STORAGE_KEY, SettingsSectionSchema, 'appearance')
}

export function saveL2SettingsSection(section: L2SettingsSection): void {
  saveSelection(SECTION_STORAGE_KEY, section)
}

export function readL2ModelSettingsTab(): L2ModelSettingsTab {
  return readSelection(MODEL_TAB_STORAGE_KEY, ModelSettingsTabSchema, 'providers')
}

export function saveL2ModelSettingsTab(tab: L2ModelSettingsTab): void {
  saveSelection(MODEL_TAB_STORAGE_KEY, tab)
}
