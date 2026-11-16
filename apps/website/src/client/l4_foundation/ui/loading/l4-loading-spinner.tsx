import type { ReactElement, SVGProps } from 'react'
import styles from './l4-loading-spinner.module.css'

export function L4LoadingSpinner({
  size = 24,
  className,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number | string }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      {...props}
      width={size}
      height={size}
      viewBox="0 0 25 25"
      className={className ? `${styles.spinner} ${className}` : styles.spinner}
      fill="currentColor"
      stroke="none"
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
