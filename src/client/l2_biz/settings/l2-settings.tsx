'use client'

import {
  BotIcon,
  ChevronDownIcon,
  FolderTreeIcon,
  InfoIcon,
  ListFilterIcon,
  PaletteIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  ShieldCheckIcon,
  LanguagesIcon
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserBeforeLeaveHandler } from '@jetcrab/pi-desk-sdk/browser'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import type { L4PluginBrowserContributionDescriptor } from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import { L4_APP_VERSION, L4_APP_VERSION_UPDATED_AT } from '@client/l4_foundation/l4-app-info'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { useL4PluginRegistry } from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import { L4PluginIcon } from '@client/l4_foundation/plugin-host/l4-plugin-icon'
import {
  L4AppDialogBody,
  L4AppDialogContent,
  L4AppDialogHeader,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L4BrandIcon } from '@client/l4_foundation/ui/l4-brand-icon'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'
import { L2SkillsSettings } from './l2-skills-settings'
import { L2AuthSettings } from './l2-auth-settings'
import { L2RegionSettings } from './l2-region-settings'
import { L2AppearanceSettings } from './views/l2-appearance-settings'
import { L2HabitSettings } from './views/l2-habit-settings'
import { L2ModelSettingsView } from './views/l2-model-settings-view'
import {
  readL2SettingsSection,
  saveL2SettingsSection,
  type L2SettingsSection as SettingsSection
} from './l2-settings-biz'

type BuiltinSettingsSection = Exclude<SettingsSection, `plugin:${string}:${string}`>

export type L2SettingsPluginAttention = 'error' | 'notice' | null

interface L2SettingsProps {
  open: boolean
  connectionReady?: boolean
  initialModelTab?: 'presets'
  workSessions: readonly Pick<L2WorkSessionListItem, 'cwd' | 'projectName'>[]
  focusedCwd: string | null
  pluginAttention: L2SettingsPluginAttention
  renderPluginManagement: () => ReactNode
  renderMcpSettings: (input: {
    onBeforeLeaveChange: (handler: BrowserBeforeLeaveHandler | null) => void
  }) => ReactNode
  renderCapabilityModesSettings: (input: {
    onBeforeLeaveChange: (handler: BrowserBeforeLeaveHandler | null) => void
  }) => ReactNode
  renderPluginSettingsPage: (input: {
    pluginName: string
    descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'settings-page' }>
    onClose: () => void
    onBeforeLeaveChange: (handler: BrowserBeforeLeaveHandler | null) => void
  }) => ReactNode
  onOpenChange: (open: boolean) => void
  onBeforeReload: () => Promise<boolean>
}

function ExternalSettingsSection<Input>({
  render,
  input
}: {
  render: (input: Input) => ReactNode
  input: Input
}): ReactNode {
  return render(input)
}

interface SettingsSectionOption {
  id: BuiltinSettingsSection
  label: string
  icon: ComponentType<{ className?: string }>
}

const SETTINGS_SECTIONS: readonly SettingsSectionOption[] = [
  { id: 'appearance', label: 'appearance', icon: PaletteIcon },
  { id: 'region', label: 'region', icon: LanguagesIcon },
  { id: 'habits', label: 'habits', icon: SlidersHorizontalIcon },
  { id: 'models', label: 'models', icon: BotIcon },
  { id: 'mcp-settings', label: 'mcpSettings', icon: PlugIcon },
  { id: 'capability-modes', label: 'capabilityModes', icon: ListFilterIcon },
  { id: 'skills', label: 'skills', icon: FolderTreeIcon },
  { id: 'plugins', label: 'plugins', icon: PlugIcon },
  { id: 'auth', label: 'loginProtection', icon: ShieldCheckIcon },
  { id: 'about', label: 'about', icon: InfoIcon }
]

function pluginSectionId(pluginName: string, contributionName: string): SettingsSection {
  return `plugin:${pluginName}:${contributionName}`
}

function formatVersionUpdatedAt(
  value: string | null,
  locale: string,
  timeZone: string,
  unavailable: string
): string {
  if (!value) return unavailable
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? unavailable
    : new Intl.DateTimeFormat(locale, {
        timeZone,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }).format(date)
}

function AboutSettings(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const region = useL4Region()
  return (
    <section aria-labelledby="settings-about-title" className="min-w-0 space-y-6">
      <h2 id="settings-about-title" className="text-xl font-semibold">
        {t('about')}
      </h2>
      <div className="flex items-center gap-3 rounded-xl bg-muted p-4">
        <L4BrandIcon size={48} className="shrink-0" />
        <div>
          <p className="text-sm font-semibold">Pi Desk</p>
          <p className="text-sm text-muted-foreground">{t('webDescription')}</p>
        </div>
      </div>
      <dl className="divide-y border-y text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          <dt className="text-muted-foreground">{t('version')}</dt>
          <dd className="font-mono">v{L4_APP_VERSION}</dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          <dt className="text-muted-foreground">{t('versionUpdated')}</dt>
          <dd className="tabular-nums">
            {formatVersionUpdatedAt(
              L4_APP_VERSION_UPDATED_AT,
              region.locale === 'en' ? 'en-US' : 'zh-CN',
              region.timeZone,
              t('common:unavailable')
            )}
          </dd>
        </div>
      </dl>
    </section>
  )
}

export function L2Settings({
  open,
  connectionReady = false,
  initialModelTab,
  workSessions,
  focusedCwd,
  pluginAttention,
  renderPluginManagement,
  renderMcpSettings,
  renderCapabilityModesSettings,
  renderPluginSettingsPage,
  onOpenChange,
  onBeforeReload
}: L2SettingsProps): React.JSX.Element {
  const { t } = useTranslation('settings')
  const pluginDescriptors = useL4PluginRegistry()
  const skillProjects = useMemo(() => {
    const unique = new Map<string, { cwd: string; projectName: string }>()
    for (const { cwd, projectName } of workSessions) {
      const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
      const key =
        /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')
          ? normalized.toLowerCase()
          : normalized
      if (!unique.has(key)) unique.set(key, { cwd, projectName })
    }
    return [...unique.values()]
  }, [workSessions])
  const pluginPages = useMemo(
    () =>
      pluginDescriptors.flatMap((pluginModule) =>
        pluginModule.contributions.flatMap((descriptor) =>
          descriptor.kind === 'settings-page'
            ? [{ pluginName: pluginModule.pluginName, descriptor }]
            : []
        )
      ),
    [pluginDescriptors]
  )
  const [activeSection, setActiveSection] = useState<SettingsSection>(() =>
    initialModelTab ? 'models' : readL2SettingsSection()
  )
  useEffect(() => {
    // 不保存临时回退项，插件目录加载后仍能恢复原来的页面。
    if (open) saveL2SettingsSection(activeSection)
  }, [activeSection, open])
  const [pluginMenuOpen, setPluginMenuOpen] = useState(false)
  const [guardPending, setGuardPending] = useState(false)
  const beforeLeaveRef = useRef<BrowserBeforeLeaveHandler | null>(null)
  const guardPendingRef = useRef(false)
  const activePluginPage = pluginPages.find(
    (page) => pluginSectionId(page.pluginName, page.descriptor.contributionName) === activeSection
  )
  const effectiveSection: SettingsSection =
    activeSection.startsWith('plugin:') && !activePluginPage ? 'appearance' : activeSection
  const activeBuiltinSection = SETTINGS_SECTIONS.find((section) => section.id === effectiveSection)
  const ActiveBuiltinIcon = activeBuiltinSection?.icon

  const runAfterGuard = useCallback(async (action: () => void): Promise<void> => {
    if (guardPendingRef.current) return
    guardPendingRef.current = true
    setGuardPending(true)
    try {
      const guard = beforeLeaveRef.current
      if (guard && !(await guard())) return
      beforeLeaveRef.current = null
      action()
    } finally {
      guardPendingRef.current = false
      setGuardPending(false)
    }
  }, [])

  const requestClose = useCallback((): void => {
    void runAfterGuard(() => onOpenChange(false))
  }, [onOpenChange, runAfterGuard])
  const updateBeforeLeave = useCallback((handler: BrowserBeforeLeaveHandler | null): void => {
    beforeLeaveRef.current = handler
  }, [])

  const selectSection = (section: SettingsSection): void => {
    if (section === effectiveSection) return
    void runAfterGuard(() => setActiveSection(section))
  }

  return (
    <L4AppDialogRoot
      open={open}
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen) {
          onOpenChange(true)
          return
        }
        if (eventDetails.reason === 'focus-out') return
        requestClose()
      }}
    >
      <L4AppDialogContent
        className="h-[min(48rem,calc(100dvh-2rem))] max-w-6xl max-sm:h-dvh max-sm:max-h-dvh max-sm:w-dvw max-sm:max-w-none max-sm:rounded-none max-sm:border-0"
        finalFocus={false}
        showCloseButton={!guardPending}
      >
        <L4AppDialogHeader className="border-b px-4 py-3 pr-12">
          <L4AppDialogTitle>{t('title')}</L4AppDialogTitle>
        </L4AppDialogHeader>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <div className="shrink-0 border-b bg-sidebar p-3 sm:hidden">
            <Select
              value={effectiveSection}
              disabled={guardPending}
              onValueChange={(value) => {
                if (typeof value !== 'string') return
                const builtin = SETTINGS_SECTIONS.find((section) => section.id === value)
                if (builtin) {
                  selectSection(builtin.id)
                  return
                }
                const pluginPage = pluginPages.find(
                  (page) =>
                    pluginSectionId(page.pluginName, page.descriptor.contributionName) === value
                )
                if (pluginPage) {
                  selectSection(
                    pluginSectionId(pluginPage.pluginName, pluginPage.descriptor.contributionName)
                  )
                }
              }}
            >
              <SelectTrigger aria-label={t('category')} className="w-full">
                <SelectValue>
                  {activePluginPage ? (
                    <>
                      <L4PluginIcon
                        icon={activePluginPage.descriptor.icon}
                        className="size-4 shrink-0"
                      />
                      <span className="truncate">{activePluginPage.descriptor.label}</span>
                    </>
                  ) : activeBuiltinSection && ActiveBuiltinIcon ? (
                    <>
                      <ActiveBuiltinIcon className="size-4 shrink-0" />
                      <span className="truncate">{t(activeBuiltinSection.label)}</span>
                    </>
                  ) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent positionerClassName="z-[120]" align="start">
                {SETTINGS_SECTIONS.map((section) => {
                  const Icon = section.icon
                  return (
                    <SelectItem key={section.id} value={section.id}>
                      <span className="relative shrink-0">
                        <Icon className="size-4" />
                        {section.id === 'plugins' && pluginAttention ? (
                          <span
                            aria-hidden="true"
                            className={cn(
                              'absolute -right-1 -top-1 size-1.5 rounded-full',
                              pluginAttention === 'error' ? 'bg-destructive' : 'bg-primary'
                            )}
                          />
                        ) : null}
                      </span>
                      <span>{t(section.label)}</span>
                    </SelectItem>
                  )
                })}
                {pluginPages.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>{t('pluginSettings')}</SelectLabel>
                    {pluginPages.map((page) => {
                      const id = pluginSectionId(page.pluginName, page.descriptor.contributionName)
                      return (
                        <SelectItem key={id} value={id}>
                          <L4PluginIcon icon={page.descriptor.icon} className="size-4 shrink-0" />
                          <span>{page.descriptor.label}</span>
                        </SelectItem>
                      )
                    })}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
          </div>

          <nav
            aria-label={t('category')}
            className="pi-desk-chat-scrollbar hidden w-48 shrink-0 space-y-4 overflow-auto border-r bg-sidebar p-3 sm:block"
          >
            <div className="grid grid-cols-1 gap-1">
              {SETTINGS_SECTIONS.map((section) => {
                const Icon = section.icon
                const selected = section.id === effectiveSection
                return (
                  <Button
                    key={section.id}
                    variant="ghost"
                    disabled={guardPending}
                    aria-current={selected ? 'page' : undefined}
                    aria-label={`${t('category')}：${t(section.label)}`}
                    onClick={() => selectSection(section.id)}
                    className={cn(
                      'min-w-0 justify-start',
                      selected
                        ? 'bg-accent text-accent-foreground hover:bg-accent'
                        : 'text-muted-foreground'
                    )}
                  >
                    <span className="relative shrink-0">
                      <Icon className="size-4" />
                      {section.id === 'plugins' && pluginAttention ? (
                        <span
                          aria-hidden="true"
                          className={cn(
                            'absolute -right-1 -top-1 size-1.5 rounded-full',
                            pluginAttention === 'error' ? 'bg-destructive' : 'bg-primary'
                          )}
                        />
                      ) : null}
                    </span>
                    <span className="truncate">{t(section.label)}</span>
                  </Button>
                )
              })}
            </div>
            {pluginPages.length > 0 ? (
              <Collapsible
                open={pluginMenuOpen || Boolean(activePluginPage)}
                onOpenChange={setPluginMenuOpen}
                className="mt-2 border-t pt-2"
              >
                <CollapsibleTrigger
                  type="button"
                  aria-label={t('pluginSettings')}
                  className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 text-left">{t('pluginSettings')}</span>
                  <span className="tabular-nums">{pluginPages.length}</span>
                  <ChevronDownIcon
                    className={cn(
                      'size-3.5 transition-transform',
                      pluginMenuOpen || activePluginPage ? 'rotate-180' : null
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-1 grid grid-cols-1 gap-1">
                    {pluginPages.map((page) => {
                      const id = pluginSectionId(page.pluginName, page.descriptor.contributionName)
                      const selected = id === effectiveSection
                      return (
                        <Button
                          key={id}
                          variant="ghost"
                          disabled={guardPending}
                          aria-current={selected ? 'page' : undefined}
                          onClick={() => selectSection(id)}
                          className={cn(
                            'min-w-0 justify-start',
                            selected
                              ? 'bg-accent text-accent-foreground hover:bg-accent'
                              : 'text-muted-foreground'
                          )}
                        >
                          <L4PluginIcon icon={page.descriptor.icon} className="size-4 shrink-0" />
                          <span className="truncate">{page.descriptor.label}</span>
                        </Button>
                      )
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
          </nav>

          {activePluginPage ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <ExternalSettingsSection
                render={renderPluginSettingsPage}
                input={{
                  pluginName: activePluginPage.pluginName,
                  descriptor: activePluginPage.descriptor,
                  onClose: requestClose,
                  onBeforeLeaveChange: updateBeforeLeave
                }}
              />
            </div>
          ) : effectiveSection === 'skills' ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              {open && (
                <L2SkillsSettings
                  projects={skillProjects}
                  focusedCwd={focusedCwd}
                  onBeforeLeaveChange={updateBeforeLeave}
                />
              )}
            </div>
          ) : effectiveSection === 'mcp-settings' ? (
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
              {open && (
                <ExternalSettingsSection
                  render={renderMcpSettings}
                  input={{ onBeforeLeaveChange: updateBeforeLeave }}
                />
              )}
            </div>
          ) : effectiveSection === 'capability-modes' ? (
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
              {open && (
                <ExternalSettingsSection
                  render={renderCapabilityModesSettings}
                  input={{ onBeforeLeaveChange: updateBeforeLeave }}
                />
              )}
            </div>
          ) : effectiveSection === 'models' ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              {open && (
                <L2ModelSettingsView
                  connectionReady={connectionReady}
                  initialTab={initialModelTab}
                  onBeforeLeaveChange={updateBeforeLeave}
                />
              )}
            </div>
          ) : effectiveSection === 'plugins' ? (
            <div className="min-h-0 flex-1 overflow-hidden">{renderPluginManagement()}</div>
          ) : (
            <L4AppDialogBody className="min-w-0 max-h-none">
              <div className="p-4 sm:p-6">
                {effectiveSection === 'appearance' ? (
                  <L2AppearanceSettings />
                ) : effectiveSection === 'habits' ? (
                  <L2HabitSettings />
                ) : effectiveSection === 'auth' ? (
                  open && <L2AuthSettings />
                ) : effectiveSection === 'region' ? (
                  <L2RegionSettings canLeave={onBeforeReload} />
                ) : (
                  <AboutSettings />
                )}
              </div>
            </L4AppDialogBody>
          )}
        </div>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
