import { Fragment, type ReactElement } from 'react'
import { ContextEffect } from './l2-context-guide-effect'
import { ContextUsageDemo } from './l2-context-guide-media'
import { ContextPrincipleFigure, ContextSettingsFigure } from './l2-context-guide-figures'

const visuals: Record<string, () => ReactElement> = {
  effect: ContextEffect,
  principle: ContextPrincipleFigure,
  usage: ContextUsageDemo,
  settings: ContextSettingsFigure
}

export function ContextGuide({ html }: { html: string }): ReactElement {
  const parts = html.split(/&lt;!-- context-(effect|principle|usage|settings) --&gt;\s*/)
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
