import { Fragment, type ReactElement } from 'react'
import { RemoteDebugGuideConfig, RemoteDebugGuideEffect } from './l2-remote-debug-guide-figures'
import { RemoteDebugGuideDemo } from './l2-remote-debug-guide-media'

const visuals: Record<string, () => ReactElement> = {
  effect: RemoteDebugGuideEffect,
  config: RemoteDebugGuideConfig,
  demo: RemoteDebugGuideDemo
}

export function RemoteDebugGuide({ html }: { html: string }): ReactElement {
  const parts = html.split(/&lt;!-- remote-debug-(effect|config|demo) --&gt;\s*/)
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
