import { useMemo, useState } from 'react'
import type { BrowserPluginHost, BrowserSettingsPageTarget } from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginAlert,
  PluginButton,
  PluginConfirmDialog,
  PluginEmptyState,
  PluginInput,
  PluginListItem,
  PluginScroll,
  PluginSelectField,
  PluginSurface,
  PluginTab,
  PluginTabList
} from '@jetcrab/pi-desk-sdk/react/base'
import { useQuotaSettings } from '../hooks/l2-quota-settings.js'
import { groupChannels, matchesSearch } from '../l2-quota-model.js'
import { quotaText, readQuotaRegion } from '../l2-quota-locale.js'
import { QUOTA_STYLES } from '../l2-quota-styles.js'
import { QuotaSourceForm } from './l2-quota-source-form.js'

export function QuotaSettingsPage({
  host,
  target,
  signal
}: {
  host: BrowserPluginHost
  target: BrowserSettingsPageTarget
  signal: AbortSignal
}): React.JSX.Element {
  const model = useQuotaSettings(host, target, signal)
  const locale = readQuotaRegion(host).locale
  const t = (text: string, en?: string): string => quotaText(locale, text, en)
  const [displayEditing, setDisplayEditing] = useState(false)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const adapters = useMemo(
    () => new Map(model.settings.adapters.map((adapter) => [adapter.adapter, adapter])),
    [model.settings.adapters]
  )
  const sources = model.draft.filter((source) =>
    matchesSearch(query, source.name, adapters.get(source.adapter)?.label ?? source.adapter)
  )
  const startAdd = (): void => {
    setAdding(true)
    setEditing(true)
  }
  const save = (): void => {
    setQuery('')
    setAdding(false)
    setEditing(true)
    model.save()
  }

  return (
    <PluginSurface
      className="quota-settings"
      data-quota-settings=""
      data-editing={editing || adding || model.draft.length === 0}
    >
      <style>{QUOTA_STYLES}</style>
      <div className="quota-settings-head">
        <PluginTabList label={t('额度设置', 'Quota settings')}>
          <PluginTab active={!displayEditing} onClick={() => setDisplayEditing(false)}>
            {t('额度来源')}
          </PluginTab>
          <PluginTab active={displayEditing} onClick={() => setDisplayEditing(true)}>
            {t('显示设置')}
          </PluginTab>
        </PluginTabList>
        <div className="quota-actions">
          <PluginButton
            size="sm"
            variant="ghost"
            disabled={model.dirty || model.loading || model.saving}
            onClick={model.reload}
          >
            {t(model.loading ? '加载中…' : '重新加载')}
          </PluginButton>
          {!displayEditing ? (
            <PluginButton
              size="sm"
              variant="secondary"
              disabled={
                model.loading ||
                model.saving ||
                model.draft.length >= 50 ||
                model.settings.adapters.length === 0
              }
              onClick={startAdd}
            >
              {t('添加来源')}
            </PluginButton>
          ) : null}
        </div>
      </div>
      {displayEditing ? (
        <PluginScroll
          className="quota-editor-scroll"
          viewportClassName="quota-display-settings"
          aria-label={t('显示设置')}
        >
          {model.settings.error || model.error ? (
            <PluginAlert tone="error" density="compact">
              {model.error ?? model.settings.error}
            </PluginAlert>
          ) : null}
          <PluginSelectField
            label={t('重置时间格式')}
            value={model.resetTimeFormat}
            disabled={model.loading || model.saving}
            options={[
              { value: 'countdown', label: t('倒计时') },
              { value: 'absolute', label: t('具体时间') }
            ]}
            onValueChange={(value) => {
              if (value === 'countdown' || value === 'absolute') model.setResetTimeFormat(value)
            }}
          />
        </PluginScroll>
      ) : (
        <div className="quota-settings-body" data-empty={model.draft.length === 0}>
          <aside className="quota-settings-navigation" aria-label={t('额度来源导航')}>
            <PluginInput
              aria-label={t('搜索来源')}
              placeholder={t('搜索来源')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <PluginScroll
              className="quota-source-navigation-scroll"
              viewportClassName="quota-source-navigation-viewport"
              aria-label={t('来源列表')}
            >
              {sources.length === 0 ? (
                <PluginEmptyState density="compact">
                  {t(model.loading ? '正在读取…' : '没有匹配来源')}
                </PluginEmptyState>
              ) : (
                groupChannels(sources).map((channel) => (
                  <div className="quota-source-group" key={channel[0].adapter}>
                    <h3 className="quota-source-group-title">
                      {t(adapters.get(channel[0].adapter)?.label ?? channel[0].adapter)}
                    </h3>
                    {channel.map((source) => {
                      const invalid = [...model.validationErrors.keys()].some((key) =>
                        key.startsWith(`${source.draftKey}:`)
                      )
                      const changed = model.changedKeys.has(source.draftKey)
                      return (
                        <PluginListItem
                          key={source.draftKey}
                          density="compact"
                          className="quota-source-item"
                          data-quota-settings-nav-source={source.draftKey}
                          selected={!adding && model.selectedKey === source.draftKey}
                          disabled={model.saving}
                          onClick={() => {
                            model.select(source.draftKey)
                            setAdding(false)
                            setEditing(true)
                          }}
                        >
                          <span className="quota-truncate">
                            {source.name.trim() || t('未命名来源')}
                          </span>
                          <span
                            className={
                              invalid
                                ? 'quota-warning quota-source-item-state'
                                : 'quota-meta quota-source-item-state'
                            }
                          >
                            {t(
                              invalid
                                ? '待完善'
                                : changed
                                  ? '未保存'
                                  : source.enabled
                                    ? '启用'
                                    : '停用'
                            )}
                          </span>
                        </PluginListItem>
                      )
                    })}
                  </div>
                ))
              )}
            </PluginScroll>
          </aside>
          <PluginScroll
            className="quota-editor-scroll"
            viewportClassName="quota-editor-viewport"
            aria-label={t('来源编辑')}
          >
            {model.draft.length > 0 ? (
              <PluginButton
                size="sm"
                variant="ghost"
                className="quota-back"
                disabled={model.saving}
                onClick={() => {
                  setEditing(false)
                  setAdding(false)
                }}
              >
                {t('返回来源')}
              </PluginButton>
            ) : null}
            {model.settings.error ? (
              <PluginAlert density="compact" tone="error">
                {model.settings.error}
              </PluginAlert>
            ) : null}
            {model.error ? (
              <PluginAlert density="compact" tone="error">
                {model.error}
              </PluginAlert>
            ) : null}
            {adding ? (
              <div className="quota-add-source">
                <div className="quota-editor-head">
                  <h3 className="quota-section-title">{t('添加来源')}</h3>
                  <PluginButton size="sm" variant="ghost" onClick={() => setAdding(false)}>
                    {t('取消')}
                  </PluginButton>
                </div>
                <PluginSelectField
                  label={t('渠道')}
                  value={null}
                  placeholder={t('选择渠道')}
                  options={model.settings.adapters.map((adapter) => ({
                    value: adapter.adapter,
                    label: t(adapter.label)
                  }))}
                  onValueChange={(adapter) => {
                    if (!adapter) return
                    model.add(adapter)
                    setAdding(false)
                    setQuery('')
                  }}
                />
              </div>
            ) : model.selected ? (
              <>
                <div className="quota-editor-head">
                  <div className="quota-editor-title">
                    <h3 className="quota-section-title">
                      {model.selected.name.trim() || t('未命名来源')}
                    </h3>
                    {model.selected.name !== model.descriptor?.label ? (
                      <span className="quota-meta">
                        {model.descriptor?.label ?? model.selected.adapter}
                      </span>
                    ) : null}
                  </div>
                  <PluginButton
                    size="sm"
                    variant="danger"
                    disabled={model.saving}
                    onClick={model.remove}
                  >
                    {t('删除来源')}
                  </PluginButton>
                </div>
                <QuotaSourceForm
                  source={model.selected}
                  locale={locale}
                  descriptor={model.descriptor}
                  errors={model.validationErrors}
                  disabled={model.saving}
                  onChange={(source) => model.update(() => source)}
                />
              </>
            ) : (
              <PluginEmptyState density="compact">
                {t(model.loading ? '正在读取额度来源…' : '尚未配置额度来源')}
                {!model.loading && model.settings.adapters.length > 0 ? (
                  <PluginButton size="sm" variant="secondary" onClick={startAdd}>
                    {t('添加来源')}
                  </PluginButton>
                ) : null}
              </PluginEmptyState>
            )}
          </PluginScroll>
        </div>
      )}
      <footer className="quota-settings-footer">
        <div className="quota-meta" role="status">
          {model.removedCount > 0
            ? t(
                `已移除 ${model.removedCount} 个来源，保存后生效`,
                `${model.removedCount} sources will be removed on save`
              )
            : model.dirty
              ? t('有未保存更改')
              : null}
        </div>
        <div className="quota-actions">
          {model.dirty ? (
            <PluginButton
              size="sm"
              variant="ghost"
              disabled={model.saving}
              onClick={() => {
                model.discard()
                setAdding(false)
              }}
            >
              {t('放弃更改')}
            </PluginButton>
          ) : null}
          <PluginButton
            variant="primary"
            data-quota-settings-save=""
            disabled={!model.dirty || model.saving || model.loading}
            onClick={save}
          >
            {t(model.saving ? '保存中…' : '保存全部更改')}
          </PluginButton>
        </div>
      </footer>
      <PluginConfirmDialog
        open={model.leaveOpen}
        title={t('放弃未保存的更改？')}
        description={t('额度设置有未保存的更改。')}
        confirmLabel={t('放弃更改')}
        tone="danger"
        onConfirm={() => model.finishLeave(true)}
        onOpenChange={(open) => {
          if (!open) model.finishLeave(false)
        }}
      />
    </PluginSurface>
  )
}
