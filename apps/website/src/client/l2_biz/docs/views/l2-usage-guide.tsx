import { Fragment, type ReactElement } from 'react'
import { UsageGuideConfig, UsageGuideEffect, UsageGuidePrinciple } from './l2-usage-guide-figures'
import { UsageGuideDemo } from './l2-usage-guide-media'

const visuals: Record<string, () => ReactElement> = {
  effect: UsageGuideEffect,
  principle: UsageGuidePrinciple,
  demo: UsageGuideDemo,
  config: UsageGuideConfig
}

export function UsageGuide({ html }: { html: string }): ReactElement {
  const parts = html.split(/&lt;!-- usage-(effect|principle|demo|config) --&gt;\s*/)
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
