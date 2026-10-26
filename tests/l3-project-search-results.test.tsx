import assert from 'node:assert/strict'
import test from 'node:test'
import React, { Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import type { L4ProjectFileSearch } from '../src/common/l4_foundation/file/l4-project-file-contract'
import { L3_PROJECT_FILES_LOCALE_MESSAGES } from '../src/common/l3_modules/project-files/l3-project-files-locale-messages'
import { L3ProjectSearchResults } from '../src/client/l3_modules/project-files/views/l3-project-search-results'

// 独立 tsx 执行沿用 jsx:preserve，SSR 夹具为源码组件提供 classic JSX 运行时。
const previousReact = Object.getOwnPropertyDescriptor(globalThis, 'React')
test.before(() => {
  Object.defineProperty(globalThis, 'React', { value: React, configurable: true })
})
test.after(() => {
  if (previousReact) Object.defineProperty(globalThis, 'React', previousReact)
  else Reflect.deleteProperty(globalThis, 'React')
})

async function render(result: L4ProjectFileSearch): Promise<string> {
  const i18n = createInstance()
  await i18n.init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { projectFiles: L3_PROJECT_FILES_LOCALE_MESSAGES['zh-CN'] } },
    interpolation: { escapeValue: false }
  })
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <L3ProjectSearchResults
        search={{
          query: 'needle',
          scope: 'all',
          caseSensitive: false,
          wholeWord: false,
          regex: false,
          status: 'ready',
          error: null,
          ...result
        }}
        resultsRef={null}
        activePath={null}
        onOpen={() => undefined}
        wrapFile={(path, line, trigger) => <Fragment key={`${path}:${line}`}>{trigger}</Fragment>}
        renderFileIcon={() => null}
        fileDecoration={() => ({})}
      />
    </I18nextProvider>
  )
}
const contents = [
  { path: 'a.ts', line: 1, text: 'needle', ranges: [{ start: 0, end: 6 }] },
  { path: 'a.ts', line: 2, text: 'needle', ranges: [{ start: 0, end: 6 }] },
  { path: 'b.ts', line: 1, text: 'needle', ranges: [{ start: 0, end: 6 }] }
]

test('只有正文命中也应统计涉及的文件，而不是显示零个文件', async () => {
  const html = await render({ fileMatches: [], contentMatches: contents, truncated: false })
  assert.match(html, /2 个文件 · 3 个命中行/)
  assert.doesNotMatch(html, /0 个文件 · 3 个命中行/)
})

test('文件名与正文命中同一路径时统计去重，不重复累计文件', async () => {
  const html = await render({
    fileMatches: [{ path: 'a.ts', ranges: [] }],
    contentMatches: contents,
    truncated: false
  })
  assert.match(html, /2 个文件 · 3 个命中行/)
})

test('零项且截断时提示结果不完整，而不是没有匹配', async () => {
  const html = await render({ fileMatches: [], contentMatches: [], truncated: true })
  assert.ok(html.includes(L3_PROJECT_FILES_LOCALE_MESSAGES['zh-CN'].resultLimit))
  assert.doesNotMatch(html, /没有匹配结果/)
})

test('截断结果的文件与行数仅标为已显示数量', async () => {
  const html = await render({
    fileMatches: [{ path: 'a.ts', ranges: [] }],
    contentMatches: contents,
    truncated: true
  })
  assert.match(html, /已显示：2 个文件 · 3 个命中行/)
})
