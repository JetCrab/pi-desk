import { Popover } from '@base-ui/react/popover'
import { ChevronUpIcon } from 'lucide-react'
import { useId, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { PluginSurface } from './react-ui.tsx'

const STYLES = `
.pi-desk-ui-capsule-slot{position:relative;min-width:0;height:0;transition:height 200ms cubic-bezier(.22,.8,.25,1)}
.pi-desk-ui-capsule-slot[data-visible]{height:2.75rem}
.pi-desk-ui-capsule-shell{position:absolute;bottom:.5rem;left:50%;height:2.25rem;max-width:100%;border-radius:2rem;background:var(--primary,#262626);color:var(--primary-foreground,#fafafa);opacity:0;transform:translate(-50%,.5rem) scale(.92);overflow:hidden;pointer-events:none;transition:width 200ms cubic-bezier(.22,.8,.25,1),opacity 150ms ease-out,transform 200ms cubic-bezier(.22,.8,.25,1)}
.pi-desk-ui-capsule-slot[data-visible] .pi-desk-ui-capsule-shell{opacity:1;transform:translate(-50%,0) scale(1);pointer-events:auto}
.pi-desk-ui-capsule-row{display:flex;align-items:center;width:max-content;max-width:min(22rem,var(--capsule-available-width));height:2.25rem}
.pi-desk-ui-capsule-trigger{display:flex;align-items:center;gap:.5rem;min-width:0;flex:1;height:2.25rem;padding:0 .875rem;border:0;background:transparent;color:inherit;font:inherit;font-size:.875rem;text-align:left;cursor:pointer;outline:none}
.pi-desk-ui-capsule-trigger:focus-visible{outline:2px solid currentColor;outline-offset:-4px;border-radius:2rem}
.pi-desk-ui-capsule-icon{display:flex;flex:none;align-items:center;justify-content:center}
.pi-desk-ui-capsule-icon>svg{width:1rem;height:1rem}
.pi-desk-ui-capsule-copy{min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;animation:pi-desk-capsule-copy 150ms ease-out}
.pi-desk-ui-capsule-meta{flex:none;font-size:.75rem;opacity:.75;font-variant-numeric:tabular-nums;white-space:nowrap}
.pi-desk-ui-capsule-chevron{flex:none;width:.875rem;height:.875rem;opacity:.75}
.pi-desk-ui-capsule-actions{display:flex;flex:none;align-items:center;padding-right:.375rem}
.pi-desk-ui-capsule-actions:empty{display:none}
.pi-desk-ui-capsule-positioner{z-index:1020;max-width:calc(100vw - 1rem);outline:none;filter:drop-shadow(0 .5rem 1rem rgb(0 0 0 / .16))}
.pi-desk-ui-capsule-popup[data-pi-desk-ui-root]{display:flex;flex-direction:column;width:26rem;max-width:var(--available-width);max-height:min(28rem,var(--available-height));overflow:hidden;background:var(--primary,#262626);color:var(--primary-foreground,#fafafa);border-radius:1.125rem;outline:none;clip-path:inset(0 0 0 0 round 1.125rem);transition:clip-path 200ms cubic-bezier(.22,.8,.25,1),opacity 150ms ease-out}
.pi-desk-ui-capsule-popup[data-starting-style],.pi-desk-ui-capsule-popup[data-ending-style]{clip-path:inset(max(0px,calc(100% - var(--anchor-height))) max(0px,calc((100% - var(--anchor-width))/2)) 0 round 1.125rem)}
.pi-desk-ui-capsule-body{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column;overflow:auto;overscroll-behavior:contain;opacity:1;transition:opacity 150ms ease-out}
.pi-desk-ui-capsule-popup[data-starting-style] .pi-desk-ui-capsule-body,.pi-desk-ui-capsule-popup[data-ending-style] .pi-desk-ui-capsule-body{opacity:0}
.pi-desk-ui-capsule-footer{display:flex;flex:none;min-width:0;min-height:2.25rem;border-top:1px solid color-mix(in srgb,currentColor 18%,transparent)}
.pi-desk-ui-capsule-footer .pi-desk-ui-capsule-chevron{transform:rotate(180deg)}
@keyframes pi-desk-capsule-copy{from{opacity:0;transform:translateY(.25rem)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){.pi-desk-ui-capsule-slot,.pi-desk-ui-capsule-shell,.pi-desk-ui-capsule-popup,.pi-desk-ui-capsule-body{transition:none}.pi-desk-ui-capsule-copy{animation:none}}
`

export interface PluginStatusCapsuleProps {
  visible: boolean
  open: boolean
  onOpenChange: NonNullable<Popover.Root.Props['onOpenChange']>
  summary: string
  icon?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  triggerProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick'>
  openOnHover?: boolean
}

/** 保持挂载并更新 visible，才能完成退场；卸载仍立即释放全部视图资源。 */
export function PluginStatusCapsule({
  visible,
  open,
  onOpenChange,
  summary,
  icon,
  meta,
  actions,
  children,
  triggerProps,
  openOnHover = false
}: PluginStatusCapsuleProps): React.JSX.Element {
  const triggerId = useId()
  const slotRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const focusInside = useRef(false)
  const expanded = visible && open

  useLayoutEffect(() => {
    const slot = slotRef.current
    const shell = shellRef.current
    const row = rowRef.current
    if (!slot || !shell || !row) return
    // 只测量当前真实摘要，不复制插件视图；宽度不反向约束被观察内容。
    const measure = (): void => {
      slot.style.setProperty('--capsule-available-width', `${slot.clientWidth}px`)
      shell.style.width = `${row.offsetWidth}px`
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(slot)
    observer.observe(row)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (expanded) focusInside.current = false
  }, [expanded])

  const copy = (
    <>
      {icon ? <span className="pi-desk-ui-capsule-icon">{icon}</span> : null}
      <span key={summary} className="pi-desk-ui-capsule-copy">
        {summary}
      </span>
      {meta ? <span className="pi-desk-ui-capsule-meta">{meta}</span> : null}
      <ChevronUpIcon className="pi-desk-ui-capsule-chevron" aria-hidden="true" />
    </>
  )

  return (
    <Popover.Root open={expanded} onOpenChange={onOpenChange} modal={false} triggerId={triggerId}>
      <style href="pi-desk-status-capsule" precedence="pi-desk-ui">
        {STYLES}
      </style>
      <div
        ref={slotRef}
        data-slot="status-capsule"
        className="pi-desk-ui-capsule-slot"
        data-visible={visible || undefined}
      >
        <div
          ref={shellRef}
          data-slot="status-capsule-shell"
          className="pi-desk-ui-capsule-shell"
          inert={!visible}
          aria-hidden={!visible}
        >
          <div ref={rowRef} className="pi-desk-ui-capsule-row">
            <Popover.Trigger
              {...triggerProps}
              ref={triggerRef}
              id={triggerId}
              data-slot="status-capsule-trigger"
              className="pi-desk-ui-capsule-trigger"
              title={summary}
              openOnHover={openOnHover}
              delay={500}
              closeDelay={160}
            >
              {copy}
            </Popover.Trigger>
            {actions ? <div className="pi-desk-ui-capsule-actions">{actions}</div> : null}
          </div>
        </div>
      </div>
      <Popover.Portal>
        <Popover.Positioner
          anchor={shellRef}
          side="top"
          align="center"
          sideOffset={({ anchor }) => -anchor.height}
          collisionPadding={8}
          collisionAvoidance={{ side: 'none', align: 'shift', fallbackAxisSide: 'none' }}
          className="pi-desk-ui-capsule-positioner"
        >
          <Popover.Popup
            render={<PluginSurface />}
            className="pi-desk-ui-capsule-popup"
            data-slot="status-capsule-popup"
            aria-labelledby={triggerId}
            initialFocus={false}
            onFocusCapture={() => {
              focusInside.current = true
            }}
            onBlurCapture={(event) => {
              focusInside.current =
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
            }}
            finalFocus={() =>
              visible && focusInside.current ? (triggerRef.current ?? false) : false
            }
          >
            <div className="pi-desk-ui-capsule-body">{children}</div>
            <div className="pi-desk-ui-capsule-footer">
              <Popover.Close
                {...triggerProps}
                data-slot="status-capsule-close"
                className="pi-desk-ui-capsule-trigger"
              >
                {copy}
              </Popover.Close>
              {actions ? <div className="pi-desk-ui-capsule-actions">{actions}</div> : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
