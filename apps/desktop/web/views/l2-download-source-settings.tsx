import { useState, type FormEvent } from 'react'
import { useDownloadSource } from '../hooks/l2-use-download-source'
import { normalizeDownloadRegistry } from '../l2-desktop-biz'
import { errorMessage, setEnvironmentDownloadSource, type DownloadSource } from '../l4-desktop-ipc'

export function DownloadSourceSettings(): React.JSX.Element {
  const { downloadSource, loading, loadError, reload, updateDownloadSource } = useDownloadSource()
  const [draft, setDraft] = useState<DownloadSource | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)
  const source = draft ?? downloadSource
  const disabled = loading || saving || Boolean(loadError)
  const changed = Boolean(
    draft &&
    (draft.mode !== downloadSource?.mode ||
      (draft.mode === 'custom' &&
        (downloadSource?.mode !== 'custom' || draft.registry !== downloadSource.registry)))
  )
  const change = (next: DownloadSource): void => {
    setDraft(next)
    setSaveError('')
    setSaved(false)
  }
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!source || disabled || !changed) return
    setSaveError('')
    setSaved(false)
    try {
      const next: DownloadSource =
        source.mode === 'custom'
          ? { mode: 'custom', registry: normalizeDownloadRegistry(source.registry) }
          : source
      setSaving(true)
      await setEnvironmentDownloadSource(next)
      updateDownloadSource(next)
      setDraft(null)
      setSaved(true)
    } catch (cause: unknown) {
      const message = errorMessage(cause)
      console.error('保存下载源失败：', message)
      setSaveError(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      className="download-source-settings"
      aria-label="下载源设置"
      data-testid="download-source-settings"
    >
      <form noValidate onSubmit={(event) => void save(event)}>
        <div className="download-source-row">
          <label className="field download-source">
            下载源
            <select
              data-testid="download-source-select"
              value={source?.mode ?? ''}
              disabled={disabled || !source}
              onChange={(event) => {
                const mode = event.target.value as DownloadSource['mode']
                change(
                  mode === 'custom'
                    ? {
                        mode,
                        registry: source?.mode === 'custom' ? source.registry : ''
                      }
                    : { mode }
                )
              }}
            >
              {!source && <option value="">{loadError ? '读取失败' : '正在读取…'}</option>}
              <option value="domestic">国内镜像</option>
              <option value="official">官方源</option>
              <option value="custom">自定义源</option>
            </select>
          </label>
          <button type="submit" data-testid="download-source-save" disabled={disabled || !changed}>
            {saving ? '正在保存…' : '保存下载源'}
          </button>
        </div>
        {source?.mode === 'custom' && (
          <label className="field">
            自定义下载地址
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/npm/"
              data-testid="download-source-registry"
              value={source.registry}
              disabled={disabled}
              aria-invalid={Boolean(saveError)}
              aria-describedby={saveError ? 'download-source-error' : undefined}
              onChange={(event) => change({ mode: 'custom', registry: event.target.value })}
            />
          </label>
        )}
      </form>
      {loadError && (
        <div className="page-error" role="alert">
          <p>下载源读取失败：{loadError}</p>
          <button type="button" onClick={reload} disabled={loading}>
            重新读取下载源
          </button>
        </div>
      )}
      {saveError && (
        <p className="page-error" id="download-source-error" role="alert">
          保存失败：{saveError}
        </p>
      )}
      {saved && (
        <p className="muted" role="status">
          下载源已保存
        </p>
      )}
    </section>
  )
}
