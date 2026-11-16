import { cn } from '@client/l4_foundation/lib/l4-utils'
import styles from './l4-loading-spinner.module.css'

export function L4LoadingSpinner({
  className,
  ...props
}: React.ComponentProps<'svg'>): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1rem"
      height="1rem"
      viewBox="0 0 25 25"
      fill="currentColor"
      stroke="none"
      data-slot="spinner"
      role="status"
      aria-label="正在加载"
      className={cn('size-4', styles.spinner, className)}
      {...props}
    >
      <circle cx="2.5" cy="2.5" r="2.5" />
      <circle cx="12.5" cy="2.5" r="2.5" />
      <circle cx="22.5" cy="2.5" r="2.5" />
      <circle cx="2.5" cy="12.5" r="2.5" />
      <circle cx="12.5" cy="12.5" r="2.5" />
      <circle cx="22.5" cy="12.5" r="2.5" />
      <circle cx="2.5" cy="22.5" r="2.5" />
      <circle cx="12.5" cy="22.5" r="2.5" />
      <circle cx="22.5" cy="22.5" r="2.5" />
    </svg>
  )
}
