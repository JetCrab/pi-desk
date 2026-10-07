'use client'

import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useReducedMotion } from 'motion/react'
import { useL4PowerSaving } from './l4-power-saving'

export function useL4WindowReveal(
  elementRef: RefObject<HTMLElement | null>,
  identity: string | null
): void {
  const reducedMotion = useReducedMotion()
  const powerSaving = useL4PowerSaving()
  const previousIdentity = useRef<string | null>(null)

  useLayoutEffect(() => {
    const element = elementRef.current
    const changed = previousIdentity.current !== identity
    previousIdentity.current = identity
    if (!element || !identity || !changed || reducedMotion || powerSaving) return

    const animation = element.animate(
      [
        { opacity: 0, transform: 'translateY(5px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ],
      { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    )
    return () => animation.cancel()
  }, [elementRef, identity, powerSaving, reducedMotion])
}
