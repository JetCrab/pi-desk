'use client'

import Image from 'next/image'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { siteAuthorName } from './l1-site-author'

export function SiteAvatar(): ReactElement {
  const root = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setVisible(true)
        observer.disconnect()
      },
      { rootMargin: '120px' }
    )
    observer.observe(root.current!)
    return () => observer.disconnect()
  }, [])
  return (
    <span
      ref={root}
      className="flex size-20 items-center justify-center overflow-hidden rounded-full bg-muted text-xl text-muted-foreground"
    >
      {visible && !failed ? (
        <Image
          src="/images/jetcrab-avatar.webp"
          alt={`${siteAuthorName} 的头像`}
          width={80}
          height={80}
          unoptimized
          onError={() => setFailed(true)}
          className="size-20 object-cover"
        />
      ) : (
        <span aria-hidden="true">J</span>
      )}
    </span>
  )
}
