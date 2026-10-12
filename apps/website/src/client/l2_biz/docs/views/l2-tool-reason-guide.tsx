import { Fragment, type ReactElement } from 'react'
import {
  ToolReasonGuideConfig,
  ToolReasonGuideEffect,
  ToolReasonGuidePrinciple
} from './l2-tool-reason-guide-figures'
import { ToolReasonGuideDemo } from './l2-tool-reason-guide-media'

const visuals: Record<string, () => ReactElement> = {
  effect: ToolReasonGuideEffect,
  principle: ToolReasonGuidePrinciple,
  demo: ToolReasonGuideDemo,
  config: ToolReasonGuideConfig
}

export function ToolReasonGuide({ html }: { html: string }): ReactElement {
  const parts = html.split(/&lt;!-- tool-reason-(effect|principle|demo|config) --&gt;\s*/)
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) return <div key={index} dangerouslySetInnerHTML={{ __html: part }} />
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
