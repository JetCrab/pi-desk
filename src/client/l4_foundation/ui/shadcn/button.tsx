import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@client/l4_foundation/lib/l4-utils'

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap cursor-pointer transition-colors duration-150 ease-out outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-[color-mix(in_oklab,var(--accent),var(--foreground)_5%)] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-[color-mix(in_oklab,var(--primary),var(--primary-foreground)_8%)] active:bg-[color-mix(in_oklab,var(--primary),var(--primary-foreground)_14%)]',
        outline:
          'border-border bg-card text-card-foreground hover:bg-accent active:bg-[color-mix(in_oklab,var(--accent),var(--foreground)_6%)] aria-expanded:bg-accent aria-expanded:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklab,var(--secondary),var(--foreground)_8%)] active:bg-[color-mix(in_oklab,var(--secondary),var(--foreground)_14%)] aria-expanded:bg-accent aria-expanded:text-accent-foreground',
        ghost:
          'hover:bg-foreground/8 hover:text-foreground active:bg-foreground/14 aria-expanded:bg-accent aria-expanded:text-accent-foreground',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40',
        link: 'text-foreground underline underline-offset-4 hover:text-muted-foreground'
      },
      size: {
        default: 'min-h-8 gap-2 px-2 py-1',
        xs: 'min-h-7 gap-2 rounded-md px-2 py-0.5 text-sm',
        sm: 'min-h-7 gap-2 rounded-md px-2 py-0.5 text-sm',
        lg: 'min-h-10 gap-2 px-3 py-2',
        icon: 'size-8',
        'icon-xs': 'size-7 rounded-md',
        'icon-sm': 'size-7 rounded-md',
        'icon-lg': 'size-10'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
