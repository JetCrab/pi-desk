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
  // 父进程已退出时 taskkill /T 找不到它；原生快照避免 CIM/WMI 查询阻塞。
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    `$rootPid = ${pid}`,
    String.raw`Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class PiDeskProcessSnapshot
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public UIntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string Executable;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static Dictionary<int, int> ReadParents()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1))
        {
            throw new Win32Exception();
        }
        try
        {
            ProcessEntry entry = new ProcessEntry();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            if (!Process32FirstW(snapshot, ref entry))
            {
                throw new Win32Exception();
            }
            Dictionary<int, int> parents = new Dictionary<int, int>();
            do
            {
                parents.Add((int)entry.ProcessId, (int)entry.ParentProcessId);
            }
            while (Process32NextW(snapshot, ref entry));
            if (Marshal.GetLastWin32Error() != 18)
            {
                throw new Win32Exception();
            }
            return parents;
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }
}
'@
`,
    '$all = [PiDeskProcessSnapshot]::ReadParents()',
    '$root = Get-Process -Id $rootPid -ErrorAction SilentlyContinue',
    'if ($root -and -not $root.HasExited) { throw "Managed PID is still present; refusing orphan cleanup" }',
    '$ids = [System.Collections.Generic.HashSet[int]]::new()',
    '[void]$ids.Add($rootPid)',
    '$descendants = [System.Collections.Generic.List[int]]::new(); $created = @{}',
    String.raw`do {
    $added = $false
    foreach ($item in $all.GetEnumerator()) {
        if ($ids.Contains($item.Value) -and $ids.Add($item.Key)) {
            $descendants.Add($item.Key)
            $p = Get-Process -Id $item.Key -ErrorAction SilentlyContinue
            if ($p -and -not $p.HasExited) {
                $created[$item.Key] = $p.StartTime
            }
            $added = $true
        }
    }
} while ($added)`,
    String.raw`for ($i = $descendants.Count - 1; $i -ge 0; $i--) {
    $pidToStop = $descendants[$i]
    if (-not $created.ContainsKey($pidToStop)) {
        continue
    }
    $p = Get-Process -Id $pidToStop -ErrorAction SilentlyContinue
    if ($p -and -not $p.HasExited) {
        if ([Math]::Abs(($p.StartTime.ToUniversalTime() - $created[$pidToStop].ToUniversalTime()).TotalSeconds) -gt 1) {
            throw "PID identity changed; refusing cleanup"
        }
        try {
            $p.Kill()
            if (-not $p.WaitForExit(5000)) {
                throw "Managed descendant did not exit"
            }
        } catch {
            if (-not $p.HasExited) {
                throw
            }
        }
    }
}`
  ].join('; ')
  try {
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
  } catch (error) {
    throw new Error(
      `清理 Windows 孤儿进程失败：rootPid=${pid}，code=${error.code}，signal=${error.signal ?? '无'}，超时终止=${error.killed === true}；${error.stderr?.trim() ?? ''}`,
      { cause: error }
    )
  }
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
