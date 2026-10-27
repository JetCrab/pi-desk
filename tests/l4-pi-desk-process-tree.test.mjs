import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { terminateManagedTree } = require('../src/server/l4_foundation/process/l4-process-tree.js')
const execFileAsync = promisify(execFile)
const testRoot = resolve('temp/tests/pi-desk-process-tree', String(process.pid))
const spawnedRoots = new Set()
const spawnedChildren = new Set()
// 原生清理包含快照、身份复核及逐 PID 终止；外层仍需容纳准备、观察及 after 清理。
const windowsTreeBudget = {
  prepare: 5_000,
  terminate: 2 * 15_000,
  observe: 5_000,
  cleanup: 2 * 15_000
}
const windowsTreeTimeout = Object.values(windowsTreeBudget).reduce((sum, value) => sum + value, 0)

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function withTimeout(promise, label, timeoutMs = 5_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}等待超时`)), timeoutMs)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function waitForFile(path, label, deadline) {
  while (Date.now() < deadline) {
    try {
      await readFile(path, 'utf8')
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await delay(20)
    }
  }
  throw new Error(`${label}等待超时`)
}

async function spawnProcessTree(mode, root) {
  const rootPidFile = join(root, 'root.pid')
  const childPidFile = join(root, 'child.pid')
  const childHeartbeatFile = join(root, 'child.heartbeat')
  const childScript = `
    const fs = require('node:fs')
    setInterval(() => fs.appendFileSync(${JSON.stringify(childHeartbeatFile)}, 'x'), 50)
  `
  const rootScript = `
    const fs = require('node:fs')
    const { spawn } = require('node:child_process')
    const mode = ${JSON.stringify(mode)}
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {
      stdio: 'ignore', windowsHide: true, detached: mode === 'orphan'
    })
    fs.writeFileSync(${JSON.stringify(rootPidFile)}, String(process.pid))
    child.once('spawn', () => {
      fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))
      if (mode === 'orphan') {
        child.unref()
        setImmediate(() => process.exit(0))
      } else {
        setInterval(() => {}, 1000)
      }
    })
  `
  const deadline = Date.now() + windowsTreeBudget.prepare
  const rootChild = spawn(process.execPath, ['-e', rootScript], {
    stdio: 'ignore',
    windowsHide: true
  })
  spawnedRoots.add(rootChild)
  await waitForFile(rootPidFile, `${mode} root PID`, deadline)
  await waitForFile(childPidFile, `${mode} child PID`, deadline)
  const childPid = Number((await readFile(childPidFile, 'utf8')).trim())
  spawnedChildren.add(childPid)
  return {
    rootChild,
    rootPid: Number((await readFile(rootPidFile, 'utf8')).trim()),
    childPid,
    childHeartbeatFile
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function runWindowsSnapshotFixture({
  rows,
  live = false,
  bare = false,
  rootIsHelper = false
}) {
  const source = await readFile(
    new URL('../src/server/l4_foundation/process/l4-process-tree.js', import.meta.url),
    'utf8'
  )
  const runtime = { exports: {} }
  let result
  const execute = () => {}
  execute[promisify.custom] = async (file, args, options) => {
    assert.equal(file, 'powershell.exe', '合成回归禁止执行 taskkill 或其他清理命令')
    const index = args.indexOf('-EncodedCommand') + 1
    let script = Buffer.from(args[index], 'base64').toString('utf16le')
    if (rootIsHelper) script = script.replace('$rootPid = 111', '$rootPid = $PID')
    const snapshot = '$all = [PiDeskProcessSnapshot]::ReadParents()'
    assert.equal(script.split(snapshot).length, 2)
    const nativeOpen = '[PiDeskProcessSnapshot]::Open($processId)'
    assert.equal(script.split(nativeOpen).length, 2)
    const fixture = `
$script:rows = @{}
$script:reads = @{}
$script:kills = [System.Collections.Generic.List[int]]::new()
$parents = [System.Collections.Generic.Dictionary[int,int]]::new()
$data = ConvertFrom-Json '${JSON.stringify(rows)}'
foreach ($row in $data) {
    $id = if ($row[0] -eq 'helper') { $PID } else { [int]$row[0] }
    $parents.Add($id, [int]$row[1])
    $script:rows[$id] = @($row[2])
}
function Get-Process { throw '测试禁止调用 Get-Process cmdlet' }
function Open-FakeProcess {
    param([int]$Id)
    if (-not $script:rows.ContainsKey($Id)) { return }
    $read = [int]$script:reads[$Id]
    $script:reads[$Id] = $read + 1
    $times = $script:rows[$Id]
    $ticks = $times[[Math]::Min($read, $times.Count - 1)]
    $p = [PSCustomObject]@{ Id = $Id; HasExited = $false; StartTicks = $null }
    if ($null -ne $ticks) { $p.StartTicks = [long]$ticks }
    $p | Add-Member -MemberType ScriptMethod -Name Kill -Value {
        [void]$script:kills.Add([int]$this.Id)
        $this.HasExited = $true
    }
    $p | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($ms) return $true }
    $p | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
    return $p
}
$failure = $null
try { ${script.replace(snapshot, '$all = $parents').replace(nativeOpen, 'Open-FakeProcess $processId')} } catch { $failure = $_.Exception.Message }
[Console]::Out.WriteLine((@{ kills = @($script:kills | ForEach-Object { [int]$_ }); error = $failure } | ConvertTo-Json -Compress))
`
    const encoded = [...args]
    encoded[index] = Buffer.from(fixture, 'utf16le').toString('base64')
    const output = await execFileAsync(file, encoded, options)
    result = JSON.parse(output.stdout.trim().split(/\r?\n/).at(-1))
    return output
  }
  runInNewContext(source, {
    module: runtime,
    Buffer,
    process: { platform: 'win32', pid: 222, kill() {} },
    require(name) {
      return name === 'node:child_process' ? { execFile: execute } : require(name)
    }
  })
  await runtime.exports.terminateManagedTree(
    bare ? { pid: 111 } : { pid: 111, exitCode: live ? null : 0, signalCode: null }
  )
  return result
}

test(
  'Windows合成快照保护owner、祖先、helper并严格校验父子代际',
  { skip: process.platform !== 'win32', timeout: windowsTreeTimeout },
  async (t) => {
    const owner = [222, 900, [100_000]]
    const ancestor = [900, 0, [90_000]]
    for (const fixture of [
      {
        name: '旧PPID命中owner时不清理owner及其分支',
        rows: [
          [222, 111, [100_000]],
          [333, 222, [110_000]]
        ],
        kills: []
      },
      {
        name: '旧PPID命中祖先时不清理祖先及其分支',
        rows: [owner, [900, 111, [90_000]], [333, 900, [110_000]]],
        kills: []
      },
      {
        name: '早于owner的旧代际不作为后续分支的归属证据',
        rows: [owner, ancestor, [333, 111, [99_999]], [444, 333, [120_000]]],
        kills: []
      },
      {
        name: '子进程比父进程更早时排除整条旧代际分支',
        rows: [
          owner,
          ancestor,
          [333, 111, [110_000]],
          [444, 333, [109_999]],
          [555, 444, [120_000]]
        ],
        kills: [333]
      },
      {
        name: '父子创建时间相等时不扩展该分支',
        rows: [
          owner,
          ancestor,
          [333, 111, [110_000]],
          [444, 333, [110_000]],
          [555, 444, [120_000]]
        ],
        kills: [333]
      },
      {
        name: '合法孤儿按子进程先于父进程的顺序清理',
        rows: [owner, ancestor, [333, 111, [110_000]], [444, 333, [120_000]]],
        kills: [444, 333]
      },
      {
        name: 'PID创建时间只变化一个Tick也拒绝终止新代际',
        rows: [owner, ancestor, [333, 111, [110_000, 110_001]]],
        kills: [],
        error: /PID identity changed/
      },
      {
        name: '真实范围的64位Ticks变化不能被浮点精度吞掉',
        rows: [
          [222, 900, ['638900000000100000']],
          [900, 0, ['638900000000090000']],
          [333, 111, ['638900000000110000', '638900000000110001']]
        ],
        kills: [],
        error: /PID identity changed/
      },
      {
        name: '创建时间等于owner时也不能进入旧代际分支',
        rows: [owner, ancestor, [333, 111, [100_000]], [444, 333, [120_000]]],
        kills: []
      },
      {
        name: 'owner创建时间无法确认时拒绝全部清理',
        rows: [[222, 900, [null]], ancestor, [333, 111, [110_000]]],
        kills: [],
        error: /creation time unavailable/
      },
      {
        name: '创建时间不可确认的对象不作为归属证据',
        rows: [owner, ancestor, [333, 111, [null]], [444, 333, [120_000]]],
        kills: []
      },
      {
        name: 'helper即使被旧PPID关联也不能加入清理',
        rows: [owner, ancestor, ['helper', 111, [120_000]]],
        kills: []
      },
      {
        name: 'helper复用已退出根PID时拒绝清理',
        rows: [owner, ancestor, ['helper', 222, [120_000]]],
        rootIsHelper: true,
        kills: [],
        error: /Managed PID is still present/
      },
      {
        name: '活root逐PID清理且不沿旧PPID扩选',
        rows: [owner, ancestor, [111, 222, [105_000]], [333, 111, [110_000]], [444, 111, [99_999]]],
        live: true,
        kills: [333, 111]
      },
      {
        name: '活root不是owner直接子进程时拒绝清理',
        rows: [owner, ancestor, [111, 900, [105_000]], [333, 111, [110_000]]],
        live: true,
        kills: [],
        error: /not an owned child/
      },
      {
        name: '裸PID对象缺省退出字段不冒充已退出root',
        rows: [owner, ancestor, [111, 222, [105_000]], [333, 111, [110_000]]],
        bare: true,
        kills: [333, 111]
      }
    ]) {
      await t.test(fixture.name, async () => {
        const result = await runWindowsSnapshotFixture(fixture)
        assert.deepEqual(result.kills, fixture.kills)
        if (fixture.error) assert.match(result.error, fixture.error)
        else assert.equal(result.error, null)
      })
    }
  }
)

test(
  'Windows清理仍存活managed root时终止整棵进程树',
  {
    skip: process.platform !== 'win32',
    timeout: windowsTreeTimeout
  },
  async (context) => {
    const root = join(testRoot, 'live-root')
    await mkdir(root, { recursive: true })
    context.after(async () => {
      for (const child of spawnedRoots) {
        if (child.exitCode === null && child.signalCode === null) {
          await terminateManagedTree(child).catch(() => undefined)
        }
      }
      await rm(root, { recursive: true, force: true })
    })

    const tree = await spawnProcessTree('live', root)
    const exit = once(tree.rootChild, 'exit')
    await terminateManagedTree(tree.rootChild)
    await withTimeout(exit, 'live root exit')
    assert.equal(await processExists(tree.rootPid), false)
    assert.equal(await processExists(tree.childPid), false)
  }
)

test(
  'Windows root先退出时按旧ParentProcessId清理仍存活的孙进程',
  {
    skip: process.platform !== 'win32',
    timeout: windowsTreeTimeout
  },
  async (context) => {
    const root = join(testRoot, 'orphan-root')
    await mkdir(root, { recursive: true })
    context.after(async () => {
      for (const child of spawnedRoots) {
        if (child.exitCode === null && child.signalCode === null) {
          await terminateManagedTree(child).catch(() => undefined)
        }
      }
      await rm(root, { recursive: true, force: true })
    })

    const tree = await spawnProcessTree('orphan', root)
    if (tree.rootChild.exitCode === null && tree.rootChild.signalCode === null) {
      await withTimeout(once(tree.rootChild, 'exit'), 'orphan root exit')
    }
    assert.equal(await processExists(tree.rootPid), false)
    assert.equal(await processExists(tree.childPid), true)
    await terminateManagedTree(tree.rootChild)
    const deadline = Date.now() + windowsTreeBudget.observe
    while (processExists(tree.childPid) && Date.now() < deadline) await delay(25)
    assert.equal(await processExists(tree.childPid), false)
  }
)

test(
  'Windows已退出且没有子进程的命令可以正常完成清理',
  { skip: process.platform !== 'win32', timeout: windowsTreeTimeout },
  async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      windowsHide: true
    })
    spawnedRoots.add(child)
    await withTimeout(once(child, 'exit'), 'leaf command exit')
    await terminateManagedTree(child)
    assert.equal(await processExists(child.pid), false)
  }
)

test(
  'Windows孤儿进程清理不依赖Get-Process、CIM或WMI查询',
  { skip: process.platform !== 'win32', timeout: windowsTreeTimeout },
  async (context) => {
    const source = await readFile(
      new URL('../src/server/l4_foundation/process/l4-process-tree.js', import.meta.url),
      'utf8'
    )
    const runtime = { exports: {} }
    runInNewContext(source, {
      module: runtime,
      process,
      Buffer,
      require(name) {
        if (name !== 'node:child_process') return require(name)
        return {
          execFile(file, args, options, callback) {
            if (file === 'powershell.exe') {
              const index = args.indexOf('-EncodedCommand') + 1
              const script = Buffer.from(args[index], 'base64').toString('utf16le')
              args = [...args]
              args[index] = Buffer.from(
                `function Get-Process { throw '测试禁止调用 Get-Process cmdlet' }; function Get-CimInstance { throw '测试禁止依赖 CIM/WMI 查询' }; ${script}`,
                'utf16le'
              ).toString('base64')
            }
            return execFile(file, args, options, callback)
          }
        }
      }
    })
    const root = join(testRoot, 'without-cim')
    await mkdir(root, { recursive: true })
    context.after(() => rm(root, { recursive: true, force: true }))
    const tree = await spawnProcessTree('orphan', root)
    if (tree.rootChild.exitCode === null && tree.rootChild.signalCode === null) {
      await withTimeout(once(tree.rootChild, 'exit'), 'non-CIM root exit')
    }
    assert.equal(await processExists(tree.childPid), true)
    await runtime.exports.terminateManagedTree(tree.rootChild)
    assert.equal(await processExists(tree.childPid), false)
  }
)

test(
  'Windows孤儿清理拒绝仍存活的根PID并保留其子进程',
  { skip: process.platform !== 'win32', timeout: windowsTreeTimeout },
  async (context) => {
    const root = join(testRoot, 'root-identity')
    await mkdir(root, { recursive: true })
    context.after(() => rm(root, { recursive: true, force: true }))
    const tree = await spawnProcessTree('live', root)
    try {
      await assert.rejects(
        terminateManagedTree({ pid: tree.rootPid, exitCode: 0, signalCode: null }),
        /Managed PID is still present; refusing orphan cleanup/
      )
      assert.equal(await processExists(tree.rootPid), true)
      assert.equal(await processExists(tree.childPid), true)
    } finally {
      await terminateManagedTree(tree.rootChild)
    }
  }
)

test(
  'Windows原生终止遇到已开始退出的进程时等待句柄释放',
  { skip: process.platform !== 'win32', timeout: windowsTreeTimeout },
  async () => {
    const source = await readFile(
      new URL('../src/server/l4_foundation/process/l4-process-tree.js', import.meta.url),
      'utf8'
    )
    let script
    const execute = () => {}
    execute[promisify.custom] = async (_file, args) => {
      script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
      return { stdout: '', stderr: '' }
    }
    const runtime = { exports: {} }
    runInNewContext(source, {
      module: runtime,
      Buffer,
      process: { platform: 'win32', pid: 222 },
      require(name) {
        return name === 'node:child_process' ? { execFile: execute } : require(name)
      }
    })
    await runtime.exports.terminateManagedTree({ pid: 111, exitCode: null, signalCode: null })
    let native = script.match(/Add-Type -TypeDefinition @'\n([\s\S]*?)\n'@/)[1]
    const replacements = [
      [
        /\[DllImport\("kernel32.dll"\)\]\s*private static extern bool CloseHandle\(IntPtr handle\);/,
        'private static bool CloseHandle(IntPtr handle) { return true; }'
      ],
      [
        /\[DllImport\("kernel32.dll", SetLastError = true\)\]\s*private static extern IntPtr OpenProcess\(uint access, bool inheritHandle, int processId\);/,
        'private static IntPtr OpenProcess(uint access, bool inheritHandle, int processId) { return new IntPtr(1); }'
      ],
      [
        /\[DllImport\("kernel32.dll", SetLastError = true\)\]\s*private static extern bool TerminateProcess\(IntPtr handle, uint exitCode\);/,
        'private static bool TerminateProcess(IntPtr handle, uint exitCode) { SetFixtureLastError(5); return false; }\n[DllImport("kernel32.dll", EntryPoint = "SetLastError", SetLastError = true)] private static extern void SetFixtureLastError(uint error);'
      ],
      [
        /\[DllImport\("kernel32.dll", SetLastError = true\)\]\s*private static extern uint WaitForSingleObject\(IntPtr handle, uint milliseconds\);/,
        'public static bool CompletesExit;\nprivate static uint WaitForSingleObject(IntPtr handle, uint milliseconds) { return milliseconds > 0 && CompletesExit ? 0u : 258u; }'
      ]
    ]
    for (const [pattern, replacement] of replacements) {
      assert.match(native, pattern)
      native = native.replace(pattern, replacement)
    }
    const command = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
${native}
'@
$results = @(foreach ($complete in @($true, $false)) {
    [PiDeskProcessSnapshot]::CompletesExit = $complete
    $p = [PiDeskProcessSnapshot]::Open(111)
    $failure = $null
    try { $p.Kill() } catch { $failure = $_.Exception.InnerException.Message } finally { $p.Dispose() }
    @{ error = $failure }
})
[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $results))
`
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64')
      ],
      { windowsHide: true, timeout: 15_000 }
    )
    const results = JSON.parse(stdout.trim())
    assert.equal(results[0].error, null, 'ERROR_ACCESS_DENIED 后句柄完成退出应视为已释放')
    assert.match(results[1].error, /pid=111/, '句柄仍未退出时必须保留失败与具体 PID')
  }
)

test('Windows孤儿清理失败保留执行阶段、耗时及底层异常', async () => {
  const source = await readFile(
    new URL('../src/server/l4_foundation/process/l4-process-tree.js', import.meta.url),
    'utf8'
  )
  const failure = Object.assign(new Error('受控 PowerShell 超时'), {
    code: null,
    signal: 'SIGTERM',
    killed: true,
    stdout: 'powershell-ready: 0ms\n',
    stderr: '受控编译阻塞'
  })
  const runtime = { exports: {} }
  runInNewContext(source, {
    module: runtime,
    process: { platform: 'win32' },
    Buffer,
    require(name) {
      if (name !== 'node:child_process') return require(name)
      return {
        execFile(_file, _args, options, callback) {
          assert.equal(options.timeout, 15_000, '原生清理预算保持独立，不由外层提前取消')
          queueMicrotask(() => callback(failure))
        }
      }
    }
  })
  await assert.rejects(
    runtime.exports.terminateManagedTree({ pid: 123, exitCode: 0, signalCode: null }),
    (error) => {
      assert.equal(error.cause, failure)
      assert.match(error.message, /rootPid=123/)
      assert.match(error.message, /超时终止=true/)
      assert.match(error.message, /耗时=\d+ms/)
      assert.match(error.message, /powershell-ready: 0ms/)
      assert.match(error.message, /受控编译阻塞/)
      return true
    }
  )
})

test('Linux进程组清理等待活动进程退出，僵尸不当作运行进程', async (t) => {
  const source = await readFile(
    new URL('../src/server/l4_foundation/process/l4-process-tree.js', import.meta.url),
    'utf8'
  )
  for (const [label, states, rejects] of [
    ['延迟退出', ['123 S', '123 Z', ''], false],
    ['已经退出', ['123 Z'], false],
    ['持续活动', ['123 S'], true]
  ]) {
    await t.test(label, async () => {
      let clock = 0
      let reads = 0
      const signals = []
      const runtime = { exports: {} }
      const execute = () => {}
      execute[promisify.custom] = async () => ({
        stdout: states[Math.min(reads++, states.length - 1)]
      })
      runInNewContext(source, {
        module: runtime,
        Buffer,
        process: { platform: 'linux', kill: (pid, signal) => signals.push([pid, signal]) },
        require(name) {
          if (name === 'node:child_process') return { execFile: execute }
          if (name === 'node:perf_hooks') return { performance: { now: () => clock } }
          if (name === 'node:timers/promises')
            return {
              setTimeout: async () => {
                clock += 1000
              }
            }
          return require(name)
        }
      })
      const stopping = runtime.exports.terminateManagedTree({ pid: 123 })
      if (rejects) await assert.rejects(stopping, /仍未退出.*123/)
      else await stopping
      assert.ok(signals.length > 0)
      assert.ok(signals.every(([pid, signal]) => pid === -123 && signal === 'SIGKILL'))
      if (label === '延迟退出') assert.ok(reads >= 2, '发出信号后仍活动就继续等待和终止')
      assert.ok(clock <= 5000, '清理总等待有界')
    })
  }
})

test.after(async () => {
  const descendantsRemain = [...spawnedChildren].some(processExists)
  for (const child of spawnedRoots) {
    if (descendantsRemain || (child.exitCode === null && child.signalCode === null)) {
      await terminateManagedTree(child)
    }
  }
  for (const pid of spawnedChildren) {
    assert.equal(processExists(pid), false, `隔离测试子进程未释放：${pid}`)
  }
  await rm(testRoot, { recursive: true, force: true })
})
