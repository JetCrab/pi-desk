import Image from 'next/image'
import brandIcon from './l4-brand-icon.svg'

export function L4BrandIcon({
  size = 40,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return <Image src={brandIcon} width={size} height={(size * 3) / 4} alt="" className={className} />
}
