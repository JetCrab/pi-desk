import { Fragment, type ReactElement } from 'react'
import {
  BackgroundTasksConfig,
  BackgroundTasksEffect,
  BackgroundTasksPrinciple
} from './l2-background-tasks-figures'
import { BackgroundTasksUsage } from './l2-background-tasks-media'

const visuals: Record<string, () => ReactElement> = {
  effect: BackgroundTasksEffect,
  principle: BackgroundTasksPrinciple,
  usage: BackgroundTasksUsage,
  config: BackgroundTasksConfig
}

export function BackgroundTasksGuide({ html }: { html: string }): ReactElement {
  const parts = html.split(/&lt;!-- background-tasks-(effect|principle|usage|config) --&gt;\s*/)
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
