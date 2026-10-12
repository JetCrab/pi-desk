import { Fragment, type ReactElement } from 'react'
import { QuotaGuideConfig, QuotaGuideEffect, QuotaGuidePrinciple } from './l2-quota-guide-figures'
import { QuotaGuideDemo } from './l2-quota-guide-media'

const visuals: Record<string, () => ReactElement> = {
  effect: QuotaGuideEffect,
  principle: QuotaGuidePrinciple,
  demo: QuotaGuideDemo,
  config: QuotaGuideConfig
}

export function QuotaGuide({ html }: { html: string }): ReactElement {
  const parts = html.split(/&lt;!-- quota-(effect|principle|demo|config) --&gt;\s*/)
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
