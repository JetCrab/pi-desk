import 'server-only'

import hljs from 'highlight.js/lib/common'
import type { Tokens } from 'marked'

function escapeCode(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function renderCodeBlock({ text, lang }: Tokens.Code): string {
  const language = lang?.trim().split(/\s+/)[0].toLowerCase() || ''
  const label = escapeCode(language || '纯文本')
  const highlighted = language && hljs.getLanguage(language)
  const code = highlighted
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : escapeCode(text)

  return `<div class="markdown-code-block" role="group" aria-label="${label}代码块"><div class="markdown-code-header"><span>${label}</span><button type="button" data-code-copy hidden aria-label="复制代码">复制</button><span class="markdown-code-status" role="status"></span></div><pre tabindex="0" role="region" aria-label="${label}代码"><code${highlighted ? ' class="hljs"' : ''}>${code}</code></pre></div>\n`
}

export function createHeadingIdGenerator(): (text: string) => string {
  const ids = new Map<string, number>()
  return (text: string): string => {
    const base =
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-') || 'section'
    const count = ids.get(base) ?? 0
    ids.set(base, count + 1)
    return count ? `${base}-${count}` : base
  }
}
