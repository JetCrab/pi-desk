import {
  PluginActionRow,
  PluginAlert,
  PluginBadge,
  PluginButton,
  PluginCheckbox,
  PluginField,
  PluginInput,
  PluginLoadingState,
  PluginSelect
} from '@jetcrab/pi-desk-sdk/react/base'
import type { useTiboPage } from '../l2-browser-hooks.js'
import type { ModelSelection } from '../l4-tibo-protocol.js'
import type { HostRegion } from '@jetcrab/pi-desk-sdk/settings'
import { regionTime, tiboText } from '../l4-tibo-locale.js'

function modelKey(model: ModelSelection | null): string {
  return model ? JSON.stringify([model.provider, model.modelId]) : ''
}

export function TiboSettingsView({
  state,
  region
}: {
  state: ReturnType<typeof useTiboPage>
  region: HostRegion
}): React.JSX.Element {
  const { snapshot, draft, models, modelsLoading, saving, dirty, error } = state
  if (!draft || !snapshot) return <></>
  const options = models.map((model) => ({
    value: modelKey(model),
    label: `${model.provider} / ${model.name || model.modelId}`,
    textValue: `${model.provider} ${model.modelId}`
  }))
  if (draft.model && !options.some((item) => item.value === modelKey(draft.model))) {
    options.push({
      value: modelKey(draft.model),
      label: `${draft.model.provider} / ${draft.model.modelId}${modelsLoading ? '' : tiboText(region, '（当前不可用）', ' (unavailable)')}`,
      textValue: draft.model.modelId
    })
  }
  const chooseModel = tiboText(region, '选择翻译模型', 'Choose a translation model')
  options.unshift({ value: '', label: chooseModel, textValue: chooseModel })
  return (
    <div className="tibo-settings">
      <form
        className="tibo-form"
        onSubmit={(event) => {
          event.preventDefault()
          void state.save()
        }}
      >
        <PluginSelect
          label={tiboText(region, '翻译模型', 'Translation model')}
          placeholder={chooseModel}
          value={modelKey(draft.model)}
          options={options}
          disabled={saving || modelsLoading}
          onValueChange={(value) => {
            const selected = models.find((model) => modelKey(model) === value)
            state.setDraft({
              ...draft,
              model: selected ? { provider: selected.provider, modelId: selected.modelId } : null
            })
          }}
        />
        {modelsLoading ? (
          <PluginLoadingState
            loading
            loadingLabel={tiboText(region, '正在读取模型…', 'Loading models…')}
          >
            {null}
          </PluginLoadingState>
        ) : !models.length && !error ? (
          <PluginAlert density="compact">
            {tiboText(
              region,
              '没有可用模型，请先在宿主中配置模型。',
              'No models available. Configure a model in the host first.'
            )}
            <PluginButton variant="ghost" size="sm" onClick={state.reload}>
              {tiboText(region, '重新读取', 'Reload')}
            </PluginButton>
          </PluginAlert>
        ) : null}
        <label className="tibo-toggle">
          <PluginCheckbox
            checked={draft.enabled}
            disabled={saving}
            onChange={(event) => state.setDraft({ ...draft, enabled: event.target.checked })}
          />
          {tiboText(region, '启用监听', 'Enable monitoring')}
        </label>
        <details className="tibo-advanced">
          <summary>{tiboText(region, '更多设置', 'More settings')}</summary>
          <div className="tibo-fields">
            <PluginField
              label={tiboText(region, '检查间隔（秒）', 'Check interval (seconds)')}
              density="compact"
            >
              <PluginInput
                type="number"
                min={30}
                max={86400}
                step={1}
                required
                disabled={saving}
                value={Number.isNaN(draft.intervalSeconds) ? '' : draft.intervalSeconds}
                onChange={(event) =>
                  state.setDraft({ ...draft, intervalSeconds: event.target.valueAsNumber })
                }
              />
            </PluginField>
            <PluginField
              label={tiboText(region, '保留动态（条）', 'Posts to retain')}
              density="compact"
            >
              <PluginInput
                type="number"
                min={10}
                max={200}
                step={1}
                required
                disabled={saving}
                value={Number.isNaN(draft.retentionCount) ? '' : draft.retentionCount}
                onChange={(event) =>
                  state.setDraft({ ...draft, retentionCount: event.target.valueAsNumber })
                }
              />
            </PluginField>
          </div>
        </details>
        {error ? (
          <PluginAlert tone="error" density="compact">
            {error}
          </PluginAlert>
        ) : null}
        <PluginActionRow>
          <PluginButton type="submit" disabled={saving || !dirty}>
            {saving
              ? tiboText(region, '保存中…', 'Saving…')
              : tiboText(region, '保存设置', 'Save settings')}
          </PluginButton>
          {dirty ? (
            <span className="tibo-note">{tiboText(region, '未保存', 'Unsaved')}</span>
          ) : null}
        </PluginActionRow>
      </form>
      <details className="tibo-status-details">
        <summary>{tiboText(region, '运行状态', 'Monitor status')}</summary>
        <div className="tibo-status">
          <PluginBadge>
            {snapshot.settings.enabled
              ? tiboText(region, '监听已启用', 'Monitoring enabled')
              : tiboText(region, '监听未启用', 'Monitoring disabled')}
          </PluginBadge>
          {snapshot.status.polling ? (
            <span>{tiboText(region, '正在读取…', 'Fetching…')}</span>
          ) : null}
          {snapshot.status.translating ? (
            <span>{tiboText(region, '正在翻译…', 'Translating…')}</span>
          ) : null}
        </div>
        <p className="tibo-note">
          {tiboText(region, '上次检查：', 'Last checked: ')}
          {regionTime(snapshot.status.lastCheckedAt, region)}
        </p>
        {snapshot.status.error ? (
          <PluginAlert tone="error" density="compact">
            {snapshot.status.error}
          </PluginAlert>
        ) : null}
      </details>
    </div>
  )
}
