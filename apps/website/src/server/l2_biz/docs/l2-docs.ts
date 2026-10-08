import 'server-only'

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Marked, Renderer } from 'marked'
import type { DocumentContent, DocumentPath } from '@common/l2_biz/docs/l2-docs'
import type { SiteRelease } from '@common/l3_modules/site/l3-site-release'
import { createHeadingIdGenerator } from '@server/l4_foundation/l4-markdown'
import { createQrCodeDataUrl } from '@server/l4_foundation/l4-qr-code'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

async function createClientDownloadsMarkdown(release: SiteRelease): Promise<string> {
  const clients = [
    { label: 'Windows x64', url: release.desktop?.url },
    { label: 'macOS', url: null },
    { label: 'Linux', url: null },
    { label: 'Android', url: release.androidUrl },
    { label: 'iOS', url: null }
  ]
  const table = [
    '| 客户端 | 下载 |',
    '| --- | --- |',
    ...clients.map(({ label, url }) => `| ${label} | ${url ? `[下载](<${url}>)` : '待上线'} |`)
  ].join('\n')
  if (!release.androidUrl) return table

  const qrCode = await createQrCodeDataUrl(release.androidUrl)
  return `${table}\n\nAndroid 扫码下载：\n\n[![扫码下载 Android 版](${qrCode})](<${release.androidUrl}>)`
}

export async function getDocumentContent(
  documentPath: DocumentPath,
  release?: SiteRelease
): Promise<DocumentContent> {
  const slug = documentPath === '/docs/' ? 'overview' : documentPath.slice(6, -1)
  let markdown = await readFile(path.join(process.cwd(), 'content/docs', `${slug}.md`), 'utf8')
  if (documentPath === '/docs/installation/' && release) {
    markdown = markdown.replace(
      '<!-- client-downloads -->',
      await createClientDownloadsMarkdown(release)
    )
  }
  const headings: DocumentContent['headings'] = []
  const headingId = createHeadingIdGenerator()
  const parser = new Marked({
    renderer: {
      heading({ tokens, depth, text }): string {
        const id = headingId(text)
        if (depth === 2) headings.push({ id, title: text })
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`
      },
      image(token): string {
        if (token.href.startsWith('placeholder:')) return ''
        if (!token.href.startsWith('/images/docs/')) {
          return Renderer.prototype.image.call(this, token)
        }
        const href = escapeHtml(token.href)
        const label = escapeHtml(token.text)
        return `<a class="doc-screenshot" href="${href}" target="_blank" rel="noopener noreferrer" aria-label="打开原图：${label}"><img src="${href}" alt="${label}" loading="lazy" decoding="async" /></a>`
      },
      table(token): string {
        return `<div class="doc-table" tabindex="0" role="region" aria-label="内容表格">${Renderer.prototype.table.call(this, token)}</div>`
      },
      html({ text }): string {
        return escapeHtml(text)
      }
    }
  })
  return { html: parser.parse(markdown, { async: false }), headings }
}
