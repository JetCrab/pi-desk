import { DesktopIcon } from '../l4-desktop-ui'

export function AddressEditor({
  value,
  error,
  saving,
  editing,
  onChange,
  onSave,
  onCancel
}: {
  value: string
  error: string
  saving: boolean
  editing: boolean
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <form
      className="address-editor"
      aria-label={editing ? '编辑地址' : '添加地址'}
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && !saving) {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <div className="address-editor-row">
        <label className="field grow">
          <span className="sr-only">网页地址</span>
          <input
            autoFocus
            required
            inputMode="url"
            autoComplete="off"
            placeholder="输入网址，例如 http://192.168.1.20:30333"
            value={value}
            disabled={saving}
            aria-invalid={Boolean(error)}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        <button className="primary" type="submit" disabled={saving}>
          {saving ? '正在保存…' : editing ? '保存' : '添加并打开'}
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="取消编辑地址"
          disabled={saving}
          onClick={onCancel}
        >
          <DesktopIcon name="close" />
        </button>
      </div>
      {error && (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
