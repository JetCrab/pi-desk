'use client'

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2NativeUiState } from './l2-native-ui-biz'

function linkedText(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const pattern = /https?:\/\/[^\s<>"']+/g
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index
    const url = match[0].replace(/[)\]。,.;]+$/, '')
    parts.push(text.slice(offset, start))
    parts.push(
      <a
        key={start}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 wrap-anywhere"
      >
        {url}
      </a>
    )
    offset = start + url.length
  }
  parts.push(text.slice(offset))
  return parts
}

export function L2NativeUiNotices({
  notices
}: {
  notices: L2NativeUiState['notices']
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return (
    <section
      aria-label={t('nativeCommandOutput', { defaultValue: '会话命令输出' })}
      className="space-y-3"
    >
      {notices.length ? (
        notices.map((notice, index) => (
          <p
            key={index}
            className={`whitespace-pre-wrap wrap-anywhere font-mono text-sm leading-[1.6] ${notice.level === 'error' ? 'text-destructive' : notice.level === 'warning' ? 'text-amber-700 dark:text-amber-300' : ''}`}
          >
            {linkedText(notice.message)}
          </p>
        ))
      ) : (
        <p className="py-6 text-sm text-muted-foreground">
          {t('nativeCommandOutputEmpty', { defaultValue: '暂无会话命令输出' })}
        </p>
      )}
    </section>
  )
}
