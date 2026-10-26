import { Popover } from '@base-ui/react/popover'
import { useId, useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { PluginSurface } from './react-ui.tsx'

const POPOVER_STYLES = `
.pi-desk-ui-popover-positioner{z-index:1020;max-width:calc(100vw - 1rem);outline:none}
.pi-desk-ui-popover{display:flex;min-width:0;max-width:min(calc(100vw - 1rem),var(--available-width));max-height:min(28rem,var(--available-height));flex-direction:column;overflow:auto;border:1px solid var(--pi-desk-plugin-border,var(--border));border-radius:.75rem;background:var(--pi-desk-plugin-popover,var(--popover,var(--card)));color:var(--pi-desk-plugin-popover-foreground,var(--popover-foreground,var(--foreground)));box-shadow:0 .6rem 1.6rem rgb(0 0 0 / .2);transform-origin:var(--transform-origin);outline:none;transition:opacity 100ms ease-out,transform 100ms ease-out}
.pi-desk-ui-popover[data-starting-style],.pi-desk-ui-popover[data-ending-style]{opacity:0;transform:scale(.98)}
@media(prefers-reduced-motion:reduce){.pi-desk-ui-popover{transition:none}}
`

export interface PluginPopoverProps {
  open: boolean
  onOpenChange: NonNullable<Popover.Root.Props['onOpenChange']>
  trigger: ReactElement
  children: ReactNode
  side?: Popover.Positioner.Props['side']
  align?: Popover.Positioner.Props['align']
  className?: string
}

export function PluginPopover({
  open,
  onOpenChange,
  trigger,
  children,
  side = 'bottom',
  align = 'start',
  className
}: PluginPopoverProps): React.JSX.Element {
  const triggerId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const focusInside = useRef(false)

  useLayoutEffect(() => {
    // 自动提示复用同一实例，不能继承上次详情操作的焦点归属。
    if (open) focusInside.current = false
  }, [open])

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal={false} triggerId={triggerId}>
      <Popover.Trigger ref={triggerRef} id={triggerId} render={trigger} />
      <Popover.Portal>
        <style href="pi-desk-popover" precedence="pi-desk-ui">
          {POPOVER_STYLES}
        </style>
        <Popover.Positioner
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          collisionAvoidance={{ side: 'none', align: 'shift', fallbackAxisSide: 'none' }}
          className="pi-desk-ui-popover-positioner"
        >
          <Popover.Popup
            render={<PluginSurface />}
            className={['pi-desk-ui-popover', className].filter(Boolean).join(' ')}
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
            finalFocus={() => (focusInside.current ? (triggerRef.current ?? false) : false)}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
