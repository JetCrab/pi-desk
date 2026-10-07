import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeftIcon, ChevronDownIcon, MoreHorizontalIcon } from 'lucide-react'
import { DropdownMenuItem } from '@client/l4_foundation/ui/shadcn/dropdown-menu'
import type { L2McpServerConfig } from '@common/l2_biz/pi-settings/l2-pi-settings-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { Textarea } from '@client/l4_foundation/ui/shadcn/textarea'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'
import type { L2McpEditor, L2PiSettingsController } from '../hooks/l2-use-pi-settings'
import type { L2McpDraft } from '../l2-pi-settings-model'
import { isL2McpShorthand, l2McpConnectionLabel } from '../l2-pi-settings-model'
import { useL2PiSettingsText } from '../l2-pi-settings-locale'
import { L2PiSettingsError, L2PiSettingsSelect, L2PiSettingsMenu } from './l2-pi-settings-fields'
import { L2McpKeyValues } from './l2-mcp-key-values'
import { L2McpCheckResult } from './l2-mcp-check-result'

export function L2McpSettingsEditor({
  editor,
  scopeLabel,
  project,
  projectTrusted,
  check,
  local,
  inherited,
  pending,
  error,
  onDraft,
  onJson,
  onPreview,
  onOverwrite,
  onSave,
  onCancel,
  onRemove,
  onDismissCheck
}: {
  editor: L2McpEditor
  scopeLabel: string
  project: boolean
  projectTrusted: boolean | null
  check: L2PiSettingsController['check']
  local: Record<string, L2McpServerConfig>
  inherited: Record<string, L2McpServerConfig>
  pending: boolean
  error: { field: string; message: string } | null
  onDraft: (patch: Partial<L2McpDraft>) => void
  onJson: (text: string) => void
  onPreview: () => void
  onOverwrite: (value: boolean) => void
  onSave: (testConnection?: boolean) => void
  onCancel: () => void
  onRemove: (name: string) => void
  onDismissCheck: () => void
}): React.JSX.Element {
  const t = useL2PiSettingsText()
  const id = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  useEffect(() => {
    if (error) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [error])
  const fieldId = (name: string): string => `${id}-${name}`
  const draft = editor.kind === 'manual' ? editor.draft : null
  const collisions =
    editor.kind === 'json' && editor.preview
      ? Object.keys(editor.preview).filter((name) => Object.hasOwn(local, name))
      : []
  const title = editor.kind === 'json' ? '导入 JSON' : draft?.originalName ? '服务配置' : '添加服务'
  const savedName = draft?.originalName
  const canRemove = Boolean(savedName && Object.hasOwn(local, savedName))
  const restore = Boolean(project && savedName && Object.hasOwn(inherited, savedName))
  const field = (key: string, label: string, control: ReactNode): React.JSX.Element => (
    <div className="space-y-1">
      <label htmlFor={fieldId(key)} className="text-sm font-medium">
        {t(label)}
      </label>
      {control}
      <L2PiSettingsError
        id={fieldId(`${key}-error`)}
        message={error?.field === key ? error.message : null}
      />
    </div>
  )
  const textInput = (
    key: 'name' | 'command' | 'url' | 'description',
    label: string
  ): React.JSX.Element =>
    field(
      key,
      label,
      <Input
        id={fieldId(key)}
        value={draft?.[key] ?? ''}
        disabled={pending || (key === 'name' && Boolean(draft?.originalName))}
        aria-invalid={error?.field === key}
        aria-describedby={error?.field === key ? fieldId(`${key}-error`) : undefined}
        onChange={(event) => onDraft({ [key]: event.target.value })}
      />
    )
  return (
    <form
      ref={formRef}
      aria-label={t(title)}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        onSave()
      }}
    >
      <div className="shrink-0 space-y-1 border-b p-4 sm:px-6">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('返回服务列表')}
            disabled={pending}
            onClick={onCancel}
          >
            <ArrowLeftIcon aria-hidden="true" />
          </Button>
          <h3 className="min-w-0 flex-1 text-sm font-semibold">{t(title)}</h3>
          {canRemove && savedName && (
            <L2PiSettingsMenu
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('服务操作')}
                  disabled={pending}
                >
                  <MoreHorizontalIcon aria-hidden="true" />
                </Button>
              }
            >
              <DropdownMenuItem
                variant={restore ? 'default' : 'destructive'}
                onClick={() => onRemove(savedName)}
              >
                {t(restore ? '恢复全局配置' : '删除服务')}
              </DropdownMenuItem>
            </L2PiSettingsMenu>
          )}
        </div>
        {project && (
          <p className="break-all text-xs text-muted-foreground">
            {t('保存范围')}：{scopeLabel}
          </p>
        )}
      </div>
      <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {draft ? (
          <div className="max-w-[40rem] space-y-4">
            {check && (
              <L2McpCheckResult
                check={check}
                onRetry={() => onSave(true)}
                onDismiss={onDismissCheck}
              />
            )}
            {textInput('name', '服务名称')}
            {draft.transport === 'inherit' ? (
              <div className="space-y-1">
                <p className="text-sm font-medium">{t('继承全局连接')}</p>
                {savedName && inherited[savedName] && (
                  <p className="break-all font-mono text-sm text-muted-foreground">
                    {l2McpConnectionLabel(inherited[savedName])}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {t('连接参数沿用全局，仅保存本项目的启用和工具设置。')}
                </p>
              </div>
            ) : (
              <>
                <L2PiSettingsSelect
                  id={fieldId('transport')}
                  label={t('连接方式')}
                  value={draft.transport}
                  disabled={pending}
                  options={[
                    { value: 'stdio', label: t('本地程序') },
                    { value: 'http', label: t('HTTP 地址') }
                  ]}
                  onChange={(value) => onDraft({ transport: value === 'http' ? 'http' : 'stdio' })}
                />
                {draft.transport === 'stdio' ? (
                  <>
                    {textInput('command', '启动程序')}
                    {field(
                      'args',
                      '参数（每行一个）',
                      <Textarea
                        id={fieldId('args')}
                        className="min-h-24 font-mono"
                        value={draft.args}
                        disabled={pending}
                        onChange={(event) => onDraft({ args: event.target.value })}
                      />
                    )}
                  </>
                ) : (
                  textInput('url', 'HTTP 地址')
                )}
                {(draft.transport === 'stdio' || error?.field === 'env') && (
                  <L2McpKeyValues
                    id={fieldId('env')}
                    label={t('环境变量')}
                    rows={draft.env}
                    disabled={pending}
                    error={error?.field === 'env' ? error.message : null}
                    onChange={(env) => onDraft({ env })}
                  />
                )}
                {(draft.transport === 'http' || error?.field === 'headers') && (
                  <L2McpKeyValues
                    id={fieldId('headers')}
                    label={t('请求头')}
                    rows={draft.headers}
                    disabled={pending}
                    error={error?.field === 'headers' ? error.message : null}
                    onChange={(headers) => onDraft({ headers })}
                  />
                )}
                {project && (
                  <p className="text-xs text-muted-foreground">
                    {t('本项目的完整定义会整体替换同名全局配置。')}
                  </p>
                )}
              </>
            )}
            <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={pending}
                onChange={(event) => onDraft({ enabled: event.target.checked })}
                className="size-4 shrink-0 accent-primary"
              />
              {t('已启用')}
            </label>
            <Collapsible
              open={advancedOpen || error?.field === 'advanced'}
              onOpenChange={setAdvancedOpen}
            >
              <CollapsibleTrigger
                type="button"
                className="group flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-4 transition-transform group-data-panel-open:rotate-180"
                />
                {t('高级设置')}
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-3">
                {draft.transport !== 'inherit' && textInput('description', '服务说明（可选）')}
                <L2PiSettingsSelect
                  id={fieldId('exposure')}
                  label={t('工具使用方式')}
                  value={draft.exposure}
                  disabled={pending}
                  options={[
                    { value: '', label: t('沿用默认') },
                    { value: 'codemode', label: t('通过脚本调用') },
                    { value: 'deferred', label: t('按需发现') },
                    { value: 'direct', label: t('直接使用') },
                    { value: 'hidden', label: t('隐藏') },
                    ...(!['', 'codemode', 'deferred', 'direct', 'hidden'].includes(draft.exposure)
                      ? [{ value: draft.exposure, label: draft.exposure }]
                      : [])
                  ]}
                  onChange={(value) => onDraft({ exposure: value })}
                />
                <label htmlFor={fieldId('advanced')} className="block text-sm font-medium">
                  {t('其他配置（JSON）')}
                </label>
                <Textarea
                  id={fieldId('advanced')}
                  onFocus={() => setAdvancedOpen(true)}
                  value={draft.advanced}
                  disabled={pending}
                  className="min-h-40 font-mono"
                  spellCheck={false}
                  aria-invalid={error?.field === 'advanced'}
                  aria-describedby={
                    error?.field === 'advanced' ? fieldId('advanced-error') : undefined
                  }
                  onChange={(event) => onDraft({ advanced: event.target.value })}
                />
                <L2PiSettingsError
                  id={fieldId('advanced-error')}
                  message={error?.field === 'advanced' ? error.message : null}
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
        ) : editor.kind === 'json' ? (
          <div className="space-y-3">
            {field(
              'json',
              '配置 JSON',
              <Textarea
                id={fieldId('json')}
                value={editor.text}
                disabled={pending}
                aria-invalid={error?.field === 'json'}
                aria-describedby={error?.field === 'json' ? fieldId('json-error') : undefined}
                spellCheck={false}
                className="min-h-48 font-mono"
                placeholder={'{ "mcpServers": { "docs": { "url": "https://example.com/mcp" } } }'}
                onChange={(event) => onJson(event.target.value)}
              />
            )}
            <p className="text-xs text-muted-foreground">
              {t('仅接受包含 mcpServers 的标准 JSON。')}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={onPreview}
              disabled={pending || !editor.text.trim()}
            >
              {t('解析预览')}
            </Button>
            {editor.preview && (
              <section aria-label={t('待保存服务')} className="space-y-3">
                <ul className="divide-y border-y">
                  {Object.entries(editor.preview).map(([name, config]) => (
                    <li
                      key={name}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm"
                    >
                      <span className="min-w-0 break-all font-medium">{name}</span>
                      <span className="text-xs text-muted-foreground">
                        {t(
                          isL2McpShorthand(config)
                            ? '继承全局连接'
                            : 'url' in config
                              ? 'HTTP 地址'
                              : '本地程序'
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t(
                          Object.hasOwn(local, name)
                            ? '替换已有配置'
                            : Object.hasOwn(inherited, name)
                              ? '覆盖全局（仅本项目）'
                              : '新增'
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t(config.enabled === false ? '已停用' : '已启用')}
                      </span>
                    </li>
                  ))}
                </ul>
                {collisions.length > 0 && (
                  <label className="flex min-h-8 cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editor.overwrite}
                      disabled={pending}
                      className="mt-1 size-4 shrink-0 accent-primary"
                      onChange={(event) => onOverwrite(event.target.checked)}
                    />
                    <span>{t('允许替换以上同名已有配置')}</span>
                  </label>
                )}
              </section>
            )}
          </div>
        ) : null}
        <div className="mt-3">
          <L2PiSettingsError message={error?.field === 'save' ? error.message : null} />
        </div>
      </div>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-background px-4 py-3 sm:px-6">
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          {t('取消')}
        </Button>
        {draft && (
          <Button
            type="button"
            variant="outline"
            disabled={pending || !draft.enabled || projectTrusted === false}
            onClick={() => onSave(true)}
          >
            {t('保存并测试')}
          </Button>
        )}
        <Button
          type="submit"
          disabled={
            pending ||
            (editor.kind === 'json' &&
              (!editor.preview || (collisions.length > 0 && !editor.overwrite)))
          }
        >
          {t(check?.loading ? '正在测试连接…' : pending ? '保存中…' : '保存')}
        </Button>
      </footer>
    </form>
  )
}
