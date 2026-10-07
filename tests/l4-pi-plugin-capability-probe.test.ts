import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { runL4PiPluginCapabilityProbe } from '../src/server/l4_foundation/pi/l4-pi-plugin-capability-probe'
import { terminateL4PiProcessTree } from '../src/server/l4_foundation/pi/l4-pi-process-tree'

const execFileAsync = promisify(execFile)
const testRoot = resolve('temp', 'pi', 'plugin-capability-probe-test', String(process.pid))

async function processExists(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`
      ],
      { windowsHide: true, timeout: 5_000 }
    )
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) return false
    throw error
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (!(await processExists(pid))) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 40))
  }
  assert.fail(`Native probe子孙进程仍存活：${pid}`)
}

async function waitForFile(path: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await readFile(path, 'utf8')
      return
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 40))
    }
  }
  assert.fail(`等待Native probe子进程fixture启动超时：${path}`)
}

function childProcessExtension(input: {
  childPidFile: string
  agentDirMarker: string
  sessionDirMarker: string
  failSessionStart: boolean
  hangSessionStart?: boolean
}): string {
  const onSessionStart = input.hangSessionStart
    ? `return new Promise(() => {})`
    : input.failSessionStart
      ? `throw new Error('fixture session_start failed')`
      : `return undefined`
  return `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
export default function probeChildFixture(pi) {
  pi.on('session_start', () => {
    writeFileSync(${JSON.stringify(input.agentDirMarker)}, process.env.PI_CODING_AGENT_DIR ?? '')
    writeFileSync(${JSON.stringify(input.sessionDirMarker)}, process.env.PI_CODING_AGENT_SESSION_DIR ?? '')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    writeFileSync(${JSON.stringify(input.childPidFile)}, String(child.pid))
    child.unref()
    ${onSessionStart}
  })
}
`
}

test('能力探针按 Package 归属动态 Tool、系统提示词元数据和资源', async (context) => {
  const agentDir = join(testRoot, 'agent')
  const cwd = join(testRoot, 'project')
  const packageRoot = join(testRoot, 'fixture-package')
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(join(packageRoot, 'skills', 'fixture-skill'), { recursive: true })
  await mkdir(join(packageRoot, 'prompts'), { recursive: true })
  context.after(() => rm(testRoot, { recursive: true, force: true }))

  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ packages: [packageRoot] }),
    'utf8'
  )
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'fixture-capability-package',
      version: '1.0.0',
      type: 'module',
      pi: {
        extensions: ['./extension.mjs'],
        skills: ['./skills'],
        prompts: ['./prompts']
      }
    }),
    'utf8'
  )
  await writeFile(
    join(packageRoot, 'extension.mjs'),
    `import { Type } from 'typebox'

export default function fixtureCapabilityExtension(pi) {
  pi.registerTool({
    name: 'fixture_static',
    label: 'Fixture Static',
    description: '静态注册工具描述',
    promptSnippet: 'Use fixture_static for capability fixtures',
    promptGuidelines: [
      'Use fixture_static only in the capability probe fixture.',
      'Never use fixture_static outside capability tests.'
    ],
    parameters: Type.Object({ value: Type.String({ description: 'Fixture value' }) }),
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }], details: {} }
    }
  })
  pi.registerCommand('fixture-command', {
    description: 'Fixture command',
    async handler() {}
  })
  pi.on('before_agent_start', () => undefined)
  pi.on('session_start', () => {
    pi.registerTool({
      name: 'fixture_dynamic',
      label: 'Fixture Dynamic',
      description: 'session_start 动态注册工具',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], details: {} }
      }
    })
  })
}
`,
    'utf8'
  )
  await writeFile(
    join(packageRoot, 'skills', 'fixture-skill', 'SKILL.md'),
    `---
name: fixture-skill
description: Fixture Skill 描述
---

# Fixture Skill
`,
    'utf8'
  )
  await writeFile(
    join(packageRoot, 'prompts', 'fixture-review.md'),
    `---
description: Fixture Prompt 描述
---
请审查 fixture。
`,
    'utf8'
  )

  const snapshot = await runL4PiPluginCapabilityProbe(cwd, agentDir)
  assert.equal(snapshot.loadError, null)
  assert.equal(snapshot.packages.length, 1)
  const capability = snapshot.packages[0]
  assert.equal(capability?.source, packageRoot)
  assert.equal(capability?.error, null)
  assert.deepEqual(
    capability?.tools.map((tool) => ({
      name: tool.name,
      state: tool.state,
      promptSnippet: tool.promptSnippet,
      promptGuidelineCount: tool.promptGuidelineCount,
      promptGuidelinePreview: tool.promptGuidelinePreview
    })),
    [
      {
        name: 'fixture_dynamic',
        state: 'active',
        promptSnippet: null,
        promptGuidelineCount: 0,
        promptGuidelinePreview: null
      },
      {
        name: 'fixture_static',
        state: 'active',
        promptSnippet: 'Use fixture_static for capability fixtures',
        promptGuidelineCount: 2,
        promptGuidelinePreview: 'Use fixture_static only in the capability probe fixture.'
      }
    ]
  )
  const staticTool = capability?.tools.find((tool) => tool.name === 'fixture_static')
  assert.deepEqual(staticTool?.parameters, {
    type: 'object',
    properties: { value: { type: 'string', description: 'Fixture value' } },
    required: ['value']
  })
  assert.equal(staticTool?.promptSnippetDetail, 'Use fixture_static for capability fixtures')
  assert.deepEqual(staticTool?.promptGuidelines, [
    'Use fixture_static only in the capability probe fixture.',
    'Never use fixture_static outside capability tests.'
  ])
  assert.deepEqual(capability?.skills, [
    {
      name: 'fixture-skill',
      description: 'Fixture Skill 描述',
      path: 'skills/fixture-skill/SKILL.md',
      filePath: join(packageRoot, 'skills', 'fixture-skill', 'SKILL.md'),
      modelVisible: true
    }
  ])
  assert.deepEqual(capability?.prompts, [
    {
      name: 'fixture-review',
      description: 'Fixture Prompt 描述',
      path: 'prompts/fixture-review.md',
      filePath: join(packageRoot, 'prompts', 'fixture-review.md')
    }
  ])
  assert.deepEqual(capability?.extensions, [
    {
      path: 'extension.mjs',
      events: [
        { name: 'before_agent_start', count: 1 },
        { name: 'session_start', count: 1 }
      ],
      commands: [{ name: 'fixture-command', description: 'Fixture command' }],
      shortcuts: [],
      flags: [],
      messageRenderers: [],
      entryRenderers: []
    }
  ])
})

test('Native probe按独立source归属裸Extension并诊断session_start，清理其子进程', async (context) => {
  const root = testRoot
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'workspace')
  const packageRoot = join(root, 'fixture-package')
  const barePath = join(agentDir, 'extensions', 'bare-fixture.ts')
  const childPidFile = join(root, 'probe-child.pid')
  const agentDirMarker = join(root, 'probe-agent-dir.txt')
  const sessionDirMarker = join(root, 'probe-session-dir.txt')
  const successPath = join(agentDir, 'extensions', 'bare-success.ts')
  const successPidFile = join(root, 'success-child.pid')
  const successAgentDirMarker = join(root, 'success-agent-dir.txt')
  const successSessionDirMarker = join(root, 'success-session-dir.txt')
  await Promise.all([
    mkdir(join(agentDir, 'sessions'), { recursive: true }),
    mkdir(join(agentDir, 'extensions'), { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(packageRoot, { recursive: true })
  ])
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ packages: [packageRoot] }),
    'utf8'
  )
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'm3-package-attribution',
      version: '1.0.0',
      pi: { extensions: ['./package-extension.mjs'] }
    }),
    'utf8'
  )
  await writeFile(
    join(packageRoot, 'package-extension.mjs'),
    `import { Type } from 'typebox'
export default function (pi) {
  pi.registerTool({
    name: 'm3_package_tool',
    label: 'Package tool',
    description: 'Belongs to package only',
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: 'package' }], details: {} }
  }})
  pi.registerCommand('m3-package-command', { description: 'Package command', async handler() {} })
  pi.on('package_event', () => undefined)
}
`,
    'utf8'
  )
  await writeFile(
    barePath,
    childProcessExtension({
      childPidFile,
      agentDirMarker,
      sessionDirMarker,
      failSessionStart: true
    }),
    'utf8'
  )
  await writeFile(
    successPath,
    `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
export default function (pi) {
  pi.registerCommand('m3-bare-success-command', { description: 'Bare source command', async handler() {} })
  pi.on('session_start', () => {
    writeFileSync(${JSON.stringify(successAgentDirMarker)}, process.env.PI_CODING_AGENT_DIR ?? '')
    writeFileSync(${JSON.stringify(successSessionDirMarker)}, process.env.PI_CODING_AGENT_SESSION_DIR ?? '')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    writeFileSync(${JSON.stringify(successPidFile)}, String(child.pid))
    child.unref()
  })
}\n`,
    'utf8'
  )

  const snapshot = await runL4PiPluginCapabilityProbe(cwd, agentDir)
  const packageCapability = snapshot.packages.find((item) => item.source === packageRoot)
  const bareCapability = snapshot.packages.find((item) => item.source === barePath)
  const bareSuccessCapability = snapshot.packages.find((item) => item.source === successPath)
  assert.ok(packageCapability)
  assert.ok(bareCapability)
  assert.ok(bareSuccessCapability)
  assert.deepEqual(
    packageCapability.tools.map((tool) => tool.name),
    ['m3_package_tool']
  )
  assert.deepEqual(
    packageCapability.extensions.flatMap((extension) =>
      extension.commands.map((command) => command.name)
    ),
    ['m3-package-command']
  )
  assert.equal(packageCapability.error, null)
  assert.deepEqual(bareCapability.tools, [])
  assert.match(bareCapability.error ?? '', /fixture session_start failed/)
  assert.equal(await readFile(agentDirMarker, 'utf8'), agentDir)
  assert.equal(await readFile(sessionDirMarker, 'utf8'), join(agentDir, 'sessions'))
  assert.equal(bareSuccessCapability.error, null)
  assert.deepEqual(
    bareSuccessCapability.extensions.flatMap((extension) =>
      extension.commands.map((command) => command.name)
    ),
    ['m3-bare-success-command']
  )
  assert.equal(await readFile(successAgentDirMarker, 'utf8'), agentDir)
  assert.equal(await readFile(successSessionDirMarker, 'utf8'), join(agentDir, 'sessions'))
  const childPid = Number((await readFile(childPidFile, 'utf8')).trim())
  const successChildPid = Number((await readFile(successPidFile, 'utf8')).trim())
  assert.ok(childPid > 0)
  assert.ok(successChildPid > 0)
  await Promise.all([waitForProcessExit(childPid), waitForProcessExit(successChildPid)])
})

test('Native probe对未安装package拒绝盘点且不执行安装', async (context) => {
  const root = testRoot
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'workspace')
  const source = 'npm:@pi-desk-fixture/not-installed-m3-probe'
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  context.after(() => rm(root, { recursive: true, force: true }))
  const settingsPath = join(agentDir, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({ packages: [source] }), 'utf8')

  await assert.rejects(runL4PiPluginCapabilityProbe(cwd, agentDir), /跳过能力盘点以避免隐式安装/)
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { packages: [source] })
  await assert.rejects(
    readFile(join(agentDir, 'npm', '@pi-desk-fixture', 'not-installed-m3-probe', 'package.json'))
  )
})

test(
  'Native probe timeout终止同步阻塞setup产生的子孙进程',
  { timeout: 60_000 },
  async (context) => {
    const root = testRoot
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'workspace')
    const packageRoot = join(root, 'fixture-package')
    const childPidFile = join(root, 'probe-child.pid')
    const agentDirMarker = join(root, 'probe-agent-dir.txt')
    await Promise.all([
      mkdir(join(agentDir, 'sessions'), { recursive: true }),
      mkdir(cwd, { recursive: true }),
      mkdir(packageRoot, { recursive: true })
    ])
    context.after(() => rm(root, { recursive: true, force: true }))
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ packages: [packageRoot] }),
      'utf8'
    )
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'm3-blocked-probe-fixture',
        version: '1.0.0',
        pi: { extensions: ['./extension.ts'] }
      }),
      'utf8'
    )
    await writeFile(
      join(packageRoot, 'extension.ts'),
      `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
export default function blockingProbeFixture() {
  writeFileSync(${JSON.stringify(agentDirMarker)}, process.env.PI_CODING_AGENT_DIR ?? '')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))
  child.unref()
  while (true) {}
}
`,
      'utf8'
    )

    const probing = runL4PiPluginCapabilityProbe(cwd, agentDir)
    const probeError = probing.then(
      () => null,
      (error: unknown) => error
    )
    await Promise.race([
      waitForFile(childPidFile),
      probeError.then((error) => {
        if (error) throw error
        throw new Error('Native probe在子进程fixture启动前完成')
      })
    ])
    assert.equal(await readFile(agentDirMarker, 'utf8'), agentDir)
    await assert.rejects(probing, /插件能力盘点超时/)
    await waitForProcessExit(Number((await readFile(childPidFile, 'utf8')).trim()))
  }
)

test(
  'probe父进程退出时server process-tree adapter终止runner和extension后代',
  { timeout: 30_000 },
  async (context) => {
    const root = testRoot
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'workspace')
    const packageRoot = join(root, 'parent-exit-package')
    const harnessPath = join(root, 'probe-parent.mjs')
    const parentPidFile = join(root, 'parent.pid')
    const probePidFile = join(root, 'probe.pid')
    const extensionPidFile = join(root, 'extension-child.pid')
    const runnerPath = join(
      process.cwd(),
      'src',
      'server',
      'l4_foundation',
      'pi',
      'l4-pi-plugin-capability-probe-runner.mts'
    )
    const spawned = { parent: undefined as ReturnType<typeof spawn> | undefined }
    await Promise.all([
      mkdir(join(agentDir, 'sessions'), { recursive: true }),
      mkdir(cwd, { recursive: true }),
      mkdir(packageRoot, { recursive: true })
    ])
    context.after(async () => {
      const parentProcess = spawned.parent
      if (
        parentProcess?.pid &&
        parentProcess.exitCode === null &&
        parentProcess.signalCode === null
      ) {
        await terminateL4PiProcessTree(parentProcess).catch(() => undefined)
        await waitForProcessExit(parentProcess.pid)
      }
      await rm(root, { recursive: true, force: true })
    })
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ packages: [packageRoot] }),
      'utf8'
    )
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'm3-parent-exit-probe',
        version: '1.0.0',
        pi: { extensions: ['./extension.ts'] }
      }),
      'utf8'
    )
    await writeFile(
      join(packageRoot, 'extension.ts'),
      `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
export default function parentExitProbeFixture() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  writeFileSync(${JSON.stringify(extensionPidFile)}, String(child.pid))
  child.unref()
  while (true) {}
}
`,
      'utf8'
    )
    await writeFile(
      harnessPath,
      `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', ${JSON.stringify(runnerPath)}], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'ignore',
  windowsHide: true
})
writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid))
writeFileSync(${JSON.stringify(probePidFile)}, String(child.pid))
child.unref()
setInterval(() => {}, 1000)
`,
      'utf8'
    )
    spawned.parent = spawn(process.execPath, [harnessPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
        PI_DESK_PLUGIN_CAPABILITY_AGENT_DIR: agentDir,
        PI_DESK_PLUGIN_CAPABILITY_CWD: cwd
      },
      stdio: 'ignore',
      windowsHide: true,
      detached: process.platform !== 'win32'
    })

    const parentProcess = spawned.parent
    assert.ok(parentProcess)
    const parentProcessId = parentProcess.pid
    assert.ok(parentProcessId)
    await Promise.all(
      [parentPidFile, probePidFile, extensionPidFile].map((path) => waitForFile(path))
    )
    const pids = await Promise.all(
      [parentPidFile, probePidFile, extensionPidFile].map(async (path) =>
        Number((await readFile(path, 'utf8')).trim())
      )
    )
    assert.ok(pids.every((pid) => pid > 0))
    await terminateL4PiProcessTree(parentProcess)
    await Promise.all([...pids, parentProcessId].map(waitForProcessExit))
  }
)
