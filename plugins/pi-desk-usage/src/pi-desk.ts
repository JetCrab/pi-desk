import { definePiDeskPlugin } from '@jetcrab/pi-desk-sdk/entry'
import { UsageRuntime } from './usage-runtime.js'

export default definePiDeskPlugin({
  name: 'usage',
  setup(plugin) {
    const runtime = new UsageRuntime({
      workSessions: plugin.host.workSessions,
      settings: plugin.host.settings
    })

    plugin.registerMethod('report-get', (input, context) => runtime.report(input, context.signal))
    plugin.registerMethod('session-list', (input, context) =>
      runtime.sessions(input, context.signal)
    )
    plugin.registerMethod('session-analysis-get', (input, context) =>
      runtime.sessionAnalysis(input, context.signal)
    )
    plugin.registerMethod('session-timeline-get', (input, context) =>
      runtime.sessionTimeline(input, context.signal)
    )
    plugin.registerMethod('session-activity-get', (input, context) =>
      runtime.sessionActivities(input, context.signal)
    )

    plugin.registerBrowserEntry('./dist/browser/entry.js')

    return () => runtime.dispose()
  }
})
