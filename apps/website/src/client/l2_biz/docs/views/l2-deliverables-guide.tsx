import { Fragment, type ReactElement } from 'react'
import {
  DeliverablesConfig,
  DeliverablesEffect,
  DeliverablesPrinciple
} from './l2-deliverables-figures'
import { DeliverablesUsage } from './l2-deliverables-media'

const visuals: Record<string, () => ReactElement> = {
  effect: DeliverablesEffect,
  principle: DeliverablesPrinciple,
  usage: DeliverablesUsage,
  config: DeliverablesConfig
}

export function DeliverablesGuide({ html }: { html: string }): ReactElement {
  const parts = html.split(/&lt;!-- deliverables-(effect|principle|usage|config) --&gt;\s*/)
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) {
          return <div key={index} dangerouslySetInnerHTML={{ __html: part }} />
        }
        const Visual = visuals[part]
        return (
          <Fragment key={part}>
            <Visual />
          </Fragment>
        )
      })}
    </>
  )
}
