import { Fragment, type ReactElement } from 'react'
import { SubagentsConfig, SubagentsEffect, SubagentsPrinciple } from './l2-subagents-figures'
import { SubagentsUsage } from './l2-subagents-media'

const visuals: Record<string, () => ReactElement> = {
  effect: SubagentsEffect,
  principle: SubagentsPrinciple,
  usage: SubagentsUsage,
  config: SubagentsConfig
}

export function SubagentsGuide({ html }: { html: string }): ReactElement {
  const parts = html.split(/&lt;!-- subagents-(effect|principle|usage|config) --&gt;\s*/)
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
