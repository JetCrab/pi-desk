import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  clickText,
  createCdpPage,
  evaluate,
  navigate,
  publishScreenshots,
  reservePort,
  screenshot,
  setViewport,
  spawnEdge,
  stopBrowserTree,
  waitFor,
  waitForHttp
} from './l4-browser-cdp-runtime.mjs'
import {
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const testRoot = join(projectRoot, 'temp', 'pi', 'git-workspace-e2e', String(process.pid))
const failureRoot = join(
  projectRoot,
  'temp',
  'run',
  'git-workspace-interaction',
  String(process.pid)
)
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, 'A')
const noGitProjectDir = join(testRoot, 'NoGit')
const pinnedProjectDirA = join(testRoot, 'PinnedA')
const pinnedProjectDirB = join(testRoot, 'PinnedB')
const repositoryB = join(projectDir, 'B')
const repositoryC = join(projectDir, 'C')
const repositoryD = join(projectDir, 'D')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const outputRoot = join(
  projectRoot,
  'temp',
  'run',
  'git-workspace-interaction',
  String(process.pid)
)
const desktopDirectoryFirstOutput = join(
  outputRoot,
  '客户端_桌面暗色',
  'Git工作台__目录优先加载.png'
)
const desktopRepositoryOutput = join(outputRoot, '客户端_桌面暗色', 'Git工作台__多仓库视图.png')
const desktopDiffOutput = join(outputRoot, '客户端_桌面暗色', 'Git工作台__MonacoDiff.png')
const desktopBranchesOutput = join(outputRoot, '客户端_桌面暗色', 'Git工作台__分支弹层.png')
const mobileOutput = join(outputRoot, '客户端_移动端暗色', 'Git工作台__仓库抽屉.png')
const mobileBranchesOutput = join(outputRoot, '客户端_移动端暗色', 'Git工作台__分支详情.png')
const workId = 'git-workspace-e2e'
const noGitWorkId = 'git-workspace-no-git-e2e'
const modelProviderId = 'layout-test-provider'
const modelId = 'gpt-5.6-terra'
const pinnedWorkIdA = 'git-workspace-pinned-a-e2e'
const pinnedWorkIdB = 'git-workspace-pinned-b-e2e'
const composerDesktopSingleRunOutput = join(
  projectRoot,
  'temp',
  'run',
  'git-workspace-layout-e2e',
  String(process.pid),
  '聊天输入区__桌面460无Git单行.png'
)
const composerDesktopRunOutput = join(
  projectRoot,
  'temp',
  'run',
  'git-workspace-layout-e2e',
  String(process.pid),
  '聊天输入区__桌面窄列两行.png'
)
const composerMobileRunOutput = join(
  projectRoot,
  'temp',
  'run',
  'git-workspace-layout-e2e',
  String(process.pid),
  '聊天输入区__移动端443px单行.png'
)
const password = 'Qq.445566'
let appPort = 0
let cdpPort = 0
let serverRuntime
let browserProcess
let serverOutput = ''

async function git(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' }
  })
}

async function initRepository(cwd) {
  await mkdir(cwd, { recursive: true })
  await git(cwd, ['init', '-b', 'main'])
  await git(cwd, ['config', 'user.name', 'Pi Desk E2E'])
  await git(cwd, ['config', 'user.email', 'pi-desk@example.test'])
  await git(cwd, ['config', 'core.autocrlf', 'false'])
}

async function commitAll(cwd, message) {
  await git(cwd, ['add', '-A'])
  await git(cwd, ['commit', '-m', message])
}

function assistant(text, timestamp) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp
  }
}

async function createFixture() {
  process.env.TSX_TSCONFIG_PATH = join(projectRoot, 'tsconfig.json')
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  await prepareIsolatedPiDirectory(agentDir)
  await mkdir(dirname(workSessionStorePath), { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), `${JSON.stringify({ packages: [] }, null, 2)}\n`)
  await writeFile(
    join(agentDir, 'models.json'),
    `${JSON.stringify(
      {
        providers: {
          [modelProviderId]: {
            baseUrl: 'http://127.0.0.1:1/v1',
            api: 'openai-completions',
            apiKey: 'layout-test-key',
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false
            },
            models: [
              {
                id: modelId,
                name: modelId,
                reasoning: true,
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
              }
            ]
          }
        }
      },
      null,
      2
    )}\n`
  )

  await initRepository(projectDir)
  await mkdir(join(projectDir, '.pi'), { recursive: true })
  await writeFile(
    join(projectDir, '.pi', 'settings.json'),
    `${JSON.stringify(
      { defaultProvider: modelProviderId, defaultModel: modelId, defaultThinkingLevel: 'high' },
      null,
      2
    )}\n`
  )
  await mkdir(join(projectDir, 'src'), { recursive: true })
  await writeFile(join(projectDir, '.gitignore'), 'B/\nC/\nD/\n.pi/\n')
  await writeFile(join(projectDir, 'README.md'), 'before root change\n')
  await writeFile(join(projectDir, 'src', 'clean.ts'), 'export const clean = true\n')
  await writeFile(join(projectDir, 'package.json'), '{"name":"repo-a"}\n')
  await writeFile(join(projectDir, 'obsolete.txt'), 'remove me\n')
  await commitAll(projectDir, 'root initial')
  await writeFile(join(projectDir, 'README.md'), 'after root change\n')
  await writeFile(join(projectDir, 'new-file.ts'), 'export const untracked = true\n')
  await writeFile(join(projectDir, 'tracked-new.ts'), 'export const added = true\n')
  await git(projectDir, ['add', 'tracked-new.ts'])
  await rm(join(projectDir, 'obsolete.txt'))

  await initRepository(repositoryB)
  await mkdir(join(repositoryB, 'src'), { recursive: true })
  await writeFile(join(repositoryB, 'src', 'feature.ts'), 'export const feature = "main"\n')
  await writeFile(join(repositoryB, 'package.json'), '{"name":"repo-b"}\n')
  await commitAll(repositoryB, 'B initial')
  const repositoryBHead = (await git(repositoryB, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(repositoryB, [
    'update-ref',
    'refs/remotes/origin/feature/team/remote-demo',
    repositoryBHead
  ])
  await git(repositoryB, ['switch', '-c', 'feature/b'])
  await writeFile(join(repositoryB, 'src', 'feature.ts'), 'export const feature = "feature/b"\n')

  await initRepository(repositoryC)
  await writeFile(join(repositoryC, 'conflict.ts'), 'export const value = "base"\n')
  await commitAll(repositoryC, 'C initial')
  await git(repositoryC, ['switch', '-c', 'conflict-side'])
  await writeFile(join(repositoryC, 'conflict.ts'), 'export const value = "side"\n')
  await commitAll(repositoryC, 'C side')
  await git(repositoryC, ['switch', 'main'])
  await git(repositoryC, ['switch', '-c', 'develop'])
  await writeFile(join(repositoryC, 'conflict.ts'), 'export const value = "develop"\n')
  await commitAll(repositoryC, 'C develop')
  await assert.rejects(() => git(repositoryC, ['merge', 'conflict-side']))

  await initRepository(repositoryD)
  await writeFile(join(repositoryD, 'README.md'), 'clean repository\n')
  await commitAll(repositoryD, 'D initial')

  await mkdir(noGitProjectDir, { recursive: true })
  await mkdir(join(noGitProjectDir, '.pi'), { recursive: true })
  await writeFile(join(noGitProjectDir, 'README.md'), 'project without Git\n')
  await writeFile(
    join(noGitProjectDir, '.pi', 'settings.json'),
    `${JSON.stringify(
      { defaultProvider: modelProviderId, defaultModel: modelId, defaultThinkingLevel: 'high' },
      null,
      2
    )}\n`
  )
  await mkdir(pinnedProjectDirA, { recursive: true })
  await writeFile(join(pinnedProjectDirA, 'README.md'), 'pinned project A without Git\n')
  await mkdir(pinnedProjectDirB, { recursive: true })
  await writeFile(join(pinnedProjectDirB, 'README.md'), 'pinned project B without Git\n')

  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const session = SessionManager.create(projectDir)
  const timestamp = Date.now()
  session.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '检查多个 Git 仓库的变更。' }],
    timestamp
  })
  session.appendMessage(assistant('可以从左侧仓库视图打开 Diff。', timestamp + 1))
  const noGitSession = SessionManager.create(noGitProjectDir)
  noGitSession.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '检查没有 Git 仓库的项目输入区。' }],
    timestamp: timestamp + 2
  })
  noGitSession.appendMessage(assistant('该项目没有 Git 仓库。', timestamp + 3))
  const pinnedSessionA = SessionManager.create(pinnedProjectDirA)
  pinnedSessionA.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '固定列 A。' }],
    timestamp: timestamp + 4
  })
  pinnedSessionA.appendMessage(assistant('固定列 A 没有 Git。', timestamp + 5))
  const pinnedSessionB = SessionManager.create(pinnedProjectDirB)
  pinnedSessionB.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '固定列 B。' }],
    timestamp: timestamp + 6
  })
  pinnedSessionB.appendMessage(assistant('固定列 B 没有 Git。', timestamp + 7))
  await writeFile(
    workSessionStorePath,
    `${JSON.stringify(
      {
        workSessions: [
          {
            workId: pinnedWorkIdA,
            cwd: pinnedProjectDirA,
            sessionId: pinnedSessionA.getSessionId()
          },
          {
            workId: pinnedWorkIdB,
            cwd: pinnedProjectDirB,
            sessionId: pinnedSessionB.getSessionId()
          },
          { workId, cwd: projectDir, sessionId: session.getSessionId() },
          { workId: noGitWorkId, cwd: noGitProjectDir, sessionId: noGitSession.getSessionId() }
        ],
        pinnedCount: 2
      },
      null,
      2
    )}\n`
  )
}

async function login(client) {
  await navigate(client, `http://127.0.0.1:${appPort}/login`)
  const result = await evaluate(
    client,
    `fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Pi-Desk-Client-Id': '15b1d5c6-9381-432b-bf7f-1e704ec46284'
      },
      body: JSON.stringify({ password: ${JSON.stringify(password)} })
    }).then(async (response) => ({ ok: response.ok, body: await response.json() }))`
  )
  assert.equal(result.ok, true, result.body?.msg)
  await evaluate(
    client,
    `localStorage.setItem('pi-desk:workbench-layout', JSON.stringify({ primaryWorkId: ${JSON.stringify(workId)} }));
     localStorage.removeItem('pi-desk:file-window-position')`
  )
}

async function openProjectFiles(client) {
  await evaluate(
    client,
    'window.__piDeskGitGetSettled = false; window.__piDeskGitGetSettledCount = 0'
  )
  const opened = await evaluate(
    client,
    `(() => {
      const button = document.querySelector('[aria-label="显示项目文件"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(opened, true, '未找到项目文件入口')
  await waitFor(
    client,
    `document.querySelector('[data-testid="project-file-README.md"]') !== null`,
    '目录内容优先显示',
    () => serverOutput,
    60_000
  )
  const directoryFirst = await evaluate(
    client,
    `({
      gitSettled: window.__piDeskGitGetSettled,
      repositoryRendered: document.querySelector('[data-testid="project-git-repository-root"]') !== null
    })`
  )
  assert.equal(directoryFirst.gitSettled, false, JSON.stringify(directoryFirst))
  assert.equal(directoryFirst.repositoryRendered, false, JSON.stringify(directoryFirst))
  const directoryFirstCapture = await screenshot(client)

  await waitFor(
    client,
    `document.querySelector('[data-testid="project-file-layout-repository"]') !== null`,
    'Git 仓库布局入口加载',
    () => serverOutput,
    60_000
  )
  await evaluate(
    client,
    `document.querySelector('[data-testid="project-file-layout-repository"]')?.click()`
  )
  await waitFor(
    client,
    `['root','B','C','D'].every((root) => document.querySelector('[data-testid="project-git-repository-' + root + '"]'))`,
    'A/B/C/D 仓库根加载',
    () => serverOutput
  )
  return directoryFirstCapture
}

async function assertRepositoryView(client) {
  const repositoryState = await evaluate(
    client,
    `(() => {
      const model = document.querySelector('[aria-label="选择模型与思考等级"]');
      const git = document.querySelector('[data-testid="composer-git-branch"]');
      const repositoryHeaders = [...document.querySelectorAll('section[data-testid^="project-git-repository-"]')]
        .map((section) => section.firstElementChild?.getBoundingClientRect().height ?? 999);
      return {
        headerHeight: document.querySelector('[aria-label="A 项目文件"] > div')?.getBoundingClientRect().height ?? 999,
        repositoryHeaderHeight: Math.max(...repositoryHeaders),
        rootExpanded: document.querySelector('[data-testid="project-git-repository-toggle-root"]')?.getAttribute('aria-expanded'),
        bExpanded: document.querySelector('[data-testid="project-git-repository-toggle-B"]')?.getAttribute('aria-expanded'),
        cExpanded: document.querySelector('[data-testid="project-git-repository-toggle-C"]')?.getAttribute('aria-expanded'),
        dExpanded: document.querySelector('[data-testid="project-git-repository-toggle-D"]')?.getAttribute('aria-expanded'),
        visibleFiles: document.querySelectorAll('[role="treeitem"][data-testid^="project-file-"]').length,
        branchA: document.querySelector('[data-testid="project-git-branch-root"]')?.textContent ?? '',
        branchB: document.querySelector('[data-testid="project-git-branch-B"]')?.textContent ?? '',
        branchC: document.querySelector('[data-testid="project-git-branch-C"]')?.textContent ?? '',
        branchD: document.querySelector('[data-testid="project-git-branch-D"]')?.textContent ?? '',
        modelBeforeGit: Boolean(model && git && (model.compareDocumentPosition(git) & Node.DOCUMENT_POSITION_FOLLOWING)),
        composerSummary: git?.textContent ?? ''
      };
    })()`
  )
  assert.ok(repositoryState.headerHeight <= 88, JSON.stringify(repositoryState))
  assert.ok(repositoryState.repositoryHeaderHeight <= 34, JSON.stringify(repositoryState))
  assert.equal(repositoryState.rootExpanded, 'false', JSON.stringify(repositoryState))
  assert.equal(repositoryState.bExpanded, 'false', JSON.stringify(repositoryState))
  assert.equal(repositoryState.cExpanded, 'false', JSON.stringify(repositoryState))
  assert.equal(repositoryState.dExpanded, 'false', JSON.stringify(repositoryState))
  assert.equal(repositoryState.visibleFiles, 0, JSON.stringify(repositoryState))
  assert.match(repositoryState.branchA, /main/)
  assert.match(repositoryState.branchB, /feature\/b/)
  assert.match(repositoryState.branchC, /develop/)
  assert.match(repositoryState.branchD, /main/)
  assert.equal(repositoryState.modelBeforeGit, false)
  assert.match(repositoryState.composerSummary, /4 个仓库/)
  assert.doesNotMatch(repositoryState.composerSummary, /分支不一致/)
}

async function readComposerLayout(client, targetWorkId = workId) {
  const columnSelector = `[data-work-id="${targetWorkId}"]`
  return evaluate(
    client,
    `(() => {
      const column = document.querySelector(${JSON.stringify(columnSelector)});
      const frame = column?.querySelector('form[data-composer-mobile]');
      const footer = frame?.querySelector('[data-slot="input-group-addon"][data-align="block-end"]');
      if (!(column instanceof HTMLElement) || !(frame instanceof HTMLElement) || !(footer instanceof HTMLElement)) return null;
      const find = (selector) => frame.querySelector(selector);
      const context = [...frame.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.startsWith('上下文 '));
      const nodes = [
        ['more', find('[aria-label="更多操作"]')],
        ['attachment', find('[aria-label="添加图片"]')],
        ['context', context],
        ['git', find('[data-testid="composer-git-branch"]')],
        ['model', find('[aria-label="选择模型与思考等级"]')],
        ['send', find('[aria-label="发送消息"]')]
      ].filter(([, node]) => node instanceof HTMLElement);
      const rect = (node) => {
        const value = node.getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
      };
      const ordered = [...nodes].sort((left, right) => {
        if (left[1] === right[1]) return 0;
        return left[1].compareDocumentPosition(right[1]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      const readNode = (name) => {
        const node = nodes.find(([candidate]) => candidate === name)?.[1];
        return node instanceof HTMLElement ? rect(node) : null;
      };
      const fullBranch = frame.querySelector('[data-git-branch-full]');
      const modelDetails = frame.querySelector('[data-model-trigger-details]');
      return {
        mobile: frame.getAttribute('data-composer-mobile'),
        metadataRow: frame.getAttribute('data-composer-metadata-row'),
        frame: rect(frame),
        footer: rect(footer),
        order: ordered.map(([name]) => name),
        more: readNode('more'),
        attachment: readNode('attachment'),
        context: readNode('context'),
        git: readNode('git'),
        model: readNode('model'),
        modelText: find('[aria-label="选择模型与思考等级"]')?.textContent?.trim() ?? '',
        send: readNode('send'),
        gitFullDisplay: fullBranch instanceof HTMLElement ? getComputedStyle(fullBranch).display : null,
        modelDetailsDisplay: modelDetails instanceof HTMLElement ? getComputedStyle(modelDetails).display : null,
        modelDetailsWidth: modelDetails instanceof HTMLElement ? modelDetails.getBoundingClientRect().width : null
      };
    })()`
  )
}

function assertComposerBounds(layout, label) {
  assert.ok(layout, `${label}输入区不存在`)
  const controls = ['attachment', 'context', 'git', 'model', 'send']
    .map((name) => layout[name])
    .filter(Boolean)
  assert.ok(controls.length >= 4, `${label}输入区控件不完整：${JSON.stringify(layout)}`)
  for (const control of controls) {
    assert.ok(control.left >= layout.frame.left - 1, `${label}左侧溢出：${JSON.stringify(layout)}`)
    assert.ok(
      control.right <= layout.frame.right + 1,
      `${label}右侧溢出：${JSON.stringify(layout)}`
    )
  }
}

function assertComposerOrder(layout, label, gitVisible = true) {
  const index = (name) => layout.order.indexOf(name)
  assert.ok(index('attachment') >= 0, `${label}缺少附件按钮：${JSON.stringify(layout)}`)
  assert.ok(index('model') >= 0, `${label}缺少模型按钮：${JSON.stringify(layout)}`)
  assert.ok(index('send') >= 0, `${label}缺少发送按钮：${JSON.stringify(layout)}`)
  if (gitVisible) {
    assert.ok(index('git') >= 0, `${label}缺少 Git 按钮：${JSON.stringify(layout)}`)
    assert.ok(
      index('attachment') < index('git'),
      `${label}附件应在 Git 前：${JSON.stringify(layout)}`
    )
    assert.ok(index('git') < index('model'), `${label}Git 应在模型前：${JSON.stringify(layout)}`)
  } else {
    assert.equal(index('git'), -1, `${label}无 Git时不应显示 Git按钮：${JSON.stringify(layout)}`)
  }
  assert.ok(
    index('attachment') < index('model'),
    `${label}附件应在模型前：${JSON.stringify(layout)}`
  )
  assert.ok(index('model') < index('send'), `${label}模型应在发送前：${JSON.stringify(layout)}`)
  if (layout.context) {
    assert.ok(
      index('attachment') < index('context'),
      `${label}附件应在上下文圆环前：${JSON.stringify(layout)}`
    )
    assert.ok(
      index('context') < index(gitVisible ? 'git' : 'model'),
      `${label}上下文圆环应在元数据控件前：${JSON.stringify(layout)}`
    )
  }
}

function assertSameTop(layout, names, label) {
  const controls = names.map((name) => layout[name]).filter(Boolean)
  assert.ok(controls.length > 0, `${label}没有可比较的控件：${JSON.stringify(layout)}`)
  const top = controls[0].top
  assert.ok(
    controls.every((control) => Math.abs(control.top - top) <= 2),
    `${label}控件未对齐：${JSON.stringify(layout)}`
  )
}

async function assertComposerWideLayout(client) {
  const layout = await readComposerLayout(client)
  assertComposerBounds(layout, '桌面宽列')
  assertComposerOrder(layout, '桌面宽列')
  assert.equal(layout.mobile, 'false', JSON.stringify(layout))
  assert.equal(layout.metadataRow, 'false', JSON.stringify(layout))
  assertSameTop(layout, ['attachment', 'context', 'git', 'model', 'send'], '桌面宽列单行')
}

async function assertComposerDesktopSingleLayout(client, targetWorkId, label) {
  const layout = await readComposerLayout(client, targetWorkId)
  assertComposerBounds(layout, label)
  assertComposerOrder(layout, label, false)
  assert.equal(layout.mobile, 'false', JSON.stringify(layout))
  assert.equal(layout.metadataRow, 'false', JSON.stringify(layout))
  assert.ok(layout.frame.width >= 430 && layout.frame.width <= 500, JSON.stringify(layout))
  assert.match(layout.modelText, /gpt-5\.6-terra · 高/)
  assertSameTop(layout, ['attachment', 'context', 'git', 'model', 'send'], `${label}单行`)
}

async function assertComposerDesktopNarrowLayout(client) {
  const layout = await readComposerLayout(client)
  assertComposerBounds(layout, '桌面窄列')
  assertComposerOrder(layout, '桌面窄列')
  assert.equal(layout.mobile, 'false', JSON.stringify(layout))
  assert.equal(layout.metadataRow, 'true', JSON.stringify(layout))
  assert.ok(layout.git && layout.model && layout.attachment && layout.send, JSON.stringify(layout))
  assertSameTop(layout, ['git', 'model'], '桌面窄列上一行')
  assertSameTop(layout, ['attachment', 'context', 'send'], '桌面窄列下一行')
  assert.ok(layout.git.top + 2 < layout.attachment.top, JSON.stringify(layout))
}

async function assertComposerMobileLayout(client, width) {
  const layout = await readComposerLayout(client)
  assertComposerBounds(layout, `移动端 ${width}px`)
  assertComposerOrder(layout, `移动端 ${width}px`)
  assert.equal(layout.mobile, 'true', JSON.stringify(layout))
  assertSameTop(layout, ['attachment', 'context', 'git', 'model', 'send'], `移动端 ${width}px 单行`)
  assert.equal(layout.gitFullDisplay, 'none', JSON.stringify(layout))
  assert.notEqual(layout.modelDetailsDisplay, 'none', JSON.stringify(layout))
  assert.ok(layout.modelDetailsWidth > 0, JSON.stringify(layout))
  assert.ok(layout.footer.height <= 50, JSON.stringify(layout))
}

async function selectWorkSession(client, targetWorkId) {
  const selected = await evaluate(
    client,
    `(() => {
      const row = document.querySelector(${JSON.stringify(`[data-testid="work-session-row-${targetWorkId}"]`)});
      if (!(row instanceof HTMLElement)) return false;
      row.click();
      return true;
    })()`
  )
  assert.equal(selected, true, `未找到工作会话：${targetWorkId}`)
  await waitFor(
    client,
    `document.querySelector(${JSON.stringify(`[data-work-id="${targetWorkId}"] textarea`)}) !== null && document.querySelector(${JSON.stringify(`[data-work-id="${targetWorkId}"] footer[data-composer-active="true"]`)}) !== null`,
    `切换到工作会话 ${targetWorkId}`,
    () => serverOutput
  )
}

async function dragWorkSessionDivider(client, delta) {
  const selector = '[aria-label="调整第 1 列与第 2 列宽度"]'
  const start = await evaluate(
    client,
    `(() => {
      const divider = document.querySelector(${JSON.stringify(selector)});
      if (!(divider instanceof HTMLElement)) return null;
      const rect = divider.getBoundingClientRect();
      if (rect.height <= 0 || divider.getAttribute('aria-disabled') === 'true') return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  )
  assert.ok(start, '工作会话列分隔线不可拖动')
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: start.x,
    y: start.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  for (const ratio of [0.01, 0.35, 0.7, 1]) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x + delta * ratio,
      y: start.y,
      button: 'left',
      buttons: 1
    })
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: start.x + delta,
    y: start.y,
    button: 'left',
    buttons: 0
  })
}

async function assertNoGitComposer(client, targetWorkId, previousSettledCount) {
  const deadline = Date.now() + 60_000
  const selector = JSON.stringify(`[data-work-id="${targetWorkId}"]`)
  while (Date.now() < deadline) {
    const state = await evaluate(
      client,
      `(() => {
        const column = document.querySelector(${selector});
        return {
          settledCount: window.__piDeskGitGetSettledCount,
          column: column !== null,
          git: column?.querySelector('[data-testid="composer-git-branch"]') !== null,
          model: column?.querySelector('[aria-label="选择模型与思考等级"]') !== null,
          attachment: column?.querySelector('[aria-label="添加图片"]') !== null,
          send: column?.querySelector('[aria-label="发送消息"]') !== null
        };
      })()`
    )
    if (
      state.settledCount > previousSettledCount &&
      state.column &&
      !state.git &&
      state.model &&
      state.attachment &&
      state.send
    ) {
      assert.deepEqual(
        {
          column: state.column,
          git: state.git,
          model: state.model,
          attachment: state.attachment,
          send: state.send
        },
        { column: true, git: false, model: true, attachment: true, send: true }
      )
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`无 Git 项目composer未在同一采样达到ready：${serverOutput.slice(-6000)}`)
}

async function openDiff(client) {
  const toggled = await evaluate(
    client,
    `(() => {
      const button = document.querySelector('[data-testid="project-git-changes-toggle"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(toggled, true, '未找到只看变更')
  await waitFor(
    client,
    `document.querySelector('[data-testid="project-git-repository-root"]') !== null && document.querySelector('[data-testid="project-git-repository-B"]') !== null && document.querySelector('[data-testid="project-git-repository-C"]') !== null && document.querySelector('[data-testid="project-git-repository-D"]') === null && document.querySelector('[data-testid="project-file-README.md"]') === null`,
    '只展示有变更且默认收起的仓库',
    () => serverOutput
  )
  await evaluate(
    client,
    `document.querySelector('[data-testid="project-git-repository-toggle-root"]')?.click(); document.querySelector('[data-testid="project-git-repository-toggle-C"]')?.click()`
  )
  await waitFor(
    client,
    `['README.md','new-file.ts','tracked-new.ts','obsolete.txt','C/conflict.ts'].every((path) => document.querySelector('[data-testid="project-file-' + path + '"]')) && document.querySelector('[data-testid="project-file-src/clean.ts"]') === null`,
    '展开后只展示变更文件',
    () => serverOutput
  )
  const fileColors = await evaluate(
    client,
    `(() => {
      const color = (path) => {
        const node = document.querySelector('[data-testid="project-file-name-' + path + '"]');
        return node ? getComputedStyle(node).color : '';
      };
      return {
        modified: color('README.md'),
        untracked: color('new-file.ts'),
        added: color('tracked-new.ts'),
        deleted: color('obsolete.txt'),
        conflict: color('C/conflict.ts'),
        statusActions: document.querySelectorAll('[aria-label$=" Git Diff"]').length
      };
    })()`
  )
  assert.ok(fileColors.modified, JSON.stringify(fileColors))
  assert.ok(fileColors.untracked, JSON.stringify(fileColors))
  assert.ok(fileColors.added, JSON.stringify(fileColors))
  assert.ok(fileColors.deleted, JSON.stringify(fileColors))
  assert.ok(fileColors.conflict, JSON.stringify(fileColors))
  assert.equal(
    new Set([
      fileColors.modified,
      fileColors.untracked,
      fileColors.added,
      fileColors.deleted,
      fileColors.conflict
    ]).size,
    5
  )
  assert.equal(fileColors.statusActions, 0)

  const opened = await evaluate(
    client,
    `(() => {
      const file = document.querySelector('[data-testid="project-file-README.md"]');
      if (!(file instanceof HTMLElement)) return false;
      file.click();
      return true;
    })()`
  )
  assert.equal(opened, true, '未找到 README.md 变更')
  await waitFor(
    client,
    `(() => {
      const workspace = document.querySelector('[data-testid="file-workspace"]');
      const text = (workspace?.textContent ?? '').replaceAll('\u00a0', ' ');
      return workspace?.querySelector('[data-testid="file-diff-tab-README.md"]') !== null && text.includes('before root change') && text.includes('after root change');
    })()`,
    'Monaco Git Diff 渲染',
    () => serverOutput,
    60_000
  )
}

async function openAndSwitchBranch(client) {
  const closeDiff = await evaluate(
    client,
    `(() => {
      const button = document.querySelector('[aria-label="关闭 Diff README.md"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(closeDiff, true, '未找到关闭 Diff 操作')
  await waitFor(
    client,
    `document.querySelector('[data-testid="file-workspace"]') === null && document.querySelector('[data-testid="session-files-entry"]') === null`,
    '关闭最后Diff并退出文件窗口',
    () => serverOutput
  )
  const opened = await evaluate(
    client,
    `(() => {
      const button = document.querySelector('[data-testid="composer-git-branch"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(opened, true, '未找到 Composer Git 分支入口')
  await waitFor(
    client,
    `document.querySelector('[data-testid="git-branch-picker"]') !== null`,
    'Git 分支弹层打开',
    () => serverOutput
  )
  const selectedB = await evaluate(
    client,
    `(() => {
      const button = document.querySelector('[data-testid="git-branch-picker-repository-B"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`
  )
  assert.equal(selectedB, true, '未找到 B 仓库')
  await waitFor(
    client,
    `(() => {
      const localGroup = document.querySelector('[data-testid="git-branch-group-local-feature"]');
      const recent = document.querySelector('[data-testid="git-branch-recent-feature/b"]');
      return localGroup?.getAttribute('aria-expanded') === 'true' && document.querySelector('[data-testid="git-branch-local-feature/b"]') !== null && recent?.textContent?.includes('feature/b') && document.querySelector('[data-testid="git-branch-local-main"]') !== null;
    })()`,
    '最近分支平铺且当前本地分支路径展开',
    () => serverOutput
  )
  await evaluate(
    client,
    `document.querySelector('[data-testid="git-branch-group-remote-origin"]')?.click()`
  )
  await waitFor(
    client,
    `document.querySelector('[data-testid="git-branch-group-remote-origin/feature"]') !== null`,
    '远程 origin 目录展开',
    () => serverOutput
  )
  await evaluate(
    client,
    `document.querySelector('[data-testid="git-branch-group-remote-origin/feature"]')?.click()`
  )
  await waitFor(
    client,
    `document.querySelector('[data-testid="git-branch-group-remote-origin/feature/team"]') !== null`,
    '远程 feature 目录展开',
    () => serverOutput
  )
  await evaluate(
    client,
    `document.querySelector('[data-testid="git-branch-group-remote-origin/feature/team"]')?.click()`
  )
  await waitFor(
    client,
    `document.querySelector('[data-testid="git-branch-remote-origin/feature/team/remote-demo"]') !== null`,
    '远程多级分支叶子显示',
    () => serverOutput
  )
  await evaluate(client, `document.querySelector('[data-testid="git-branch-local-main"]')?.click()`)
  await clickText(client, '切换到此分支')
  await waitFor(
    client,
    `document.querySelector('[data-testid="git-branch-picker"]') === null && document.querySelector('[data-testid="project-git-branch-B"]')?.textContent?.includes('main')`,
    'B 切换到 main',
    () => serverOutput,
    60_000
  )
}

async function main() {
  let client
  let directoryFirstCapture
  let repositoryCapture
  let diffCapture
  let branchCapture
  let composerDesktopSingleCapture
  let composerDesktopCapture
  let composerMobileCapture
  let mobileCapture
  let mobileBranchesCapture
  try {
    await createFixture()
    appPort = await reservePort()
    cdpPort = await reservePort()
    serverRuntime = spawnE2eServer({
      projectRoot,
      agentDir,
      port: appPort,
      development: true,
      onOutput: (output) => {
        serverOutput += output
      }
    })
    await waitForHttp(
      `http://127.0.0.1:${appPort}/api/health`,
      30_000,
      'Pi Desk',
      () => serverOutput
    )
    browserProcess = spawnEdge(edgePath, cdpPort, join(testRoot, 'edge-profile'), '1440,900')
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000, 'Edge CDP')
    client = await createCdpPage(cdpPort)
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await client.send('Page.bringToFront')
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__piDeskE2eErrors = [];
        window.__piDeskGitGetSettled = false;
        window.__piDeskGitGetSettledCount = 0;
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const input = args[0];
          const requestUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
          const response = await originalFetch(...args);
          if (new URL(requestUrl, location.href).pathname === '/api/project-git/get') {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            window.__piDeskGitGetSettled = true;
            window.__piDeskGitGetSettledCount += 1;
          }
          return response;
        };
        const describe = (value) => value instanceof ErrorEvent
          ? { type: 'ErrorEvent', message: value.message, filename: value.filename }
          : value instanceof Error
            ? { type: value.name, message: value.message, stack: value.stack ?? '' }
            : { type: typeof value, message: String(value) };
        window.addEventListener('error', (event) => window.__piDeskE2eErrors.push(describe(event)));
        window.addEventListener('unhandledrejection', (event) => window.__piDeskE2eErrors.push(describe(event.reason)));
      `
    })
    await client.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: 'dark' },
        { name: 'prefers-reduced-motion', value: 'reduce' }
      ]
    })
    await setViewport(client, 4000, 900, false)
    await login(client)
    await navigate(client, `http://127.0.0.1:${appPort}/`)
    await waitFor(
      client,
      `document.querySelector('[data-work-id=${JSON.stringify(workId)}] textarea') !== null`,
      '工作台加载',
      () => serverOutput,
      60_000
    )
    await waitFor(client, 'window.innerWidth === 4000', '桌面宽列视口', () => serverOutput)
    await waitFor(
      client,
      `(() => {
        const column = document.querySelector('[data-work-id="${workId}"]');
        return column?.querySelector('footer[data-composer-active="true"] [aria-label="发送消息"]') !== null &&
          !column.querySelector('[aria-label="选择模型与思考等级"]')?.textContent?.includes('选择模型');
      })()`,
      '当前会话初始化完成且模型就绪',
      () => serverOutput,
      60_000
    )
    await assertComposerWideLayout(client)
    await setViewport(client, 2000, 900, false)
    await waitFor(client, 'window.innerWidth === 2000', '桌面三列窄列视口', () => serverOutput)
    directoryFirstCapture = await openProjectFiles(client)
    await assertRepositoryView(client)
    repositoryCapture = await screenshot(client)

    await openDiff(client)
    const browserErrors = await evaluate(
      client,
      `new Promise((resolve) => setTimeout(() => resolve(window.__piDeskE2eErrors ?? []), 500))`
    )
    assert.deepEqual(browserErrors, [], `浏览器异常：${JSON.stringify(browserErrors)}`)
    diffCapture = await screenshot(client)

    await openAndSwitchBranch(client)
    await waitFor(
      client,
      `!document.body.innerText.includes('已切换到 main')`,
      '分支切换成功提示消失',
      () => serverOutput
    )
    await evaluate(client, `document.querySelector('[data-testid="composer-git-branch"]')?.click()`)
    await waitFor(
      client,
      `document.querySelector('[data-testid="git-branch-picker"]') !== null`,
      '切换后重新打开分支弹层',
      () => serverOutput
    )
    await evaluate(
      client,
      `document.querySelector('[data-testid="git-branch-picker-repository-B"]')?.click()`
    )
    await waitFor(
      client,
      `document.querySelector('[data-testid="git-branch-local-main"]') !== null`,
      '切换后 B 分支详情',
      () => serverOutput
    )
    await evaluate(
      client,
      `document.querySelector('[data-testid="git-branch-group-local-feature"]')?.click(); document.querySelector('[data-testid="git-branch-group-remote-origin"]')?.click()`
    )
    await waitFor(
      client,
      `document.querySelector('[data-testid="git-branch-local-feature/b"]') !== null && document.querySelector('[data-testid="git-branch-group-remote-origin/feature"]') !== null`,
      '分支层级截图状态',
      () => serverOutput
    )
    branchCapture = await screenshot(client)
    await clickText(client, '关闭')

    await setViewport(client, 1800, 900, false)
    await waitFor(client, 'window.innerWidth === 1800', '桌面460窄列视口', () => serverOutput)
    const previousGitSettledCount = await evaluate(client, 'window.__piDeskGitGetSettledCount')
    await selectWorkSession(client, noGitWorkId)
    await assertNoGitComposer(client, noGitWorkId, previousGitSettledCount)
    await waitFor(
      client,
      `(() => {
        const column = document.querySelector('[data-work-id="${noGitWorkId}"]');
        const form = column?.querySelector('form[data-composer-mobile="false"]');
        return form?.getAttribute('data-composer-metadata-row') === 'false' && form?.getBoundingClientRect().width >= 430 && form?.getBoundingClientRect().width <= 500 && form?.querySelector('[aria-label="选择模型与思考等级"]')?.textContent?.includes('gpt-5.6-terra · 高');
      })()`,
      '无 Git 长模型桌面460px保持单行',
      () => serverOutput
    )
    await assertComposerDesktopSingleLayout(client, noGitWorkId, '无 Git 长模型桌面460px')
    composerDesktopSingleCapture = await screenshot(client)

    await selectWorkSession(client, workId)
    await setViewport(client, 1800, 900, false)
    await waitFor(client, 'window.innerWidth === 1800', 'Git超宽桌面视口', () => serverOutput)
    await dragWorkSessionDivider(client, -180)
    await waitFor(
      client,
      `(() => {
        const column = document.querySelector('[data-work-id="${workId}"]');
        return column?.querySelector('[data-git-branch-full]') !== null && column?.querySelector('form[data-composer-metadata-row="true"]') !== null;
      })()`,
      'Git 异步出现后重新判断桌面换行',
      () => serverOutput,
      60_000
    )
    await waitFor(
      client,
      `(() => {
        const form = document.querySelector('[data-work-id="${workId}"] form[data-composer-mobile="false"]');
        const git = form?.querySelector('[data-testid="composer-git-branch"]')?.getBoundingClientRect();
        const model = form?.querySelector('[aria-label="选择模型与思考等级"]')?.getBoundingClientRect();
        const attachment = form?.querySelector('[aria-label="添加图片"]')?.getBoundingClientRect();
        const send = form?.querySelector('[aria-label="发送消息"]')?.getBoundingClientRect();
        return Boolean(git && model && attachment && send) && Math.abs(git.top - model.top) <= 2 && Math.abs(attachment.top - send.top) <= 2 && git.top + 2 < attachment.top;
      })()`,
      'Git 长模型桌面460px输入区两行布局',
      () => serverOutput
    )
    await assertComposerDesktopNarrowLayout(client)
    composerDesktopCapture = await screenshot(client)

    await setViewport(client, 443, 844, true)
    await waitFor(
      client,
      `(() => {
        const form = document.querySelector('[data-work-id="${workId}"] form[data-composer-mobile="true"]');
        const git = form?.querySelector('[data-testid="composer-git-branch"]');
        const full = form?.querySelector('[data-git-branch-full]');
        const modelDetails = form?.querySelector('[data-model-trigger-details]');
        const buttons = [form?.querySelector('[aria-label="添加图片"]'), git, form?.querySelector('[aria-label="选择模型与思考等级"]'), form?.querySelector('[aria-label="发送消息"]')].filter(Boolean).map((node) => node.getBoundingClientRect().top);
        return Boolean(form && git && full && modelDetails && buttons.length === 4) && getComputedStyle(full).display === 'none' && getComputedStyle(modelDetails).display !== 'none' && Math.max(...buttons) - Math.min(...buttons) <= 2;
      })()`,
      '443px 移动端输入区单行布局',
      () => serverOutput
    )
    await assertComposerMobileLayout(client, 443)
    composerMobileCapture = await screenshot(client)

    await setViewport(client, 390, 844, true)
    await waitFor(
      client,
      `(() => {
        const full = document.querySelector('[data-work-id="${workId}"] [data-git-branch-full]');
        const modelDetails = document.querySelector('[data-work-id="${workId}"] [data-model-trigger-details]');
        const controls = ['[aria-label="添加图片"]', '[data-testid="composer-git-branch"]', '[aria-label="选择模型与思考等级"]', '[aria-label="发送消息"]'].map((selector) => document.querySelector('[data-work-id="${workId}"] ' + selector)?.getBoundingClientRect().top).filter((top) => typeof top === 'number');
        return full && modelDetails && getComputedStyle(full).display === 'none' && getComputedStyle(modelDetails).display !== 'none' && controls.length === 4 && Math.max(...controls) - Math.min(...controls) <= 2;
      })()`,
      '390px 移动端 Git 优先图标化',
      () => serverOutput
    )
    await waitFor(
      client,
      `document.querySelector('[aria-label="显示工作会话菜单"]') !== null`,
      '移动端工作台',
      () => serverOutput
    )
    await evaluate(client, `document.querySelector('[aria-label="显示工作会话菜单"]')?.click()`)
    await waitFor(
      client,
      `document.querySelector('[data-testid="project-git-repository-root"]')?.getBoundingClientRect().left >= 0`,
      '移动端仓库抽屉',
      () => serverOutput
    )
    mobileCapture = await screenshot(client)
    await evaluate(client, `document.querySelector('[aria-label="关闭工作会话菜单"]')?.click()`)
    await waitFor(
      client,
      `document.querySelector('[data-testid="project-git-repository-root"]')?.getBoundingClientRect().right <= 0`,
      '关闭移动端仓库抽屉',
      () => serverOutput
    )
    await evaluate(client, `document.querySelector('[data-testid="composer-git-branch"]')?.click()`)
    await waitFor(
      client,
      `document.querySelector('[data-testid="git-branch-picker-repository-C"]') !== null`,
      '移动端 Git 仓库列表',
      () => serverOutput
    )
    await evaluate(
      client,
      `document.querySelector('[data-testid="git-branch-picker-repository-C"]')?.click()`
    )
    await waitFor(
      client,
      `document.querySelector('[data-testid="git-branch-local-develop"]') !== null`,
      '移动端 C 分支详情',
      () => serverOutput
    )
    const mobileDialog = await evaluate(
      client,
      `(() => {
        const dialog = document.querySelector('[data-testid="git-branch-picker"]');
        if (!(dialog instanceof HTMLElement)) return null;
        const rect = dialog.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      })()`
    )
    assert.ok(mobileDialog, '移动端分支面板不存在')
    assert.ok(Math.abs(mobileDialog.left - 16) <= 1, JSON.stringify(mobileDialog))
    assert.ok(Math.abs(mobileDialog.right - 374) <= 1, JSON.stringify(mobileDialog))
    assert.ok(Math.abs(mobileDialog.height - 640) <= 2, JSON.stringify(mobileDialog))
    assert.ok(
      Math.abs((mobileDialog.top + mobileDialog.bottom) / 2 - 422) <= 1,
      JSON.stringify(mobileDialog)
    )
    mobileBranchesCapture = await screenshot(client)

    await publishScreenshots([
      [desktopDirectoryFirstOutput, directoryFirstCapture],
      [desktopRepositoryOutput, repositoryCapture],
      [desktopDiffOutput, diffCapture],
      [desktopBranchesOutput, branchCapture],
      [mobileOutput, mobileCapture],
      [mobileBranchesOutput, mobileBranchesCapture],
      [composerDesktopSingleRunOutput, composerDesktopSingleCapture],
      [composerDesktopRunOutput, composerDesktopCapture],
      [composerMobileRunOutput, composerMobileCapture]
    ])
  } catch (error) {
    await mkdir(failureRoot, { recursive: true })
    await writeFile(
      join(failureRoot, 'error.txt'),
      error instanceof Error ? `${error.stack ?? error.message}\n` : String(error),
      'utf8'
    )
    if (client) {
      const evidence = await evaluate(
        client,
        `({ settled: window.__piDeskGitGetSettled, settledCount: window.__piDeskGitGetSettledCount, errors: window.__piDeskE2eErrors ?? [], body: document.body.innerText })`
      )
      await writeFile(join(failureRoot, 'browser.json'), JSON.stringify(evidence, null, 2), 'utf8')
      const image = await client.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true
      })
      await writeFile(join(failureRoot, 'failure.png'), Buffer.from(image.data, 'base64'))
    }
    await writeFile(join(failureRoot, 'server.log'), serverOutput, 'utf8')
    throw error
  } finally {
    client?.close()
    await stopBrowserTree(browserProcess, cdpPort)
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
    await rm(testRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
