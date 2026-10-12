import { Fragment, type ReactElement } from 'react'
import { TiboGuideConfig, TiboGuideEffect, TiboGuidePrinciple } from './l2-tibo-guide-figures'
import { TiboGuideDemo } from './l2-tibo-guide-media'

const visuals: Record<string, () => ReactElement> = {
  effect: TiboGuideEffect,
  principle: TiboGuidePrinciple,
  demo: TiboGuideDemo,
  config: TiboGuideConfig
}

export function TiboGuide({ html }: { html: string }): ReactElement {
  const parts = html.split(/&lt;!-- tibo-(effect|principle|demo|config) --&gt;\s*/)
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
