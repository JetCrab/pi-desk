export type L4OtterState =
  'idle' | 'hello' | 'point' | 'think' | 'busy' | 'happy' | 'surprise' | 'sleep'

const BASE = {
  x: 0,
  y: 0,
  angle: 0,
  sx: 1,
  sy: 1,
  gazeX: 0,
  gazeY: 0,
  eye: 1,
  wink: 0,
  smile: 0,
  sleepy: 0,
  mouth: 0,
  blush: 0,
  thought: 0,
  surprise: 0,
  sleep: 0,
  sparkle: 0,
  busy: 0,
  follow: 1
}
export type L4OtterPose = { [K in keyof typeof BASE]: number }
const CHANNELS = Object.keys(BASE) as (keyof L4OtterPose)[]
const DURATIONS: Record<L4OtterState, number> = {
  idle: 0.46,
  hello: 0.36,
  point: 0.45,
  think: 0.5,
  busy: 0.4,
  happy: 0.35,
  surprise: 0.2,
  sleep: 0.72
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function smooth(value: number): number {
  const t = clamp(value)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function poseFor(state: L4OtterState, t: number): L4OtterPose {
  const pose = { ...BASE }
  switch (state) {
    case 'hello': {
      const phase = t % 3.5
      const nod = Math.exp(-Math.pow((phase - 0.7) / 0.35, 2))
      pose.y = nod * 6
      pose.angle = -3 + nod * 3
      pose.wink = 0.94 * Math.exp(-Math.pow((phase - 1.2) / 0.23, 2))
      pose.sx = 1 + Math.sin(t * 3.2) * 0.012
      pose.sy = 1 - Math.sin(t * 3.2) * 0.014
      pose.blush = 0.23
      break
    }
    case 'point':
      pose.x = -9
      pose.y = -5
      pose.angle = -9
      pose.gazeX = -17
      pose.gazeY = -16
      pose.sx = 1.018
      pose.sy = 0.987
      pose.follow = 0
      break
    case 'think':
      pose.angle = 8 + Math.sin(t * 1.6) * 2
      pose.gazeX = 12 + Math.sin(t * 1.8) * 5
      pose.gazeY = -13
      pose.eye = 0.85
      pose.thought = 1
      pose.follow = 0.1
      break
    case 'busy': {
      const phase = t % 3.6
      const scan = smooth(phase / 1.45)
      const returnLook = smooth((phase - 2.15) / 0.65)
      const nod = Math.exp(-Math.pow((phase - 1.9) / 0.22, 2))
      pose.gazeX = -11 + 22 * scan - 22 * returnLook
      pose.gazeY = 8 + nod * 2
      pose.angle = pose.gazeX * 0.1
      pose.y = 3 + nod * 4
      pose.eye = 0.9 + nod * 0.05
      pose.sy = 1 - nod * 0.006
      pose.busy = 1
      pose.follow = 0
      break
    }
    case 'happy': {
      const bounce = (1 - Math.cos(t * 5.5)) / 2
      pose.y = -bounce * 14
      pose.sx = 1.025 - bounce * 0.035
      pose.sy = 0.975 + bounce * 0.045
      pose.angle = Math.sin(t * 2.5) * 4
      pose.smile = 1
      pose.blush = 0.6
      pose.sparkle = 1
      pose.follow = 0.15
      break
    }
    case 'surprise':
      pose.y = -9 - Math.exp(-t * 1.5) * 6
      pose.eye = 1.2
      pose.mouth = 1
      pose.sx = 0.96
      pose.sy = 1.045
      pose.surprise = 1
      pose.follow = 0.25
      break
    case 'sleep':
      pose.angle = 11 + Math.sin(t * 1.25) * 2
      pose.y = 6 + Math.sin(t * 1.25) * 3
      pose.sy = 0.965 + Math.sin(t * 1.25) * 0.01
      pose.sleepy = 1
      pose.sleep = 1
      pose.follow = 0
      break
    default:
      pose.gazeX = Math.sin(t * 0.8) * 4
      pose.gazeY = Math.sin(t * 0.67) * 2
  }
  return pose
}

type Transition = { at: number } & (
  { pose: L4OtterPose } | { state: L4OtterState; started: number }
)

export class L4OtterMotion {
  private state: L4OtterState = 'idle'
  private started = 0
  private transition: Transition | null = null

  setState(state: L4OtterState, now: number): void {
    if (state === this.state) return
    const interrupted = this.transition && now - this.transition.at < DURATIONS[this.state]
    // 正常切换延续旧动作；被打断时从当前混合姿态继续，而不是跳回目标姿态。
    this.transition = interrupted
      ? { pose: this.sample(now), at: now }
      : { state: this.state, started: this.started, at: now }
    this.state = state
    this.started = now
  }

  sample(now: number, reducedMotion = false): L4OtterPose {
    const target = poseFor(this.state, reducedMotion ? 1.2 : Math.max(0, now - this.started))
    if (!this.transition || reducedMotion) return target
    const ratio = clamp((now - this.transition.at) / DURATIONS[this.state])
    if (ratio === 1) return target
    const origin =
      'pose' in this.transition
        ? this.transition.pose
        : poseFor(this.transition.state, Math.max(0, now - this.transition.started))
    const mix = 1 - (1 - ratio) ** 5
    for (const key of CHANNELS) target[key] = origin[key] + (target[key] - origin[key]) * mix
    return target
  }
}
