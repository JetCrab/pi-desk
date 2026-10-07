'use client'

import type { CSSProperties } from 'react'
import { getL3WorkSessionProjectColor } from './l3-work-session-visual'
import styles from './l3-work-session-visual-effects.module.css'

export {
  L3WorkSessionStatusBorder,
  type L3WorkSessionVisualState
} from './l3-work-session-status-border'

interface L3WorkSessionPresentation {
  className: string
  style: CSSProperties
}

function projectStyle(cwd: string): CSSProperties {
  return { '--pi-desk-project-color': getL3WorkSessionProjectColor(cwd) } as CSSProperties
}

export function getL3WorkSessionSurfacePresentation(cwd: string): L3WorkSessionPresentation {
  return {
    className: styles.surface,
    style: projectStyle(cwd)
  }
}

export function getL3WorkSessionIdentityPresentation(cwd: string): L3WorkSessionPresentation {
  return { className: styles.identity, style: projectStyle(cwd) }
}
