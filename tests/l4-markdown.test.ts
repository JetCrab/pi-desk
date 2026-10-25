import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StreamdownProps } from 'streamdown'
import {
  L4_MARKDOWN_ALLOWED_TAGS,
  remarkL4Markdown
} from '../src/client/l4_foundation/ui/markdown/l4-markdown-remark'

let Streamdown: (typeof import('streamdown'))['Streamdown']
let cjk: (typeof import('@streamdown/cjk'))['cjk']
let remarkPlugins: StreamdownProps['remarkPlugins']
test.before(async () => {
  const streamdown = await import('streamdown')
  Streamdown = streamdown.Streamdown
  cjk = (await import('@streamdown/cjk')).cjk
  remarkPlugins = [...Object.values(streamdown.defaultRemarkPlugins), remarkL4Markdown]
})

function render(content: string, mode: 'static' | 'streaming'): string {
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode,
        parseIncompleteMarkdown: mode === 'streaming',
        controls: false,
        plugins: { cjk },
        remarkPlugins,
        allowedTags: L4_MARKDOWN_ALLOWED_TAGS
      },
      content
    )
  )
}

for (const mode of ['static', 'streaming'] as const) {
  test(`${mode}：表格及列表的三种状态保持只读`, () => {
    const html = render(
      '| 状态 | 事项 |\n| --- | --- |\n| [ ] | 待执行 |\n| [x] | 完成 |\n| [X] | 大写完成 |\n| [-] | 执行中 |\n\n- [ ] 标准未完成\n- [x] 标准完成\n- [-] 当前步骤\n  - [-] 嵌套步骤',
      mode
    )
    assert.equal((html.match(/type="checkbox"/g) ?? []).length, 8)
    assert.equal((html.match(/disabled=""/g) ?? []).length, 8)
    assert.equal((html.match(/checked=""/g) ?? []).length, 3)
    assert.equal((html.match(/data-pi-markdown-progress/g) ?? []).length, 3)
    assert.match(html, /嵌套步骤/)
  })

  test(`${mode}：代码、转义、链接和普通文字不转成状态`, () => {
    const html = render(
      '[ ] 普通段落\n\n- \\[-] 转义列表\n- [-]不是状态前缀\n\n| 内容 |\n| --- |\n| `[x]` |\n| \\[x] |\n| [x\\] |\n| [x](https://example.com) |\n| [ ] 带说明 |\n\n```text\n- [-] 代码\n> [!NOTE]\n```',
      mode
    )
    assert.doesNotMatch(html, /type="checkbox"|data-pi-markdown-progress|data-pi-markdown-alert/)
    assert.match(html, /普通段落/)
    assert.match(html, /带说明/)
    assert.match(html, /data-streamdown="inline-code"[^>]*>\[x\]/)
  })

  test(`${mode}：五种提示块保留正文及嵌套 Markdown`, () => {
    for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      const html = render(
        `> [!${kind}]\n> **重点**和正文\n>\n> - 一项\n> - 二项\n>\n> \\[-] 原文`,
        mode
      )
      assert.match(html, new RegExp(`data-pi-markdown-alert="${kind.toLowerCase()}"`))
      assert.doesNotMatch(html, new RegExp(`\\[!${kind}\\]`))
      assert.match(html, /data-streamdown="strong"[^>]*>重点/)
      assert.match(html, /一项/)
      assert.match(html, /二项/)
      assert.match(html, /\[-\] 原文/)
    }
  })

  test(`${mode}：提示块首行支持空正文和硬换行`, () => {
    for (const content of ['> [!NOTE]', '> [!NOTE]  \n> 内容', '> [!NOTE]\n>\n> 内容']) {
      assert.match(render(content, mode), /data-pi-markdown-alert="note"/)
    }
  })

  test(`${mode}：普通引用、未知及未完成标记保持原意`, () => {
    for (const content of [
      '> 普通引用',
      '> [!UNKNOWN]\n> 内容',
      '> 在正文提到 [!NOTE]',
      '> \\[!NOTE]\n> 转义内容',
      '> [!NOTE] 同行文字',
      '> [!NOTE]**同行强调**',
      '> [!NOT',
      '> [!NOTE',
      '> `[!NOTE]`\n> 代码'
    ]) {
      assert.doesNotMatch(render(content, mode), /data-pi-markdown-alert/)
    }
    assert.match(render('> 普通引用', mode), /普通引用/)
    assert.match(render('> [!NOTE] 同行文字', mode), /同行文字/)
  })
}

test('流式内容逐步补全后才转换完整提示块', () => {
  const contents = [
    '> [!',
    '> [!NOT',
    '> [!NOTE]',
    '> [!NOTE]\n> 正文',
    '> [!NOTE]\n> 正文**加粗**'
  ]
  for (const [index, content] of contents.entries()) {
    const html = render(content, 'streaming')
    assert.equal(html.includes('data-pi-markdown-alert="note"'), index >= 2)
    if (index >= 3) assert.match(html, /正文/)
  }
})
