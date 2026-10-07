'use strict'

// CLI、服务端与隔离探针共用的原生 Node 实现，不依赖 Next 的 react-server 导出条件。
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execFileAsync = promisify(execFile)

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  try {
    process.kill(child.pid, 0)
    return false
  } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
}

async function stopWindowsOrphans(pid) {
  // 父进程已退出时 taskkill /T 找不到它；只追踪该 PID 留下的子孙链。
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    `$rootPid = ${pid}`,
    '$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)',
    '$root = Get-Process -Id $rootPid -ErrorAction SilentlyContinue',
    'if ($root -and -not $root.HasExited) { throw "Managed PID is still present; refusing orphan cleanup" }',
    '$ids = [System.Collections.Generic.HashSet[int]]::new()',
    '[void]$ids.Add($rootPid)',
    '$descendants = [System.Collections.Generic.List[int]]::new(); $created = @{}',
    'do { $added = $false; foreach ($item in $all) { if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $descendants.Add([int]$item.ProcessId); $created[[int]$item.ProcessId] = $item.CreationDate; $added = $true } } } while ($added)',
    'for ($i = $descendants.Count - 1; $i -ge 0; $i--) { $pidToStop = $descendants[$i]; $p = Get-Process -Id $pidToStop -ErrorAction SilentlyContinue; if ($p -and -not $p.HasExited) { if ($created[$pidToStop] -and [Math]::Abs(($p.StartTime.ToUniversalTime() - $created[$pidToStop].ToUniversalTime()).TotalSeconds) -gt 1) { throw "PID identity changed; refusing cleanup" }; try { $p.Kill(); if (-not $p.WaitForExit(5000)) { throw "Managed descendant did not exit" } } catch { if (-not $p.HasExited) { throw } } } }'
  ].join('; ')
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    }
  )
}

async function terminateManagedTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    if (!exited(child)) {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 1024 * 1024
        })
        return
      } catch (error) {
        if (!exited(child)) throw error
      }
    }
    await stopWindowsOrphans(child.pid)
    return
  }

  // 托管服务与维护命令均以自己的进程组启动，不终止 CLI 所在进程组。
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

module.exports = { terminateManagedTree }
