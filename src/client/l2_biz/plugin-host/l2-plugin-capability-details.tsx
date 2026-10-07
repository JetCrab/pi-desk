'use client'

import {
  CheckIcon,
  CopyIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  RefreshCwIcon
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import type {
  L2PluginManagementCapabilities,
  L2PluginManagementDetail,
  L2PluginManagementItem,
  L2PluginManagementToolDetail
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
import { copyL4BrowserText } from '@client/l4_foundation/lib/l4-browser-clipboard'
import type { L4PluginBrowserContributionDescriptor } from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'

const BUILTIN_TOOL_NAMES = new Set(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'])
const UNKNOWN_SCHEMA_TYPE = '__pi_desk_unknown_schema_type__'

const CONTEXT_EVENT_DESCRIPTIONS: Readonly<Record<string, { label: string; description: string }>> =
  {
    before_agent_start: {
      label: 'eventAgentStart',
      description: 'eventAgentStartDescription'
    },
    context: {
      label: 'eventContext',
      description: 'eventContextDescription'
    },
    input: {
      label: 'eventInput',
      description: 'eventInputDescription'
    },
    before_provider_request: {
      label: 'eventProvider',
      description: 'eventProviderDescription'
    },
    tool_call: {
      label: 'eventToolCall',
      description: 'eventToolCallDescription'
    },
    tool_result: {
      label: 'eventToolResult',
      description: 'eventToolResultDescription'
    },
    message_end: {
      label: 'eventMessageEnd',
      description: 'eventMessageEndDescription'
    },
    session_before_compact: {
      label: 'eventBeforeCompact',
      description: 'eventBeforeCompactDescription'
    }
  }

const CONTRIBUTION_LABELS: Readonly<Record<L4PluginBrowserContributionDescriptor['kind'], string>> =
  {
    application: 'contributionApplication',
    'composer-panel': 'contributionComposer',
    'settings-page': 'contributionSettings',
    'message-view': 'contributionMessage',
    'session-sidebar-tab': 'contributionSidebar'
  }

export type L2PluginCapabilityTagTone = 'neutral' | 'prompt' | 'dynamic' | 'override'

export interface L2PluginCapabilityTag {
  label: string
  tone: L2PluginCapabilityTagTone
}

interface L2PluginCapabilityDetailsProps {
  plugin: L2PluginManagementItem
  detail: L2PluginManagementDetail | null
  detailLoading: boolean
  detailError: string | null
  browserContributions: readonly L4PluginBrowserContributionDescriptor[]
  onRetry: () => void
}

interface ContextEventCapability {
  name: string
  count: number
  path: string
  label: string
  description: string
}

interface ParameterRow {
  name: string
  required: boolean
  type: string
  description: string | null
}

function contextEvents(capabilities: L2PluginManagementCapabilities): ContextEventCapability[] {
  const events: ContextEventCapability[] = []
  for (const extension of capabilities.extensions) {
    for (const event of extension.events) {
      const definition = CONTEXT_EVENT_DESCRIPTIONS[event.name]
      if (!definition) continue
      events.push({
        name: event.name,
        count: event.count,
        path: extension.path,
        label: definition.label,
        description: definition.description
      })
    }
  }
  return events.sort((left, right) => {
    const name = left.name.localeCompare(right.name)
    return name === 0 ? left.path.localeCompare(right.path) : name
  })
}

function activeFixedPromptCount(capabilities: L2PluginManagementCapabilities): number {
  const toolCount = capabilities.tools.reduce((count, tool) => {
    if (tool.state !== 'active') return count
    return count + (tool.promptSnippet ? 1 : 0) + tool.promptGuidelineCount
  }, 0)
  return toolCount + capabilities.skills.filter((skill) => skill.modelVisible).length
}

function overriddenBuiltinCount(capabilities: L2PluginManagementCapabilities): number {
  return capabilities.tools.filter(
    (tool) => tool.state !== 'shadowed' && BUILTIN_TOOL_NAMES.has(tool.name)
  ).length
}

function dynamicImpactCount(capabilities: L2PluginManagementCapabilities): number {
  return contextEvents(capabilities).reduce((count, event) => count + event.count, 0)
}

function getL2PluginCapabilityTags(
  capabilities: L2PluginManagementCapabilities,
  browserContributions: readonly L4PluginBrowserContributionDescriptor[],
  t: TFunction<'pluginManagement'>
): readonly L2PluginCapabilityTag[] {
  const tags: L2PluginCapabilityTag[] = []
  if (capabilities.tools.length > 0) {
    tags.push({ label: t('tagTools', { count: capabilities.tools.length }), tone: 'neutral' })
  }

  const fixedPromptCount = activeFixedPromptCount(capabilities)
  if (fixedPromptCount > 0) {
    tags.push({ label: t('tagFixed', { count: fixedPromptCount }), tone: 'prompt' })
  }

  const dynamicCount = dynamicImpactCount(capabilities)
  if (dynamicCount > 0) {
    tags.push({ label: t('tagDynamic', { count: dynamicCount }), tone: 'dynamic' })
  }

  const overrideCount = overriddenBuiltinCount(capabilities)
  if (overrideCount > 0) {
    tags.push({ label: t('tagOverride', { count: overrideCount }), tone: 'override' })
  }

  const manualPromptCount =
    capabilities.prompts.length + capabilities.skills.filter((skill) => !skill.modelVisible).length
  if (manualPromptCount > 0) {
    tags.push({ label: t('tagManual', { count: manualPromptCount }), tone: 'neutral' })
  }

  const piDeskCount =
    browserContributions.length +
    capabilities.piDesk.methods.length +
    capabilities.piDesk.messageDeclarations.length
  if (piDeskCount > 0) tags.push({ label: `Pi Desk ${piDeskCount}`, tone: 'neutral' })

  const interactionCount =
    capabilities.providers.length +
    capabilities.themes.length +
    capabilities.extensions.reduce(
      (count, extension) =>
        count + extension.commands.length + extension.shortcuts.length + extension.flags.length,
      0
    )
  if (interactionCount > 0) {
    tags.push({ label: t('tagInteraction', { count: interactionCount }), tone: 'neutral' })
  }
  if (tags.length === 0 && capabilities.extensions.length > 0) {
    tags.push({ label: `Extension ${capabilities.extensions.length}`, tone: 'neutral' })
  }
  return tags
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function schemaType(value: unknown): string {
  const schema = recordValue(value)
  if (!schema) return UNKNOWN_SCHEMA_TYPE
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter(
        (item): item is string | number | boolean =>
          typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
      )
    : []
  if (enumValues.length > 0) return enumValues.map(String).join(' | ')
  if (typeof schema.type === 'string') {
    if (schema.type !== 'array') return schema.type
    const itemType = schemaType(schema.items)
    return itemType === UNKNOWN_SCHEMA_TYPE ? 'array' : `${itemType}[]`
  }
  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(schema[unionKey])) continue
    const values = schema[unionKey].map(schemaType).filter((item) => item !== UNKNOWN_SCHEMA_TYPE)
    if (values.length > 0) return [...new Set(values)].join(' | ')
  }
  return UNKNOWN_SCHEMA_TYPE
}

function parameterRows(parameters: L2PluginManagementToolDetail['parameters']): ParameterRow[] {
  const properties = recordValue(parameters.properties)
  if (!properties) return []
  const required = new Set(stringArray(parameters.required))
  return Object.entries(properties).map(([name, value]) => {
    const property = recordValue(value)
    return {
      name,
      required: required.has(name),
      type: schemaType(value),
      description: typeof property?.description === 'string' ? property.description : null
    }
  })
}

function ToolState({ state }: { state: L2PluginManagementToolDetail['state'] }): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const label = t(
    state === 'active' ? 'stateActive' : state === 'inactive' ? 'stateInactive' : 'stateShadowed'
  )
  const className =
    state === 'active'
      ? 'bg-muted text-status-success'
      : state === 'inactive'
        ? 'bg-muted text-muted-foreground'
        : 'bg-muted text-status-warning'
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${className}`}>{label}</span>
  )
}

function CopyTextButton({ text, label }: { text: string; label: string }): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={label}
      title={copied ? t('copied') : t('copy')}
      onClick={() => {
        void copyL4BrowserText(text).then((success) => {
          if (success) setCopied(true)
        })
      }}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Button>
  )
}

function PromptTextBlock({ title, text }: { title: string; text: string }): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  return (
    <div className="rounded-lg bg-muted">
      <div className="flex min-h-9 items-center justify-between gap-2 px-3">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <CopyTextButton text={text} label={t('copyNamed', { name: title })} />
      </div>
      <pre className="whitespace-pre-wrap break-words px-3 py-3 font-mono text-sm leading-[1.6]">
        {text}
      </pre>
    </div>
  )
}

function Section({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Collapsible className="border-t">
      <CollapsibleTrigger className="group flex min-h-8 w-full cursor-pointer items-center gap-2 py-2 text-left text-sm font-medium outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 pb-3">
          {description ? (
            <p className="text-sm leading-5 text-muted-foreground">{description}</p>
          ) : null}
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function DynamicContextCapabilities({
  capabilities
}: {
  capabilities: L2PluginManagementCapabilities
}): React.JSX.Element | null {
  const { t } = useTranslation('pluginManagement')
  const events = contextEvents(capabilities)
  if (events.length === 0) return null
  return (
    <Section title={t('dynamicTitle')} description={t('dynamicDescription')}>
      <div className="divide-y">
        {events.map((event, index) => (
          <div key={`${event.path}:${event.name}:${index}`} className="px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-xs font-semibold">{event.name}</code>
              {event.count > 1 ? (
                <span className="text-xs text-muted-foreground">×{event.count}</span>
              ) : null}
              <span className="text-xs font-medium">{t(event.label)}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(event.description)}</p>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={event.path}>
              {event.path}
            </p>
          </div>
        ))}
      </div>
    </Section>
  )
}

function ToolParameters({ tool }: { tool: L2PluginManagementToolDetail }): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const rows = parameterRows(tool.parameters)
  return (
    <div className="mt-4">
      <p className="text-sm font-medium">
        {t('arguments')} · {rows.length > 0 ? rows.length : t('none')}
      </p>
      <div className="py-3">
        {rows.length > 0 ? (
          <div className="space-y-2">
            {rows.map((row) => (
              <div
                key={row.name}
                className="grid gap-1 text-sm sm:grid-cols-[minmax(8rem,0.8fr)_minmax(0,1.5fr)] sm:gap-3"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <code className="font-semibold">{row.name}</code>
                  <span className="text-xs text-muted-foreground">
                    {t(row.required ? 'required' : 'optional')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {row.type === UNKNOWN_SCHEMA_TYPE ? t('unknown') : row.type}
                  </span>
                </div>
                <p className="min-w-0 break-words leading-5 text-muted-foreground">
                  {row.description ?? '—'}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t('noArguments')}</p>
        )}
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t('rawSchema')}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-sm leading-[1.6]">
            {JSON.stringify(tool.parameters, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  )
}

function ToolsSection({ detail }: { detail: L2PluginManagementDetail }): React.JSX.Element | null {
  const { t } = useTranslation('pluginManagement')
  if (detail.tools.length === 0) return null
  return (
    <Section title={t('toolCapabilities')} description={t('toolDescription')}>
      <div className="space-y-2">
        {detail.tools.map((tool, index) => (
          <details key={`${tool.name}:${index}`} className="border-b py-3 last:border-b-0">
            <summary className="cursor-pointer text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="inline-flex min-w-0 flex-wrap items-center gap-2">
                <code className="font-semibold">{tool.name}</code>
                {tool.label && tool.label !== tool.name ? (
                  <span className="text-xs text-muted-foreground">{tool.label}</span>
                ) : null}
                <ToolState state={tool.state} />
                {BUILTIN_TOOL_NAMES.has(tool.name) && tool.state !== 'shadowed' ? (
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
                    {t('overridesBuiltin')}
                  </span>
                ) : null}
              </div>
              <p className="mt-1.5 break-words text-sm leading-5 text-muted-foreground">
                {tool.description || t('noDescription')}
              </p>
            </summary>
            <ToolParameters tool={tool} />
            {tool.promptSnippet || tool.promptGuidelines.length > 0 ? (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-medium">{t('systemPrompts')}</p>
                  {tool.state !== 'active' ? (
                    <span className="text-sm text-muted-foreground">{t('inactivePrompt')}</span>
                  ) : null}
                </div>
                {tool.promptSnippet ? (
                  <PromptTextBlock title="Available tools" text={tool.promptSnippet} />
                ) : null}
                {tool.promptGuidelines.length > 0 ? (
                  <PromptTextBlock
                    title={`Guidelines · ${tool.promptGuidelines.length}`}
                    text={tool.promptGuidelines
                      .map((guideline, guidelineIndex) => `${guidelineIndex + 1}. ${guideline}`)
                      .join('\n\n')}
                  />
                ) : null}
              </div>
            ) : null}
          </details>
        ))}
      </div>
    </Section>
  )
}

function ResourceContent({
  title,
  content,
  truncated
}: {
  title: string
  content: string
  truncated: boolean
}): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  return (
    <details className="mt-3">
      <summary className="cursor-pointer py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {title}
      </summary>
      <div className="border-t">
        <div className="flex justify-end px-2 pt-1">
          <CopyTextButton text={content} label={t('copyNamed', { name: title })} />
        </div>
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-sm leading-[1.6]">
          {content}
        </pre>
        {truncated ? <p className="py-2 text-sm text-status-warning">{t('truncated')}</p> : null}
      </div>
    </details>
  )
}

function PromptResources({
  detail
}: {
  detail: L2PluginManagementDetail
}): React.JSX.Element | null {
  const { t } = useTranslation('pluginManagement')
  if (detail.skills.length === 0 && detail.prompts.length === 0) return null
  return (
    <Section title={t('resourcesTitle')} description={t('resourcesDescription')}>
      <div className="space-y-2">
        {detail.skills.map((skill) => (
          <article key={skill.path} className="border-b py-4 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-semibold">{skill.name}</code>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {t(skill.modelVisible ? 'skillModelVisible' : 'manualOnly')}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{skill.description}</p>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{skill.path}</p>
            {skill.modelVisible ? (
              <div className="mt-2">
                <PromptTextBlock
                  title={t('skillMetadata')}
                  text={`name: ${skill.name}\ndescription: ${skill.description}\nlocation: ${skill.path}`}
                />
              </div>
            ) : null}
            <ResourceContent
              title={t('viewSkillContent')}
              content={skill.content}
              truncated={skill.truncated}
            />
          </article>
        ))}
        {detail.prompts.map((prompt) => (
          <article key={prompt.path} className="border-b py-4 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-semibold">/{prompt.name}</code>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {t('manualOnly')}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{prompt.description}</p>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{prompt.path}</p>
            <ResourceContent
              title={t('viewPromptContent')}
              content={prompt.content}
              truncated={prompt.truncated}
            />
          </article>
        ))}
      </div>
    </Section>
  )
}

function contributionDescription(descriptor: L4PluginBrowserContributionDescriptor): string {
  if (descriptor.kind === 'message-view') return descriptor.viewKey
  if (descriptor.kind === 'application') return descriptor.title
  return descriptor.label
}

function OtherCapabilities({
  capabilities,
  browserContributions
}: {
  capabilities: L2PluginManagementCapabilities
  browserContributions: readonly L4PluginBrowserContributionDescriptor[]
}): React.JSX.Element | null {
  const { t } = useTranslation('pluginManagement')
  const hasNativeRegistrations = capabilities.extensions.some(
    (extension) =>
      extension.events.length > 0 ||
      extension.commands.length > 0 ||
      extension.shortcuts.length > 0 ||
      extension.flags.length > 0 ||
      extension.messageRenderers.length > 0 ||
      extension.entryRenderers.length > 0
  )
  const hasPiDesk =
    capabilities.piDesk.methods.length > 0 ||
    capabilities.piDesk.browserEntries.length > 0 ||
    capabilities.piDesk.messageDeclarations.length > 0 ||
    browserContributions.length > 0
  const hasResources = capabilities.themes.length > 0 || capabilities.providers.length > 0
  if (!hasNativeRegistrations && !hasPiDesk && !hasResources) return null

  return (
    <Section title={t('otherCapabilities')}>
      <div className="space-y-2">
        {hasPiDesk ? (
          <div className="rounded-xl border bg-card p-3 text-xs">
            <p className="font-semibold">Pi Desk</p>
            <div className="mt-2 space-y-1.5 text-muted-foreground">
              {capabilities.piDesk.methods.map((method) => (
                <p key={`${method.pluginName}:${method.method}`}>
                  Method：
                  <code>
                    {method.pluginName}/{method.method}
                  </code>
                </p>
              ))}
              {browserContributions.map((descriptor) => (
                <p key={`${descriptor.kind}:${descriptor.contributionName}`}>
                  {t(CONTRIBUTION_LABELS[descriptor.kind])}：{contributionDescription(descriptor)}
                </p>
              ))}
              {capabilities.piDesk.messageDeclarations.map((declaration) => (
                <p key={`${declaration.pluginName}:${declaration.declarationName}`}>
                  {t('messageDeclarations')}
                  <code>
                    {declaration.pluginName}/{declaration.declarationName}
                  </code>
                </p>
              ))}
            </div>
          </div>
        ) : null}

        {hasNativeRegistrations
          ? capabilities.extensions.map((extension) => (
              <div key={extension.path} className="rounded-xl border bg-card p-3 text-xs">
                <code className="block break-all font-semibold">{extension.path}</code>
                {extension.commands.length > 0 ? (
                  <p className="mt-2 leading-5 text-muted-foreground">
                    Commands：{extension.commands.map((command) => `/${command.name}`).join('、')}
                  </p>
                ) : null}
                {extension.shortcuts.length > 0 ? (
                  <p className="mt-1 leading-5 text-muted-foreground">
                    Shortcuts：{extension.shortcuts.map((item) => item.shortcut).join('、')}
                  </p>
                ) : null}
                {extension.flags.length > 0 ? (
                  <p className="mt-1 leading-5 text-muted-foreground">
                    Flags：{extension.flags.map((item) => `--${item.name}`).join('、')}
                  </p>
                ) : null}
                {extension.events.length > 0 ? (
                  <p className="mt-1 leading-5 text-muted-foreground">
                    Events：{extension.events.map((event) => event.name).join('、')}
                  </p>
                ) : null}
              </div>
            ))
          : null}

        {hasResources ? (
          <div className="rounded-xl border bg-card p-3 text-xs text-muted-foreground">
            {capabilities.themes.length > 0 ? (
              <p>Theme：{capabilities.themes.map((theme) => theme.name).join('、')}</p>
            ) : null}
            {capabilities.providers.length > 0 ? (
              <p className="mt-1">
                Provider：{capabilities.providers.map((provider) => provider.name).join('、')}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  )
}

export function L2PluginCapabilityDetails({
  plugin,
  detail,
  detailLoading,
  detailError,
  browserContributions,
  onRetry
}: L2PluginCapabilityDetailsProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const { locale } = useL4Region()
  const capabilityTags = getL2PluginCapabilityTags(plugin.capabilities, browserContributions, t)

  return (
    <div className="space-y-3 text-sm" data-testid="plugin-capability-detail">
      <p className="break-all font-mono text-xs text-muted-foreground">{plugin.source}</p>

      {capabilityTags.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label={t('capabilityCategories')}>
          {capabilityTags.map((tag) => (
            <span
              key={tag.label}
              className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {tag.label}
            </span>
          ))}
        </div>
      ) : null}

      {plugin.capabilities.error ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-5 text-status-warning">
          {t('incompleteCapabilities', {
            error: selectL4LocalizedText(plugin.capabilities.error, locale)
          })}
        </p>
      ) : null}

      {detailLoading ? (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
          {t('loadingFullDetails')}
        </div>
      ) : detailError ? (
        <div className="flex items-start gap-2" role="alert">
          <p className="min-w-0 flex-1 break-words text-sm text-destructive">{detailError}</p>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <RefreshCwIcon data-icon="inline-start" />
            {t('retry')}
          </Button>
        </div>
      ) : detail ? (
        <>
          <ToolsSection detail={detail} />
          <PromptResources detail={detail} />
        </>
      ) : null}
      <DynamicContextCapabilities capabilities={plugin.capabilities} />
      <OtherCapabilities
        capabilities={plugin.capabilities}
        browserContributions={browserContributions}
      />
    </div>
  )
}
