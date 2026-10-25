'use client'

import {
  CheckIcon,
  InfoIcon,
  LightbulbIcon,
  MessageSquareWarningIcon,
  MinusIcon,
  OctagonAlertIcon,
  TriangleAlertIcon
} from 'lucide-react'
import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { defaultRemarkPlugins, type Components, type StreamdownProps } from 'streamdown'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { remarkL4Markdown } from './l4-markdown-remark'
import styles from './l4-markdown.module.css'

export { L4_MARKDOWN_ALLOWED_TAGS } from './l4-markdown-remark'

export const L4_MARKDOWN_REMARK_PLUGINS: NonNullable<StreamdownProps['remarkPlugins']> = [
  ...Object.values(defaultRemarkPlugins),
  remarkL4Markdown
]
export const L4_MARKDOWN_CLASS_NAME = styles.markdown

const alerts = {
  note: { icon: InfoIcon, label: 'markdownNote' },
  tip: { icon: LightbulbIcon, label: 'markdownTip' },
  important: { icon: MessageSquareWarningIcon, label: 'markdownImportant' },
  warning: { icon: TriangleAlertIcon, label: 'markdownWarning' },
  caution: { icon: OctagonAlertIcon, label: 'markdownCaution' }
} as const

function MarkdownStatus({
  'data-pi-markdown-progress': progress,
  ...props
}: ComponentProps<'input'> & {
  node?: unknown
  'data-pi-markdown-progress'?: string
}): React.JSX.Element {
  const { t } = useTranslation('common')
  delete props.node
  if (props.type !== 'checkbox') return <input {...props} />
  const state = progress ? 'progress' : props.checked ? 'completed' : 'pending'
  const marker = progress ? '[-]' : props.checked ? '[x]' : '[ ]'
  const label = t(
    progress ? 'markdownProgress' : props.checked ? 'markdownCompleted' : 'markdownPending'
  )

  return (
    <span className={styles.status} data-state={state} role="img" aria-label={label} title={label}>
      {progress ? (
        <MinusIcon aria-hidden="true" />
      ) : props.checked ? (
        <CheckIcon aria-hidden="true" />
      ) : null}
      <span className="sr-only" aria-hidden="true">
        {marker}
      </span>
    </span>
  )
}

function MarkdownBlockquote({
  'data-pi-markdown-alert': kind,
  className,
  children,
  ...props
}: ComponentProps<'blockquote'> & {
  node?: unknown
  'data-pi-markdown-alert'?: string
}): React.JSX.Element {
  const { t } = useTranslation('common')
  delete props.node
  const alert = Object.entries(alerts).find(([name]) => name === kind)?.[1]

  if (!alert) {
    return (
      <blockquote
        {...props}
        data-streamdown="blockquote"
        className={cn(
          'my-4 border-muted-foreground/30 border-l-4 pl-4 text-muted-foreground italic',
          className
        )}
      >
        {children}
      </blockquote>
    )
  }

  const Icon = alert.icon
  return (
    <aside className={styles.alert} role="note" aria-label={t(alert.label)}>
      <div className={styles.alertTitle}>
        <Icon aria-hidden="true" />
        {t(alert.label)}
      </div>
      <div className={styles.alertBody}>{children}</div>
    </aside>
  )
}

export const L4_MARKDOWN_COMPONENTS: Components = {
  input: MarkdownStatus,
  blockquote: MarkdownBlockquote
}
