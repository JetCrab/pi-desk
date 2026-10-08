import Image from 'next/image'
import type { ReactElement } from 'react'
import brandIcon from './l4-brand-icon.svg'

export function L4BrandIcon({
  size,
  className
}: {
  size: number
  className?: string
}): ReactElement {
  return <Image src={brandIcon} width={size} height={(size * 3) / 4} alt="" className={className} />
}
