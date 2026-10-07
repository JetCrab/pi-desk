'use client'

import { motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { L4Otter } from '@client/l4_foundation/ui/otter/l4-otter'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import styles from './l2-workbench-session-guide.module.css'

export function L2WorkbenchSessionGuide({
  sidebarOpen,
  onOpen
}: {
  sidebarOpen: boolean
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const reduced = useReducedMotion()
  return (
    <div data-testid="workbench-session-guide" className={styles.guide}>
      <L4Otter state={sidebarOpen ? 'idle' : 'point'} size={120} className={styles.otter} />
      {!sidebarOpen ? (
        <>
          <svg
            data-testid="workbench-session-guide-arrow"
            aria-hidden="true"
            viewBox="0 0 36 32"
            className={styles.arrow}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <motion.path
              d="M30 26Q10 25 9 10"
              initial={reduced ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: reduced ? 0 : 0.7, ease: 'easeOut' }}
              opacity=".65"
            />
            <path d="M4 16L9 10L15 15" opacity=".65" />
          </svg>
          <Button
            variant="ghost"
            aria-label={t('showSessionMenu')}
            onClick={onOpen}
            className="absolute inset-0 size-full p-0 hover:bg-foreground/5"
          />
        </>
      ) : null}
    </div>
  )
}
