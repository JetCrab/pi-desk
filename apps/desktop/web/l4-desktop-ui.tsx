import { getVersion } from '@tauri-apps/api/app'
import { useEffect, useRef, useState, type ReactNode } from 'react'

const paths = {
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'm12 19-7-7 7-7m-7 7h14',
  chevron: 'm9 18 6-6-6-6',
  check: 'm20 6-11 11-5-5',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M3 10a9 9 0 1 1 2 9M3 4v6h6',
  download: 'M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  folder: 'M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z',
  monitor: 'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 21h8m-4-4v4',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z',
  globe: 'M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0ZM2 12h20M12 2a16 16 0 0 1 0 20 16 16 0 0 1 0-20',
  alert: 'M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0ZM12 7v6m0 4h.01',
  loader: 'M12 2a10 10 0 1 1-10 10',
  stop: 'M5 5h14v14H5z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'm6 6 12 12M6 18 18 6',
  edit: 'm16 3 5 5M4 20l4-1L21 6a2.1 2.1 0 0 0-3-3L5 16l-1 4Z',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7'
} as const

export function DesktopIcon({
  name,
  spinning = false
}: {
  name: keyof typeof paths
  spinning?: boolean
}): React.JSX.Element {
  return (
    <svg
      className={`icon${spinning ? ' spinning' : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  )
}

export function DesktopHeader({ children }: { children?: ReactNode }): React.JSX.Element {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch((cause: unknown): void => {
        console.error('读取桌面程序版本失败：', cause)
      })
  }, [])

  return (
    <header className="app-header">
      <div className="brand">
        <svg className="brand-mark" viewBox="24 80 464 348" fill="none" aria-hidden="true">
          <path
            fill="#B87945"
            d="M256 88C190 88 132 109 90 161C62 153 35 171 35 198C35 217 45 231 61 240L54 277C47 316 64 353 104 379C144 406 195 419 256 419C317 419 368 406 408 379C448 353 465 316 458 277L451 240C467 231 477 217 477 198C477 171 450 153 422 161C380 109 322 88 256 88Z"
          />
          <g fill="#303030">
            <path d="M76 180C62 177 53 186 53 198C53 207 57 215 64 220L76 180ZM436 180C450 177 459 186 459 198C459 207 455 215 448 220L436 180Z" />
          </g>
          <g className="brand-eyes">
            <g fill="#303030">
              <ellipse cx="158" cy="239" rx="26" ry="28" />
              <ellipse cx="354" cy="239" rx="26" ry="28" />
            </g>
            <g fill="#fff">
              <circle cx="166" cy="228" r="6.5" />
              <circle cx="362" cy="228" r="6.5" />
            </g>
          </g>
          <path
            fill="#F3E2C6"
            d="M170 272C201 253 229 240 256 240C283 240 311 253 342 272C383 255 425 261 444 288C472 327 443 369 406 389C367 409 315 419 256 419C197 419 145 409 106 389C69 369 40 327 68 288C87 261 129 255 170 272Z"
          />
          <path
            fill="#303030"
            d="M219 269C219 254 240 254 256 254C272 254 293 254 293 269C293 282 276 299 256 303C236 299 219 282 219 269Z"
          />
          <g stroke="#303030" strokeLinecap="round" strokeWidth="10">
            <path d="M256 300C256 317 246 327 232 327C220 327 211 322 207 314M256 300C256 317 266 327 280 327C292 327 301 322 305 314M101 298C116 293 132 292 146 292M110 327C123 318 135 312 148 310M411 298C396 293 380 292 366 292M402 327C389 318 377 312 364 310" />
          </g>
        </svg>
        <span>Pi Desk{version ? ` v${version}` : ''}</span>
      </div>
      <div className="header-actions">{children}</div>
    </header>
  )
}

export function DesktopExpansion({
  id,
  open,
  children
}: {
  id: string
  open: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <div id={id} className="desktop-expansion" data-open={open} inert={!open} aria-hidden={!open}>
      <div className="expansion-content">{children}</div>
    </div>
  )
}

export function DesktopMenu({
  label,
  children,
  trigger
}: {
  label: string
  children: ReactNode
  trigger?: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing && ref.current?.open) {
        ref.current.open = false
        ref.current.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [])
  return (
    <details ref={ref} className="menu">
      <summary aria-label={label} className={trigger ? 'menu-trigger' : undefined}>
        {trigger ?? <DesktopIcon name="more" />}
      </summary>
      <div
        className="menu-panel"
        onClick={(event) => {
          const button = (event.target as Element).closest('button')
          if (button && !button.disabled && ref.current) ref.current.open = false
        }}
      >
        {children}
      </div>
    </details>
  )
}

export function DesktopError({
  title,
  detail,
  onCopy,
  copied = false,
  expanded = false
}: {
  title?: string
  detail: string
  onCopy: () => void
  copied?: boolean
  expanded?: boolean
}): React.JSX.Element {
  return (
    <div className="error-block" role="alert">
      {title && (
        <p className="error-title">
          <DesktopIcon name="alert" />
          {title}
        </p>
      )}
      <details className="disclosure" open={expanded || undefined}>
        <summary>
          <DesktopIcon name="chevron" />
          问题详情
        </summary>
        <p className="error-detail">{detail}</p>
        <button className="quiet" type="button" onClick={onCopy}>
          <DesktopIcon name="copy" />
          {copied ? '已复制' : '复制问题信息'}
        </button>
      </details>
    </div>
  )
}
