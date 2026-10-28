import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluate } from '../l4-browser-cdp-runtime.mjs'

export async function prepareProjectPreviewRefresh(project) {
  await mkdir(join(project, 'nested/deep'), { recursive: true })
  await writeFile(join(project, '.gitignore'), 'nested/\n')
  await writeFile(join(project, 'nested/deep/first.ts'), 'export const first = 1\n')
  const nested = join(project, 'nested')
  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
    [
      '-c',
      'user.name=Preview Test',
      '-c',
      'user.email=preview@example.test',
      'commit',
      '--quiet',
      '-m',
      '子仓库初始提交'
    ]
  ])
    execFileSync('git', ['-C', nested, ...args], { windowsHide: true })
  await mkdir(join(project, 'src'), { recursive: true })
  await writeFile(join(project, 'src/a.ts'), 'export const a = 1\n')
  await writeFile(join(project, 'src/b.ts'), 'export const b = 2\n')
  await writeFile(
    join(project, 'README.md'),
    '# 项目预览示例\n\n' + '保持 Markdown 阅读位置。\n\n'.repeat(100)
  )
}

export async function verifyProjectPreviewRefresh({
  page,
  project,
  wait,
  click,
  settled,
  newPage,
  assertIndependent,
  progress,
  capture
}) {
  const code = '[data-testid="code-preview"]'
  const textIncludes = (text) =>
    `document.querySelector(${JSON.stringify(code)})?.textContent.includes(${JSON.stringify(text)})`
  const count = () => evaluate(page, 'window.__previewRequests.length')
  // 固定观测窗口仅用于证明静置不产生业务请求，不用于等待加载完成。
  const quiet = async (label) => {
    await settled()
    const before = await count()
    const after = await evaluate(
      page,
      'new Promise(resolve => setTimeout(() => resolve(window.__previewRequests.length), 1200))'
    )
    assert.equal(after, before, label)
  }
  const focus = () =>
    evaluate(
      page,
      `window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))`
    )

  await page.send('Page.bringToFront')
  await click('[data-testid="project-file-hello.ts"]')
  await wait(textIncludes('preview-original'), '初始文件内容')
  await quiet('持续停留不轮询')
  const other = await newPage()
  await other.send('Page.bringToFront')
  await wait('document.visibilityState === "hidden"', '原标签页隐藏')
  await writeFile(join(project, 'hello.ts'), 'export const greeting = "focus-updated"\n')
  await writeFile(join(project, 'added.ts'), 'export const added = true\n')
  await focus()
  await quiet('隐藏页面不发起自动刷新')
  assert.equal(await evaluate(page, textIncludes('preview-original')), true)
  const before = await count()
  await page.send('Page.bringToFront')
  await wait(textIncludes('focus-updated'), '切回真实浏览器标签刷新文件')
  await wait(
    'Boolean(document.querySelector(\'[data-testid="project-file-added.ts"]\'))',
    '新增文件进入目录树'
  )
  await wait(
    'document.querySelector("[data-testid=project-git-changes-toggle]")?.textContent.trim().endsWith("2")',
    'Git变更计数更新'
  )
  await settled()
  const requests = await evaluate(page, `window.__previewRequests.slice(${before})`)
  assert.equal(requests.filter((item) => item.url === '/api/project-git/get').length, 1)
  assert.equal(requests.filter((item) => item.url === '/api/project-files/get').length, 1)
  await quiet('聚焦后的读取完成即停止')
  await progress('真实标签切回更新正文、目录和Git计数；隐藏不读取，激活请求合并，无轮询')

  await click('[data-testid="project-file-README.md"]')
  await wait('Boolean(document.querySelector("[data-testid=markdown-preview]"))', 'Markdown预览')
  await settled()
  await evaluate(
    page,
    `window.__previewMarkdown=document.querySelector('[data-testid=markdown-preview]');window.__previewMarkdown.scrollTop=280;window.__previewMarkdown.dispatchEvent(new Event('scroll'))`
  )
  const scroll = await evaluate(page, 'window.__previewMarkdown.scrollTop')
  assert.ok(scroll > 0, 'Markdown存在真实滚动空间')
  const unchangedBefore = await count()
  await focus()
  await wait(`window.__previewRequests.length > ${unchangedBefore}`, '聚焦触发重读')
  await settled()
  assert.equal(
    await evaluate(
      page,
      'window.__previewMarkdown===document.querySelector("[data-testid=markdown-preview]")'
    ),
    true
  )
  assert.equal(await evaluate(page, 'window.__previewMarkdown.scrollTop'), scroll)
  await writeFile(join(project, 'hello.ts'), 'export const greeting = "tab-updated"\n')
  await click('[data-testid="file-tab-hello.ts"] [role="tab"]')
  await wait(textIncludes('tab-updated'), '切换已有标签读取最新内容')

  await click('[data-testid="project-folder-src"] button[aria-expanded="false"]')
  await wait(
    'Boolean(document.querySelector(\'[data-testid="project-file-src/a.ts"]\'))',
    '展开目录'
  )
  await click('[data-testid="project-folder-src"] button[aria-expanded="true"]')
  await writeFile(join(project, 'src/new.ts'), 'export const fresh = true\n')
  await click('[data-testid="project-folder-src"] button[aria-expanded="false"]')
  await wait(
    'Boolean(document.querySelector(\'[data-testid="project-file-src/new.ts"]\'))',
    '重新展开读取新增子项'
  )

  await writeFile(join(project, 'hello.ts'), 'export const greeting = "manual-updated"\n')
  await click('[aria-label="刷新项目预览"]')
  await wait(textIncludes('manual-updated'), '手动刷新入口保留')
  await progress('未变化Markdown保留实例和滚动；文件标签、目录重新展开、手动刷新通过')

  await click('[data-testid="project-git-changes-toggle"]')
  await click('[data-testid="project-file-hello.ts"]')
  await wait('Boolean(document.querySelector("[data-testid=code-diff]"))', '工作区Diff')
  await settled()
  await writeFile(join(project, 'hello.ts'), 'export const greeting = "diff-updated"\n')
  await focus()
  await wait(
    'document.querySelector("[data-testid=code-diff]")?.textContent.includes("diff-updated")',
    '聚焦更新当前工作区Diff'
  )
  await settled()
  await assertIndependent()
  await capture('focus-refresh.png')
  await progress('工作区Diff聚焦更新；独立页仍不创建应用WebSocket或工作会话')

  await click('[data-testid="project-git-changes-toggle"]')
  await click('[data-testid="project-file-layout-repository"]')
  await click('[data-testid="project-git-repository-toggle-root"]')
  await click('[data-testid="project-git-repository-toggle-nested"]')
  await click('[data-testid="project-folder-nested/deep"] button[aria-expanded="false"]')
  await wait(
    'Boolean(document.querySelector(\'[data-testid="project-file-nested/deep/first.ts"]\'))',
    '子仓库展开目录就绪'
  )
  await settled()
  await writeFile(join(project, 'nested/deep/latest.ts'), 'export const latest = true\n')
  await focus()
  await wait(
    'Boolean(document.querySelector(\'[data-testid="project-file-nested/deep/latest.ts"]\'))',
    '聚焦刷新最内层仓库展开目录'
  )
  await settled()
  await assertIndependent()
  await progress('两层Git：父仓库忽略子仓库，根和子仓库同时展开时刷新子目录通过')
}
