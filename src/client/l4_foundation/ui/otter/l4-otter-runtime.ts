import { L4OtterMotion, type L4OtterState } from './l4-otter-motion'

const PARTS = [
  'head',
  'face',
  'left-eye',
  'right-eye',
  'left-eye-shape',
  'right-eye-shape',
  'left-eye-shine',
  'right-eye-shine',
  'smile',
  'mouth',
  'cheeks',
  'thoughts',
  'surprise',
  'sleep',
  'sparkles',
  'busy-dots'
] as const

type Part = (typeof PARTS)[number]

interface OtterRuntime {
  setState: (state: L4OtterState) => void
  setActive: (active: boolean) => void
  dispose: () => void
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.min(high, Math.max(low, value))
}

function number(value: number): string {
  return value.toFixed(3)
}

function eyePath(width: number, height: number, curve: number): string {
  const w = number(width)
  const h = number(height + curve)
  const top = number(-height + curve)
  const x = number(width * 0.5523)
  const y1 = number(-height * 0.5523 + curve)
  const y2 = number(height * 0.5523 + curve)
  return `M-${w} 0C-${w} ${y1} -${x} ${top} 0 ${top}C${x} ${top} ${w} ${y1} ${w} 0C${w} ${y2} ${x} ${h} 0 ${h}C-${x} ${h} -${w} ${y2} -${w} 0Z`
}

export function createL4OtterRuntime(svg: SVGSVGElement): OtterRuntime {
  const parts = Object.fromEntries(
    PARTS.map((key) => [key, svg.querySelector<SVGElement>(`[data-part="${key}"]`)!])
  ) as Record<Part, SVGElement>
  const surface = svg.parentElement!
  const motion = new L4OtterMotion()
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let active = true
  let intersecting = false
  let frameId = 0
  let previousFrame: number | null = null
  let clock = 0
  let blinkAt = -10
  let nextBlink = 1.7
  const look = { x: 0, y: 0 }
  const target = { x: 0, y: 0 }

  function opacity(part: Part, value: number): void {
    parts[part].setAttribute('opacity', number(value))
  }

  function transform(part: Part, value: string): void {
    parts[part].setAttribute('transform', value)
  }

  function draw(): void {
    const p = motion.sample(clock, reduced.matches)
    const time = reduced.matches ? 1.2 : clock
    const breathe = reduced.matches ? 0 : Math.sin(clock * 1.7) * 0.005
    const gazeX = p.gazeX + (reduced.matches ? 0 : look.x * p.follow)
    const gazeY = p.gazeY + (reduced.matches ? 0 : look.y * p.follow)
    transform(
      'head',
      `translate(${number(p.x)} ${number(p.y)}) translate(320 274) rotate(${number(p.angle + (reduced.matches ? 0 : look.x * p.follow * 0.12))}) scale(${number(p.sx)} ${number(p.sy + breathe)}) translate(-320 -274)`
    )
    transform('face', `translate(${number(gazeX * 0.16)} ${number(gazeY * 0.12)})`)
    const blink = reduced.matches ? -1 : (clock - blinkAt) / 0.19
    const lid = blink >= 0 && blink <= 1 ? 0.07 + 0.93 * Math.abs(blink * 2 - 1) : 1
    for (const [side, x] of [
      ['left', 158],
      ['right', 354]
    ] as const) {
      transform(`${side}-eye`, `translate(${number(x + gazeX)} ${number(239 + gazeY)})`)
      const roundness = 1 - clamp(p.smile + p.sleepy)
      const height =
        (3.5 + (p.eye * 28 - 3.5) * roundness) * lid * (side === 'left' ? 1 - p.wink : 1)
      parts[`${side}-eye-shape`].setAttribute(
        'd',
        eyePath(22 + 4 * roundness, height, (-13 * p.smile + 8 * p.sleepy) * lid)
      )
      opacity(`${side}-eye-shine`, roundness * clamp((height - 8) / 16))
    }
    opacity('smile', 1 - p.mouth)
    opacity('mouth', p.mouth)
    opacity('cheeks', p.blush)
    opacity('thoughts', p.thought)
    Array.from(parts.thoughts.children).forEach((dot, index) => {
      dot.setAttribute(
        'opacity',
        number(0.25 + (0.75 * (1 + Math.sin(time * 2.8 - index * 0.9))) / 2)
      )
      dot.setAttribute('transform', `translate(0 ${number(Math.sin(time * 2 - index) * 3)})`)
    })
    opacity('surprise', p.surprise)
    opacity('sleep', p.sleep)
    Array.from(parts.sleep.children).forEach((sign, index) => {
      const phase = (time * 0.4 + index * 0.45) % 1
      sign.setAttribute('transform', `translate(${number(phase * 8)} ${number(-phase * 20)})`)
      sign.setAttribute('opacity', number(Math.sin(phase * Math.PI)))
    })
    opacity('sparkles', p.sparkle * (0.55 + (0.45 * (1 + Math.sin(time * 3))) / 2))
    transform('sparkles', `translate(0 ${number(Math.sin(time * 2) * 5)})`)
    opacity('busy-dots', p.busy)
    Array.from(parts['busy-dots'].children).forEach((dot, index) => {
      const phase = (((time - index * 0.18) % 1.4) + 1.4) % 1.4
      const pulse = Math.sin(Math.PI * clamp(phase / 0.55))
      dot.setAttribute('opacity', number(0.26 + 0.65 * pulse))
      dot.setAttribute('transform', `translate(0 ${number(-4 * pulse)})`)
    })
  }

  function canRun(): boolean {
    return active && intersecting && !document.hidden && !reduced.matches
  }

  function frame(now: number): void {
    frameId = 0
    if (!canRun()) return
    const elapsed = previousFrame === null ? 0 : Math.min((now - previousFrame) / 1000, 0.05)
    previousFrame = now
    clock += elapsed
    if (clock >= nextBlink) {
      blinkAt = clock
      nextBlink = clock + 2.4 + Math.random() * 2.8
    }
    const mix = 1 - Math.exp(-elapsed * 9)
    look.x += (target.x - look.x) * mix
    look.y += (target.y - look.y) * mix
    draw()
    frameId = requestAnimationFrame(frame)
  }

  function refresh(): void {
    cancelAnimationFrame(frameId)
    frameId = 0
    previousFrame = null
    draw()
    if (canRun()) frameId = requestAnimationFrame(frame)
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerType !== 'mouse' || !canRun()) return
    const bounds = surface.getBoundingClientRect()
    target.x = clamp(
      ((event.clientX - bounds.left - bounds.width / 2) /
        Math.max(bounds.width, window.innerWidth / 2)) *
        24,
      -18,
      18
    )
    target.y = clamp(
      ((event.clientY - bounds.top - bounds.height / 2) /
        Math.max(bounds.height, window.innerHeight / 2)) *
        20,
      -14,
      12
    )
  }

  function onPointerLeave(): void {
    target.x = 0
    target.y = 0
  }

  const observer = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting
    refresh()
  })
  observer.observe(surface)
  document.addEventListener('visibilitychange', refresh)
  reduced.addEventListener('change', refresh)
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.documentElement.addEventListener('pointerleave', onPointerLeave)
  window.addEventListener('blur', onPointerLeave)
  draw()

  return {
    setState(state): void {
      motion.setState(state, clock)
      if ((state === 'point' || state === 'think') && !reduced.matches) blinkAt = clock
      draw()
    },
    setActive(value): void {
      active = value
      refresh()
    },
    dispose(): void {
      cancelAnimationFrame(frameId)
      observer.disconnect()
      document.removeEventListener('visibilitychange', refresh)
      reduced.removeEventListener('change', refresh)
      document.removeEventListener('pointermove', onPointerMove)
      document.documentElement.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('blur', onPointerLeave)
    }
  }
}
