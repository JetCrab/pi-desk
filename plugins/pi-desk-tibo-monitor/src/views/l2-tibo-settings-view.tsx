import {
  PluginActionRow,
  PluginAlert,
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
import { tiboText } from '../l4-tibo-locale.js'

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
  const { snapshot, draft, models, modelsLoading, modelsError, saving, dirty, error } = state
  if (!draft || !snapshot) return <></>
  const firstSetup = state.view === 'setup'
  const modelUnavailable =
    draft.model !== null && !models.some((model) => modelKey(model) === modelKey(draft.model))
  const options = models.map((model) => ({
    value: modelKey(model),
    label: `${model.provider} / ${model.name || model.modelId}`,
    textValue: `${model.provider} ${model.modelId}`
  }))
  if (draft.model && modelUnavailable) {
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
        <div className="tibo-model-field">
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
          ) : modelsError ? (
            <PluginAlert tone="error" density="compact">
              {modelsError}
            </PluginAlert>
          ) : !models.length ? (
            <PluginAlert density="compact">
              {tiboText(
                region,
                '没有可用模型，请先在宿主中配置模型。',
                'No models available. Configure a model in the host first.'
              )}
            </PluginAlert>
          ) : modelUnavailable ? (
            <PluginAlert tone="warning" density="compact">
              {tiboText(
                region,
                '所选翻译模型当前不可用，请重新选择或检查模型配置与认证。',
                'The selected translation model is unavailable. Choose another model or check its configuration and authentication.'
              )}
            </PluginAlert>
          ) : null}
          <PluginActionRow>
            <PluginButton
              variant="ghost"
              size="sm"
              disabled={saving || modelsLoading}
              onClick={state.reload}
            >
              {tiboText(region, '重新读取模型', 'Reload models')}
            </PluginButton>
          </PluginActionRow>
        </div>
        {!firstSetup ? (
          <label className="tibo-toggle">
            <PluginCheckbox
              checked={draft.enabled}
              disabled={saving}
              onChange={(event) => state.setDraft({ ...draft, enabled: event.target.checked })}
            />
            {tiboText(region, '启用监听', 'Enable monitoring')}
          </label>
        ) : null}
        <div className="tibo-fields">
          <PluginField
            label={tiboText(region, '检查间隔（秒）', 'Check interval (seconds)')}
            description={tiboText(region, '30–86400 秒，整数', '30–86400 seconds, integer')}
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
            description={tiboText(region, '10–200 条，整数', '10–200 posts, integer')}
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
        {error ? (
          <PluginAlert tone="error" density="compact">
            {error}
          </PluginAlert>
        ) : null}
        {snapshot.status.error && snapshot.status.error !== error ? (
          <PluginAlert tone="error" density="compact">
            {snapshot.status.error}
          </PluginAlert>
        ) : null}
        <PluginActionRow className="tibo-form-actions">
          <PluginButton type="submit" disabled={!state.canSave}>
            {saving
              ? tiboText(region, '保存中…', 'Saving…')
              : firstSetup
                ? tiboText(region, '开始监听', 'Start monitoring')
                : tiboText(region, '保存设置', 'Save settings')}
          </PluginButton>
          {!firstSetup ? (
            <PluginButton variant="ghost" disabled={saving} onClick={state.cancelSettings}>
              {tiboText(region, '取消', 'Cancel')}
            </PluginButton>
          ) : null}
          {dirty ? (
            <span className="tibo-note">{tiboText(region, '未保存', 'Unsaved')}</span>
          ) : null}
        </PluginActionRow>
      </form>
    </div>
  )
}
