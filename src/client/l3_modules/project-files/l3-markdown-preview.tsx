'use client'

import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { memo, useLayoutEffect, useRef } from 'react'
import { Streamdown } from 'streamdown'
import {
  L4_MARKDOWN_ALLOWED_TAGS,
  L4_MARKDOWN_CLASS_NAME,
  L4_MARKDOWN_COMPONENTS,
  L4_MARKDOWN_REMARK_PLUGINS
} from '@client/l4_foundation/ui/markdown/l4-markdown'
import styles from './l3-markdown-preview.module.css'

const plugins = { cjk, code }

export const L3MarkdownPreview = memo(function L3MarkdownPreview({
  content,
  label,
  savedScrollTop,
  onScroll
}: {
  content: string
  label: string
  savedScrollTop: number
  onScroll: (scrollTop: number) => void
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const initialScrollTop = useRef(savedScrollTop)

  useLayoutEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = initialScrollTop.current
  }, [])

  return (
    <div
      ref={viewportRef}
      data-testid="markdown-preview"
      role="region"
      aria-label={label}
      tabIndex={0}
      className="h-full min-h-0 overflow-auto overscroll-contain bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
    >
      <Streamdown
        className={`${styles.document} ${L4_MARKDOWN_CLASS_NAME}`}
        allowedTags={L4_MARKDOWN_ALLOWED_TAGS}
        components={L4_MARKDOWN_COMPONENTS}
        remarkPlugins={L4_MARKDOWN_REMARK_PLUGINS}
        mode="static"
        parseIncompleteMarkdown={false}
        isAnimating={false}
        controls={false}
        lineNumbers={false}
        plugins={plugins}
      >
        {content}
      </Streamdown>
    </div>
  )
})
