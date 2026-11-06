import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { renderCodeBlock } from '../src/server/l4_foundation/l4-markdown.ts'

const parser = new Marked({ renderer: { code: renderCodeBlock } })

function codeText(html) {
  return html
    .match(/<code[^>]*>([\s\S]*?)<\/code>/)[1]
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => {
      return { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity]
    })
}

test('高亮保留缩进、制表符、空行、末尾换行及 HTML 字符', () => {
  const text = 'const value = "<tag> & 中文"\n\tconsole.log(value)  \n\n'
  const html = renderCodeBlock({ type: 'code', raw: text, lang: 'TS file.ts', text })
  assert.match(html, /class="hljs-keyword"/)
  assert.match(html, /<span>ts<\/span>/)
  assert.equal(codeText(html), text)
  assert.match(html, /tabindex="0" role="region" aria-label="ts代码"/)
  assert.match(html, /data-code-copy hidden aria-label="复制代码"/)
})

test('官网使用的 Bash、YAML 及语言别名均能显式高亮', () => {
  for (const [language, text] of [
    ['bash', 'export PORT=3000\necho "$PORT"'],
    ['yaml', 'services:\n  web:\n    image: "example"'],
    ['js', 'const active = true'],
    ['json', '{"active": true}']
  ]) {
    const html = parser.parse(`\`\`\`${language}\n${text}\n\`\`\``)
    assert.match(html, /class="hljs-/)
    assert.equal(codeText(html), text)
  }
})

test('未知语言、纯文本与未标注代码不猜测语言且安全回退', () => {
  const text = '  <script>alert("x")</script> & &#39;\n\t原始文本'
  for (const language of ['unknown-language', 'text', '']) {
    const html = parser.parse(`\`\`\`${language}\n${text}\n\`\`\``)
    assert.doesNotMatch(html, /<script>|class="hljs-/)
    assert.equal(codeText(html), text)
  }
})

test('语言标签不可注入 HTML 或属性', () => {
  const html = parser.parse('```"><img/src=x/onerror=alert(1)>\nvalue\n```')
  assert.doesNotMatch(html, /<img|aria-label=""><|<script/)
  assert.match(html, /&lt;img/)
  assert.equal(codeText(html), 'value')
})

test('只增强块级代码，不改变行内代码与缩进代码内容', () => {
  const inline = parser.parse('使用 `const value = 1`。')
  assert.doesNotMatch(inline, /markdown-code-block|data-code-copy/)
  assert.match(inline, /<code>const value = 1<\/code>/)
  const indented = parser.parse('    first\n      second\n')
  assert.equal(codeText(indented), 'first\n  second\n')
  assert.match(indented, /<span>纯文本<\/span>/)
})
