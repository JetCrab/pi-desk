import { useEffect, useRef, useState } from 'react'
import { useDesktopAction } from '../hooks/l2-use-desktop-action'
import { saveStartupPreference } from '../l2-desktop-biz'
import type { ControlState, StartupPreferences } from '../l4-desktop-ipc'

export function StartupPreferenceDialog({ refresh }: { refresh: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const action = useDesktopAction(refresh)
  const [chosen, setChosen] = useState(false)

  useEffect(() => {
    if (!chosen) dialog.current?.showModal()
    return () => dialog.current?.close()
  }, [chosen])

  const choose = async (hideOnStartup: boolean): Promise<void> => {
    if (await action.run(() => saveStartupPreference({ hideOnStartup }))) {
      setChosen(true)
      dialog.current?.close()
    }
  }

  return (
    <dialog
      ref={dialog}
      className="desktop-dialog"
      aria-labelledby="startup-preference-title"
      aria-describedby="startup-preference-description"
      onCancel={(event) => {
        event.preventDefault()
        void choose(false)
      }}
    >
      <h2 id="startup-preference-title">下次启动时隐藏配置页？</h2>
      <p id="startup-preference-description" className="muted">
        下次启动直接进入 Pi Desk。可从托盘打开配置页，也可在设置中关闭。
      </p>
      {action.error && (
        <p className="page-error" role="alert">
          保存失败：{action.error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" disabled={action.busy} onClick={() => void choose(false)} autoFocus>
          每次显示
        </button>
        <button
          className="primary"
          type="button"
          disabled={action.busy}
          onClick={() => void choose(true)}
        >
          下次隐藏
        </button>
      </div>
    </dialog>
  )
}

const preferences = [
  { field: 'hideOnStartup', label: '启动时自动隐藏配置页' },
  { field: 'hideOnOpen', label: '打开聊天后隐藏配置页' },
  { field: 'showOnClose', label: '关闭聊天后显示配置页' }
] as const

export function ConfigurationPreferences({
  state,
  refresh
}: {
  state: ControlState | null
  refresh: () => void
}): React.JSX.Element {
  return (
    <section className="startup-settings" aria-label="配置页显示习惯">
      {preferences.map((preference) => (
        <PreferenceSwitch
          key={preference.field}
          {...preference}
          value={state?.[preference.field]}
          refresh={refresh}
        />
      ))}
    </section>
  )
}

function PreferenceSwitch({
  field,
  label,
  value,
  refresh
}: {
  field: keyof StartupPreferences
  label: string
  value: boolean | null | undefined
  refresh: () => void
}): React.JSX.Element {
  const action = useDesktopAction(refresh)
  const change = async (next: boolean): Promise<void> => {
    await action.run(() => saveStartupPreference({ [field]: next }))
  }

  return (
    <div>
      <label className="setting-toggle">
        <span>{label}</span>
        <input
          className="switch"
          type="checkbox"
          role="switch"
          checked={value ?? false}
          disabled={value === undefined || action.busy}
          onChange={(event) => void change(event.target.checked)}
        />
      </label>
      {action.error && (
        <p className="page-error" role="alert">
          保存失败：{action.error}
        </p>
      )}
    </div>
  )
}
