// 下拉菜单与右键菜单共用视觉；定位、焦点和键盘交互仍由 Base UI 管理。
export const l4MenuItemClassName =
  "relative flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm leading-5 outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-inset:pl-8 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

export const l4MenuDestructiveClassName =
  'data-[variant=destructive]:text-destructive data-[variant=destructive]:data-highlighted:bg-destructive/10 data-[variant=destructive]:data-highlighted:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive'

export const l4MenuPopupClassName =
  'z-50 max-h-(--available-height) min-w-60 max-w-[calc(100vw-2rem)] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,transform] duration-100 ease-out data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0 motion-reduce:transition-none'
