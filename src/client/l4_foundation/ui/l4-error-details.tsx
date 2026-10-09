'use client'

import { ChevronDownIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './shadcn/collapsible'

export function L4ErrorDetails({
  error,
  children
}: {
  error: Error
  children?: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const reason = error.message.trim().split(/\r?\n/)[0] || t('unknownError')

  return (
    <div className="mt-1 min-w-0">
      <p className="line-clamp-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
        {reason}
      </p>
      <Collapsible defaultOpen={false}>
        <CollapsibleTrigger className="group mt-1 inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180 motion-reduce:transition-none"
          />
          {t('errorDetails')}
        </CollapsibleTrigger>
        <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height,opacity] duration-200 ease-out data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-none">
          <div className="space-y-3 pt-2">
            <pre className="max-h-[min(20rem,45dvh)] overflow-auto rounded-md bg-background p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {error.stack || error.message}
            </pre>
            {children}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
