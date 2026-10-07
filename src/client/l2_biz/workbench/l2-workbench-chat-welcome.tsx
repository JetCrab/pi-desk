'use client'

import {
  AnimatePresence,
  motion,
  useIsPresent,
  usePresenceData,
  useReducedMotion
} from 'motion/react'
import { useTranslation } from 'react-i18next'
import { L4Otter } from '@client/l4_foundation/ui/otter/l4-otter'
import { useL2WorkbenchWelcome } from './hooks/l2-workbench-welcome'
import { L2WorkbenchEmptyState } from './l2-workbench-empty-state'

function Welcome(): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const present = useIsPresent()
  const allowReaction = usePresenceData() === true
  const reduced = useReducedMotion()
  const { state, textKey } = useL2WorkbenchWelcome(present)
  if (!present && (!allowReaction || reduced)) return null

  return (
    <motion.div
      data-testid="workbench-empty-session"
      data-otter-state={state}
      data-leaving={present ? undefined : 'true'}
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4, transition: { delay: 0.55, duration: 1.15, ease: 'easeInOut' } }}
      className="flex max-w-sm flex-col items-center gap-5"
    >
      <L4Otter state={state} size={100} />
      <p className="min-h-6 text-sm leading-6 text-muted-foreground">
        {textKey ? t(textKey) : null}
      </p>
    </motion.div>
  )
}

export function L2WorkbenchChatWelcome({
  active,
  ready,
  empty,
  hasUserMessage
}: {
  active: boolean
  ready: boolean
  empty: boolean
  hasUserMessage: boolean
}): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 py-8 text-center">
      <AnimatePresence initial={false} custom={active && ready && hasUserMessage}>
        {active && ready && empty ? <Welcome key="welcome" /> : null}
      </AnimatePresence>
      {active && !ready && empty ? <L2WorkbenchEmptyState variant="loading" /> : null}
    </div>
  )
}
