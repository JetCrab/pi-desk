'use client'

import { useTranslation } from 'react-i18next'
import type { L3ConversationDisplayDetail } from './l3-conversation-display'

type NestedCalls = NonNullable<
  Extract<L3ConversationDisplayDetail, { kind: 'codemode' }>['nestedCalls']
>

export function L3ConversationCodemodeCalls({
  nestedCalls
}: {
  nestedCalls: NestedCalls
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  return (
    <section className="border-t px-3 py-3 text-sm">
      <h4 className="mb-2 font-medium">
        {t(nestedCalls.complete ? 'nestedCalls' : 'nestedCallsIncomplete')}
      </h4>
      <ol className="max-h-[min(24rem,45dvh)] space-y-2 overflow-auto overscroll-contain">
        {nestedCalls.calls.map((call, index) => (
          <li key={index} className="border-b pb-2 last:border-0 last:pb-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 break-words font-mono font-medium">{call.name}</span>
              <span
                className={
                  call.status === 'error'
                    ? 'text-xs text-destructive'
                    : 'text-xs text-muted-foreground'
                }
              >
                {t(`nestedStatus.${call.status}`)}
              </span>
              {call.durationMs === undefined ? null : (
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {call.durationMs} ms
                </span>
              )}
            </div>
            {call.arguments ? (
              <details className="mt-1">
                <summary className="min-h-7 cursor-pointer text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  {t('nestedArguments')}
                </summary>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words py-2 font-mono text-sm">
                  {JSON.stringify(call.arguments, null, 2)}
                </pre>
              </details>
            ) : null}
            {call.argumentsBytes === undefined ? null : (
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                {t('nestedArgumentsBytes', { count: call.argumentsBytes })}
              </p>
            )}
            {call.error ? (
              <p className="mt-1 whitespace-pre-wrap break-words text-destructive">{call.error}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  )
}
