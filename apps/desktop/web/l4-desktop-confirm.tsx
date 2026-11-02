import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode
} from 'react'

type ConfirmOptions = {
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
}

type DesktopConfirm = (options: ConfirmOptions) => Promise<boolean>
type PendingConfirmation = { options: ConfirmOptions; resolve: (confirmed: boolean) => void }

const ConfirmContext = createContext<DesktopConfirm | null>(null)

function ConfirmationDialog({
  options,
  settle
}: {
  options: ConfirmOptions
  settle: (confirmed: boolean) => void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    cancel.current?.focus()
    return () => element?.close()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="desktop-dialog desktop-confirm"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault()
        settle(false)
      }}
      onClose={() => settle(false)}
    >
      <h2 id={titleId}>{options.title}</h2>
      <p id={descriptionId}>{options.description}</p>
      <div className="dialog-actions">
        <button ref={cancel} type="button" onClick={() => settle(false)}>
          取消
        </button>
        <button
          className={options.danger ? 'danger' : 'primary'}
          type="button"
          onClick={() => settle(true)}
        >
          {options.confirmLabel}
        </button>
      </div>
    </dialog>
  )
}

export function DesktopConfirmProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [pending, setPending] = useState<PendingConfirmation | null>(null)
  const current = useRef<PendingConfirmation | null>(null)

  useEffect(
    () => () => {
      current.current?.resolve(false)
      current.current = null
    },
    []
  )

  const confirm = useCallback<DesktopConfirm>((options) => {
    // 模态期间重复触发按取消处理，不替换正在确认的操作。
    if (current.current) return Promise.resolve(false)
    return new Promise((resolve) => {
      const next = { options, resolve }
      current.current = next
      setPending(next)
    })
  }, [])

  const settle = (owner: PendingConfirmation, confirmed: boolean): void => {
    if (current.current !== owner) return
    current.current = null
    setPending(null)
    owner.resolve(confirmed)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmationDialog
          options={pending.options}
          settle={(confirmed) => settle(pending, confirmed)}
        />
      )}
    </ConfirmContext.Provider>
  )
}

export function useDesktopConfirm(): DesktopConfirm {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('桌面确认框必须在 DesktopConfirmProvider 内使用。')
  return confirm
}
