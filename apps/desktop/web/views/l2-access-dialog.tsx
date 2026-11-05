import { useEffect, useId, useRef, type ReactNode } from 'react'
import { DesktopIcon } from '../l4-desktop-ui'

export function AccessDialog({
  title,
  busy,
  onClose,
  children
}: {
  title: string
  busy: boolean
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    const active = document.activeElement
    // 菜单动作执行后会折叠菜单，关闭对话框时返回仍可见的菜单入口。
    const trigger = active?.closest('details.menu')?.querySelector('summary') ?? active
    element?.showModal()
    element?.querySelector<HTMLElement>('input, textarea')?.focus()
    return () => {
      element?.close()
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className="desktop-dialog access-dialog"
      aria-labelledby={titleId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <div className="access-dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          type="button"
          aria-label="关闭对话框"
          disabled={busy}
          onClick={onClose}
        >
          <DesktopIcon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  )
}
