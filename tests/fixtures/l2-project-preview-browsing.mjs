import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluate, navigate, setViewport } from '../l4-browser-cdp-runtime.mjs'

export async function prepareProjectPreviewBrowsing(project) {
  const git = (args, input) =>
    execFileSync('git', ['-C', project, ...args], {
      input,
      encoding: 'utf8',
      windowsHide: true
    }).trim()
  git(['branch', '-M', 'main'])
  const original = git(['rev-parse', 'HEAD'])
  const data = (text) => `data ${Buffer.byteLength(text)}\n${text}\n`
  let stream = ''
  for (let index = 1; index <= 65; index += 1) {
    stream += `commit refs/heads/main\nmark :${index}\ncommitter Preview Test <preview@example.test> ${1793059200 + index * 60} +0000\n`
    stream += data(`Preview commit ${index} · project browsing`)
    stream += `from ${index === 1 ? original : `:${index - 1}`}\n`
    stream += 'M 100644 inline hello.ts\n' + data(`export const greeting = "history-${index}"\n`)
    stream += 'M 100644 inline preview.ts\n' + data(`export const preview = "preview-${index}"\n`)
    if (index === 65) {
      for (let directory = 1; directory <= 24; directory += 1) {
        for (const file of ['model.ts', 'view.ts']) {
          stream += `M 100644 inline src/module-${String(directory).padStart(2, '0')}/${file}\n`
          stream += data(`export const value = ${directory}\n`)
        }
      }
    }
    stream += '\n'
  }
  git(['fast-import', '--quiet'], stream)
  git(['reset', '--hard', 'main'])
  const branch = 'feature/lwh/20261027-preview-tree-search-with-a-long-readable-branch-name'
  git(['branch', branch])
  git(['branch', 'fix/render'])
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  git(['update-ref', `refs/remotes/origin/${branch}`, 'HEAD~1'])
  await writeFile(join(project, 'hello.ts'), 'export const greeting = "working-preview"\n')
  await writeFile(join(project, 'preview.ts'), 'export const preview = "working-second"\n')
  return { branch, latest: git(['rev-parse', 'HEAD']), previous: git(['rev-parse', 'HEAD~1']) }
}

export async function verifyProjectPreviewBrowsing({
  page,
  project,
  port,
  fixture,
  wait,
  click,
  textButton,
  input,
  settled,
  capture,
  progress
}) {
  const logSelector = '[role="listbox"][aria-label="Git 提交列表"]'
  const treeSelector = '[role="tree"][aria-label="提交变更文件"]'
  const diffTabs = '[data-file-tab][data-testid^="file-diff-tab-"]'
  const press = async (key, code) => {
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      windowsVirtualKeyCode: code,
      ...(key === 'Enter' ? { text: '\r' } : {})
    })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code })
  }
  const scroll = async (selector, bottom) => {
    await evaluate(
      page,
      `(() => {const el=document.querySelector(${JSON.stringify(selector)});el.scrollTop=${bottom ? 'el.scrollHeight' : '0'};el.dispatchEvent(new Event('scroll',{bubbles:true}));})()`
    )
  }
  const openChange = async (path) => {
    await scroll(treeSelector, true)
    await click(`${treeSelector} [aria-label="查看差异 ${path}"]`)
    await wait('Boolean(document.querySelector("[data-testid=code-diff]"))', `Diff ${path}`)
    await settled()
  }
  const selectCommit = async (index) => {
    await scroll(logSelector, false)
    await click(`${logSelector} [role="option"][title^="Preview commit ${index} ·"]`)
    await settled()
  }
  const tabCount = () =>
    evaluate(page, `document.querySelectorAll(${JSON.stringify(diffTabs)}).length`)
  const activateDiff = async (path, oid) => {
    const expression = `[...document.querySelectorAll(${JSON.stringify(diffTabs)})].find(el=>el.title.includes(${JSON.stringify(path)})&&el.title.split('\\n').at(-1).endsWith(${JSON.stringify(` → ${oid}`)}))`
    await wait(`Boolean(${expression})`, `标签 ${path} ${oid}`)
    await evaluate(page, `${expression}.querySelector('[role="tab"]').click()`)
    await wait(
      `${expression}?.querySelector('[role="tab"]')?.getAttribute('aria-selected')==='true'`,
      `目标Diff已选中 ${path} ${oid}`
    )
    await settled()
  }

  await setViewport(page, 1600, 1000, false)
  await click('[data-testid="project-file-hello.ts"]')
  await click('[data-testid="project-file-README.md"]')
  await wait('document.querySelectorAll("[data-file-tab]").length===2', '普通文件多开')
  await textButton('Git 记录')
  await wait(
    `Boolean(document.querySelector(${JSON.stringify(logSelector)}+' [role="option"]'))`,
    '提交列表'
  )
  await settled()
  const treeOnly = process.argv.includes('--tree-only')
  const branchTree = '[role="tree"][aria-label="查看分支"]'
  if (!treeOnly) {
    assert.equal(await evaluate(page, 'document.body.innerText.includes("加载更多提交")'), false)
    await scroll(logSelector, true)
    const scrolledTop = await evaluate(
      page,
      `document.querySelector(${JSON.stringify(logSelector)}).scrollTop`
    )
    await wait(
      'window.__previewRequests.some(item=>item.url.includes("project-git-log")&&JSON.parse(item.body).page.index===2&&item.status===200)',
      '接近底部自动分页'
    )
    await settled()
    assert.equal(
      await evaluate(page, `document.querySelector(${JSON.stringify(logSelector)}).scrollTop`),
      scrolledTop
    )
    await scroll(logSelector, true)
    await wait('document.body.innerText.includes("已加载全部提交")', '提交列表末尾')
    const pages = await evaluate(
      page,
      'window.__previewRequests.filter(item=>item.url.includes("project-git-log")).map(item=>JSON.parse(item.body).page.index)'
    )
    assert.deepEqual(pages, [1, 2])
    await progress('自动分页：滚动追加第二页、位置连续、末尾停止，无加载更多按钮')

    await click('[role="combobox"][aria-label="查看分支"]')
    await click(`${branchTree} [aria-label="feature"]`)
    await click(`${branchTree} [aria-label="feature/lwh"]`)
    await wait(
      `Boolean(document.querySelector(${JSON.stringify(`${branchTree} [aria-label="${fixture.branch}"]`)}))`,
      '分支树叶子'
    )
    await capture('branches-dark.png')
    await input(
      '[role="dialog"][aria-label="查看分支"] input[type="search"]',
      'preview-tree-search'
    )
    await wait(
      `document.querySelector('[role="dialog"][aria-label="查看分支"] input[type="search"]')?.value==='preview-tree-search' && document.querySelectorAll(${JSON.stringify(`${branchTree} [role="treeitem"][aria-selected]`)}).length===2`,
      '分支搜索结果就绪'
    )
    await press('ArrowDown', 40)
    await wait(
      `document.activeElement?.getAttribute('aria-label')===${JSON.stringify(fixture.branch)}`,
      '键盘焦点进入本地搜索结果'
    )
    await press('Enter', 13)
    await wait(
      `document.querySelector('[role="combobox"][aria-label="查看分支"]')?.textContent.includes(${JSON.stringify(fixture.branch)})`,
      '键盘选择分支'
    )
    await settled()
    assert.equal(
      execFileSync('git', ['-C', project, 'branch', '--show-current'], { encoding: 'utf8' }).trim(),
      'main'
    )
    await textButton('分支比较')
    await click('[role="combobox"][aria-label="基准分支"]')
    await input('[role="dialog"][aria-label="基准分支"] input[type="search"]', 'main')
    await click('[role="tree"][aria-label="基准分支"] [role="treeitem"][aria-label="main"]')
    await click('[role="combobox"][aria-label="目标分支"]')
    await input(
      '[role="dialog"][aria-label="目标分支"] input[type="search"]',
      `origin/${fixture.branch}`
    )
    await click(
      `[role="tree"][aria-label="目标分支"] [role="treeitem"][aria-label="origin/${fixture.branch}"]`
    )
    await settled()
    await textButton('提交记录')
    await click('[role="combobox"][aria-label="查看分支"]')
    await click(`${branchTree} [role="treeitem"][aria-label="当前 HEAD"]`)
    await settled()
    await progress('分支树：层级展开、长名搜索、键盘选择、比较两侧和远程分支通过，工作区分支未改变')
  }

  await scroll(treeSelector, true)
  await wait(
    `Boolean(document.querySelector(${JSON.stringify(`${treeSelector} [data-tree-key="file:hello.ts"]`)}))`,
    '紧凑树末尾'
  )
  const heights = await evaluate(
    page,
    `({file:document.querySelector('[data-testid="project-file-hello.ts"]').getBoundingClientRect().height,change:document.querySelector(${JSON.stringify(`${treeSelector} [data-tree-key="file:hello.ts"]`)}).getBoundingClientRect().height})`
  )
  assert.equal(heights.file, 24)
  assert.equal(heights.change, heights.file)
  await evaluate(
    page,
    `document.querySelector(${JSON.stringify(`${treeSelector} [data-tree-key="file:hello.ts"]`)}).focus()`
  )
  await wait(
    'document.activeElement?.getAttribute("data-tree-key")==="file:hello.ts"',
    '按键前焦点为hello.ts'
  )
  await press('Home', 36)
  await wait(
    'document.activeElement?.getAttribute("data-tree-key")?.startsWith("directory:")',
    '树Home定位'
  )
  await press('ArrowLeft', 37)
  await press('ArrowRight', 39)
  await press('End', 35)
  await wait(
    'document.activeElement?.getAttribute("data-tree-key")==="file:preview.ts"',
    '树End定位'
  )
  if (treeOnly) {
    await progress('树定向：鼠标24px、Home/Left/Right/End通过')
    return
  }
  await openChange('hello.ts')
  await openChange('preview.ts')
  assert.equal(await tabCount(), 2)
  await click('[data-testid="file-tab-hello.ts"] [role="tab"]')
  assert.equal(await tabCount(), 2)
  await activateDiff('hello.ts', fixture.latest)
  await selectCommit(64)
  assert.equal(await tabCount(), 2)
  await openChange('hello.ts')
  assert.equal(await tabCount(), 3)
  await activateDiff('hello.ts', fixture.latest)
  await wait(
    'document.querySelector("[data-testid=code-diff]")?.textContent.includes("history-65")',
    '历史65模型内容就绪'
  )
  assert.ok(
    await evaluate(
      page,
      'document.querySelector("[data-testid=code-diff]")?.textContent.includes("history-65")'
    )
  )
  await activateDiff('hello.ts', fixture.previous)
  await wait(
    'document.querySelector("[data-testid=code-diff]")?.textContent.includes("history-64") && !document.querySelector("[data-testid=code-diff]")?.textContent.includes("history-65")',
    '历史64模型内容就绪且不包含历史65'
  )
  assert.equal(
    await evaluate(
      page,
      'document.querySelector("[data-testid=code-diff]")?.textContent.includes("history-65")'
    ),
    false
  )
  assert.ok(
    await evaluate(
      page,
      'document.querySelector("[data-testid=code-diff]")?.textContent.includes("history-64")'
    )
  )
  await capture('preview-tabs-dark.png')
  await evaluate(page, "document.documentElement.classList.remove('dark')")
  await capture('preview-tabs-light.png')
  await page.send('Page.reload')
  await wait(
    `document.querySelectorAll(${JSON.stringify(diffTabs)}).length===3 && Boolean(document.querySelector('[data-testid="code-diff"]'))`,
    '多Diff刷新恢复'
  )
  await settled()
  await activateDiff('preview.ts', fixture.latest)
  await wait(
    'document.querySelector("[data-testid=code-diff]")?.textContent.includes("preview-65")',
    '恢复后的另一Diff按需读取'
  )
  const close = `[...document.querySelectorAll(${JSON.stringify(diffTabs)})].find(el=>el.title.includes('preview.ts'))`
  await evaluate(page, `${close}.querySelector('button[aria-label^="关闭"]').click()`)
  assert.equal(await tabCount(), 2)
  await progress(
    '多标签：普通文件与三个历史Diff共存、同文件不同提交内容准确、切换提交不关闭、刷新恢复及独立关闭通过'
  )

  await selectCommit(65)
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await setViewport(page, 390, 844, true)
  await wait('matchMedia("(pointer: coarse)").matches', '触控粗指针模拟已生效')
  await textButton('Git')
  await selectCommit(65)
  await scroll(treeSelector, true)
  await wait(
    `Boolean(document.querySelector(${JSON.stringify(`${treeSelector} [data-tree-key="file:hello.ts"]`)}))`,
    '触控变更树'
  )
  assert.equal(
    await evaluate(
      page,
      `document.querySelector(${JSON.stringify(`${treeSelector} [data-tree-key="file:hello.ts"]`)}).getBoundingClientRect().height`
    ),
    36
  )
  assert.equal(await evaluate(page, 'document.documentElement.scrollWidth<=innerWidth'), true)
  await capture('changes-mobile.png')
  await click('[role="combobox"][aria-label="查看分支"]')
  await input('[role="dialog"][aria-label="查看分支"] input[type="search"]', 'preview-tree-search')
  await capture('branches-mobile.png')
  const rect = await evaluate(
    page,
    '(() => {const r=document.querySelector("[role=dialog][aria-label=查看分支]").getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()'
  )
  assert.ok(rect.left >= 0 && rect.right <= rect.width)
  await press('Escape', 27)
  await progress('紧凑树：鼠标24px、触控36px，Home/End和折叠定位通过；窄屏分支弹层未溢出')

  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await setViewport(page, 1600, 1000, false)
  const created = await evaluate(
    page,
    `fetch('/api/work-sessions/add',{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Desk-Client-Id':'541e6a7e-d27b-45f2-a19b-b7cf9cbf33ac'},body:JSON.stringify({cwd:${JSON.stringify(project)}})}).then(response=>response.json())`
  )
  assert.equal(created.code, 0, JSON.stringify(created))
  await navigate(page, `http://127.0.0.1:${port}/`)
  await click('[data-testid^="work-session-row-"]')
  await click('[data-testid="sidebar-mode-files"]')
  await click('[data-testid="project-file-hello.ts"]')
  await click('[data-testid="project-file-preview.ts"]')
  await wait('document.querySelectorAll("[data-file-tab]").length===2', '聊天文件窗口普通多标签')
  await click('[data-testid="project-git-changes-toggle"]')
  await click('[data-testid="project-file-hello.ts"]')
  await click('[data-testid="project-file-preview.ts"]')
  await wait(
    `document.querySelectorAll(${JSON.stringify(diffTabs)}).length===2`,
    '聊天文件窗口多个工作区Diff'
  )
  await settled()
  await click('[data-testid="file-tab-hello.ts"] [role="tab"]')
  assert.equal(await tabCount(), 2)
  await progress('共享消费者：聊天文件窗口普通多文件和两个工作区Diff混合切换通过')
  assert.deepEqual(await evaluate(page, 'window.__previewErrors'), [])
}
