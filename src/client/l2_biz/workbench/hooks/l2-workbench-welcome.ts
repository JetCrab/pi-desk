import { useEffect, useState } from 'react'
import { L2_WORKBENCH_LOCALE_MESSAGES } from '@common/l2_biz/workbench/l2-workbench-locale-messages'
import type { L4OtterState } from '@client/l4_foundation/ui/otter/l4-otter'

interface WelcomeEgg {
  quip: string
  waiting: L4OtterState
  reaction: L4OtterState
  recover: L4OtterState
  reply: string
}

const QUIPS = Object.keys(L2_WORKBENCH_LOCALE_MESSAGES.en).filter((key) =>
  key.startsWith('emptyQuip')
)
let previousQuipIndex: number | null = null

function pickEgg(): WelcomeEgg {
  let index = Math.floor(
    Math.random() * (previousQuipIndex === null ? QUIPS.length : QUIPS.length - 1)
  )
  if (previousQuipIndex !== null && index >= previousQuipIndex) index += 1
  previousQuipIndex = index
  const quip = QUIPS[index]
  if (quip === 'emptyQuip16' || quip === 'emptyQuip10') {
    return {
      quip,
      waiting: 'sleep',
      reaction: 'surprise',
      recover: 'hello',
      reply: 'emptyWakeReply'
    }
  }
  if (quip === 'emptyQuip1' || quip === 'emptyQuip14') {
    return { quip, waiting: 'sleep', reaction: 'hello', recover: 'idle', reply: 'emptyFishReply' }
  }
  if (quip === 'emptyQuip12' || quip === 'emptyQuip15') {
    return {
      quip,
      waiting: 'think',
      reaction: 'surprise',
      recover: 'idle',
      reply: 'emptyCuriousReply'
    }
  }
  return { quip, waiting: 'idle', reaction: 'happy', recover: 'hello', reply: 'emptyPartnerReply' }
}

export function useL2WorkbenchWelcome(present: boolean): {
  state: L4OtterState
  textKey: string | null
} {
  const [egg, setEgg] = useState<WelcomeEgg | null>(null)
  const [recovering, setRecovering] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEgg(pickEgg()))
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setRecovering(!present), present ? 0 : 320)
    return () => window.clearTimeout(timer)
  }, [present])

  return {
    state: egg ? (present ? egg.waiting : recovering ? egg.recover : egg.reaction) : 'sleep',
    textKey: egg ? (present ? egg.quip : egg.reply) : null
  }
}
