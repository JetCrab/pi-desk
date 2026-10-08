import 'server-only'

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { Marked } from 'marked'
import { createHeadingIdGenerator } from '@server/l4_foundation/l4-markdown'

function renderMarkdown(markdown: string): string {
  const headingId = createHeadingIdGenerator()
  const parser = new Marked({
    renderer: {
      heading({ tokens, depth, text }): string {
        const id = headingId(text)
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`
      },
      html({ text }): string {
        return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      }
    }
  })
  return parser.parse(markdown, { async: false })
}

export async function getChangelog(): Promise<{ slug: string; date: number; html: string }[]> {
  const directory = path.join(process.cwd(), 'content/changelog')
  const files = (await readdir(directory))
    .filter((file) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(file))
    .sort()
    .reverse()
  return Promise.all(
    files.map(async (file) => ({
      slug: file.replace(/\.md$/, ''),
      date: Date.parse(`${file.slice(0, 10)}T00:00:00+08:00`),
      html: renderMarkdown(await readFile(path.join(directory, file), 'utf8'))
    }))
  )
}
