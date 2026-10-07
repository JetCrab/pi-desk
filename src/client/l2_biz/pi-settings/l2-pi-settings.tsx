'use client'

import { PlusIcon } from 'lucide-react'
import { useId, useMemo } from 'react'
import type { BrowserBeforeLeaveHandler } from '@jetcrab/pi-desk-sdk/browser'
import { useL4AppSocket } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { useL2PiSettings } from './hooks/l2-use-pi-settings'
import { useL2PiSettingsText } from './l2-pi-settings-locale'
import { L2PiSettingsError, L2PiSettingsSelect } from './views/l2-pi-settings-fields'
import { L2McpSettingsList } from './views/l2-mcp-settings-list'
import { L2McpSettingsEditor } from './views/l2-mcp-settings-editor'
import { L2McpSettingsEmpty } from './views/l2-mcp-settings-empty'

export interface L2PiSettingsProps {
  projects: readonly { cwd: string; projectName: string }[]
  focusedCwd: string | null
  onBeforeLeaveChange: (handler: BrowserBeforeLeaveHandler | null) => void
}

export function L2PiSettings({
  projects,
  focusedCwd,
  onBeforeLeaveChange
}: L2PiSettingsProps): React.JSX.Element {
  const { clientId } = useL4AppSocket()
  const state = useL2PiSettings(clientId, onBeforeLeaveChange)
  const t = useL2PiSettingsText()
  const id = useId()
  const scopeOptions = useMemo(() => {
    const unique = new Map<string, { cwd: string; projectName: string }>()
    for (const project of projects) {
      const normalized = project.cwd.replaceAll('\\', '/').replace(/\/+$/, '')
      const key =
        /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')
          ? normalized.toLowerCase()
          : normalized
      if (!unique.has(key)) unique.set(key, project)
    }
    return [...unique.values()].sort(
      (a, b) => Number(b.cwd === focusedCwd) - Number(a.cwd === focusedCwd)
    )
  }, [projects, focusedCwd])
  const scopeLabel =
    state.cwd === null
      ? t('全局')
      : `${scopeOptions.find((project) => project.cwd === state.cwd)?.projectName ?? t('当前项目')} · ${state.cwd}`
  const editing = Boolean(state.editor && state.mcp)
  const empty = Boolean(
    state.mcp && !state.loading && !state.loadError && !editing && state.rows.length === 0
  )
  const busy = state.pending || Boolean(state.check?.loading)
  const selectedName = state.editor?.kind === 'manual' ? state.editor.draft.originalName : null
  const addManually = (): void => {
    void state.navigate(() => state.startManual(null))
  }
  const importJson = (): void => {
    void state.navigate(() =>
      state.setEditor({ kind: 'json', text: '', preview: null, overwrite: false })
    )
  }

  return (
    <section aria-label="MCP" className="@container/mcp flex h-full min-h-0 min-w-0 flex-col">
      {state.dialog}
      <header
        className={cn(
          'grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b p-4',
          !empty && '@min-[40rem]/mcp:grid-cols-[auto_minmax(0,1fr)_auto]'
        )}
      >
        <h2 className="text-xl font-semibold">MCP</h2>
        {!empty && (
          <div className="col-start-2 flex flex-wrap justify-end gap-2 @min-[40rem]/mcp:col-start-3 @min-[40rem]/mcp:self-end">
            <Button disabled={busy || state.loading || !state.mcp} onClick={addManually}>
              <PlusIcon aria-hidden="true" />
              {t('添加服务')}
            </Button>
            <Button
              variant="outline"
              disabled={busy || state.loading || !state.mcp}
              onClick={importJson}
            >
              {t('导入 JSON')}
            </Button>
          </div>
        )}
        {/* Select 尾随隐藏输入，space-y 会给选择框追加底部间距；并排工具栏中需清除。 */}
        <div
          className={cn(
            'col-span-2 row-start-2 w-full @min-[40rem]/mcp:col-span-1 @min-[40rem]/mcp:col-start-2 @min-[40rem]/mcp:row-start-1 @min-[40rem]/mcp:max-w-80 @min-[40rem]/mcp:justify-self-end @min-[40rem]/mcp:[&_[data-slot=select-trigger]]:mb-0',
            empty && '@min-[40rem]/mcp:w-56'
          )}
        >
          <L2PiSettingsSelect
            id={`${id}-scope`}
            label={t('配置范围')}
            value={state.cwd ?? ''}
            disabled={busy}
            options={[
              { value: '', label: t('全局') },
              ...scopeOptions.map((project) => ({
                value: project.cwd,
                label: `${project.projectName}${project.cwd === focusedCwd ? ` · ${t('当前项目')}` : ''}`
              }))
            ]}
            onChange={(value) => {
              if (value !== (state.cwd ?? ''))
                void state.navigate(() => state.setCwd(value || null))
            }}
          />
        </div>
      </header>
      {state.notice && !state.check && (
        <p role="status" className="shrink-0 break-words border-b px-4 py-2 text-sm">
          {t(state.notice)}
        </p>
      )}
      {state.mcp?.projectTrusted === false && (
        <p className="shrink-0 px-4 pt-3 text-sm text-muted-foreground">
          {t('本项目尚未受信任，不能执行检查；仍可编辑和保存配置。')}
        </p>
      )}
      {state.mcp && state.mcp.diagnostics.length > 0 && (
        <div className="max-h-32 shrink-0 space-y-2 overflow-y-auto px-4 pt-3">
          {state.mcp.diagnostics.map((item, index) => (
            <L2PiSettingsError
              key={index}
              message={`${item.name ? `${item.name}：` : ''}${item.message}`}
            />
          ))}
        </div>
      )}
      {state.loadError ? (
        <div className="space-y-3 p-4">
          <L2PiSettingsError message={state.loadError} />
          <Button variant="outline" onClick={state.retry} disabled={state.loading}>
            {t('重试')}
          </Button>
        </div>
      ) : state.loading && !editing ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {t('正在读取配置…')}
        </p>
      ) : state.mcp ? (
        <div className="flex min-h-0 min-w-0 flex-1">
          {state.editor?.kind !== 'json' && state.rows.length > 0 && (
            <div
              className={cn(
                'pi-desk-chat-scrollbar min-h-0 min-w-0 overflow-y-auto',
                editing
                  ? 'hidden @min-[48rem]/mcp:block @min-[48rem]/mcp:w-56 @min-[48rem]/mcp:shrink-0 @min-[48rem]/mcp:border-r'
                  : 'flex-1'
              )}
            >
              {!editing && state.error && (
                <div className="p-4">
                  <L2PiSettingsError message={state.error.message} />
                </div>
              )}
              <L2McpSettingsList
                rows={state.rows}
                selectedName={selectedName}
                pending={busy}
                onSelect={(row) => {
                  if (selectedName === row.name) return
                  void state.navigate(() =>
                    row.local
                      ? state.startManual(row.name, row.local)
                      : state.startInherited(row.name, row.config)
                  )
                }}
              />
            </div>
          )}
          {state.editor ? (
            <L2McpSettingsEditor
              key={state.editor.kind === 'manual' ? (selectedName ?? 'new') : 'json'}
              editor={state.editor}
              scopeLabel={scopeLabel}
              project={state.cwd !== null}
              projectTrusted={state.mcp.projectTrusted}
              local={state.mcp.local}
              inherited={state.mcp.inherited}
              pending={busy}
              error={state.error}
              check={state.check?.name === selectedName ? state.check : null}
              onDraft={state.updateDraft}
              onJson={state.updateJson}
              onPreview={state.previewJson}
              onOverwrite={(overwrite) =>
                state.setEditor((current) =>
                  current?.kind === 'json' ? { ...current, overwrite } : current
                )
              }
              onSave={(testConnection) => void state.saveEditor(testConnection)}
              onCancel={() => void state.navigate(() => state.setEditor(null))}
              onRemove={(name) => void state.remove(name)}
              onDismissCheck={state.dismissCheck}
            />
          ) : state.rows.length === 0 ? (
            <L2McpSettingsEmpty pending={busy} onAdd={addManually} onImport={importJson} />
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
