'use strict'

// CLI、服务端与隔离探针共用的原生 Node 实现，不依赖 Next 的 react-server 导出条件。
const { execFile } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')
const { promisify } = require('node:util')
const execFileAsync = promisify(execFile)

async function stopWindowsTree(child) {
  const pid = child.pid
  // /T 无法限定旧 PPID 的代际；存活根与孤儿统一按验证后的 PID 逐个终止。
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    `$rootPid = ${pid}`,
    `$ownerPid = ${process.pid}`,
    `$rootExited = $${child.exitCode != null || child.signalCode != null}`,
    '$clock = [System.Diagnostics.Stopwatch]::StartNew()',
    '[Console]::Out.WriteLine("powershell-ready: $($clock.ElapsedMilliseconds)ms")',
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
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr handle, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr handle, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
    }

    public sealed class ManagedProcess : IDisposable
    {
        private IntPtr handle;
        private readonly int processId;

        internal ManagedProcess(IntPtr handle, int processId)
        {
            this.handle = handle;
            this.processId = processId;
        }

        public long StartTicks
        {
            get
            {
                FileTime created, exited, kernel, user;
                if (!GetProcessTimes(handle, out created, out exited, out kernel, out user))
                {
                    throw new Win32Exception();
                }
                long fileTime = ((long)created.High << 32) | created.Low;
                return DateTime.FromFileTimeUtc(fileTime).Ticks;
            }
        }

        public bool HasExited
        {
            get
            {
                return WaitForExit(0);
            }
        }

        public void Kill()
        {
            if (!TerminateProcess(handle, 1))
            {
                int error = Marshal.GetLastWin32Error();
                // 已进入终止的进程也可能返回 ACCESS_DENIED，此时等待同一句柄完成退出。
                if (!HasExited && (error != 5 || !WaitForExit(5000)))
                {
                    throw new Win32Exception(error, "终止进程失败：pid=" + processId + "，Win32=" + error);
                }
            }
        }

        public bool WaitForExit(int milliseconds)
        {
            uint result = WaitForSingleObject(handle, (uint)milliseconds);
            if (result == 0)
            {
                return true;
            }
            if (result == 258)
            {
                return false;
            }
            throw new Win32Exception();
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero)
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
            }
        }
    }

    public static ManagedProcess Open(int processId)
    {
        // QUERY_LIMITED_INFORMATION | SYNCHRONIZE | TERMINATE；同一持有句柄用于查询与终止。
        IntPtr handle = OpenProcess(0x101001, false, processId);
        if (handle == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error == 87)
            {
                return null;
            }
            throw new Win32Exception(error);
        }
        return new ManagedProcess(handle, processId);
    }

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
    '[Console]::Out.WriteLine("snapshot-compiled: $($clock.ElapsedMilliseconds)ms")',
    '$all = [PiDeskProcessSnapshot]::ReadParents()',
    '[Console]::Out.WriteLine("snapshot-read: $($clock.ElapsedMilliseconds)ms")',
    'function Open-ManagedProcess($processId) { [PiDeskProcessSnapshot]::Open($processId) }',
    String.raw`function Read-CreationTicks($p) {
    if (-not $p -or $p.HasExited) { throw "Process has exited" }
    $ticks = $p.StartTicks
    if ($null -eq $ticks -or $ticks -le 0) { throw "Process creation time unavailable" }
    return [long]$ticks
}`,
    '$owner = Open-ManagedProcess $ownerPid',
    'try { $ownerTicks = Read-CreationTicks $owner } finally { if ($owner) { $owner.Dispose() } }',
    '$protected = [System.Collections.Generic.HashSet[int]]::new()',
    '$ancestor = $ownerPid',
    String.raw`while ($protected.Add($ancestor)) {
    if (-not $all.ContainsKey($ancestor)) { break }
    $ancestor = $all[$ancestor]
}`,
    '[void]$protected.Add($PID)',
    '$ids = [System.Collections.Generic.HashSet[int]]::new()',
    '[void]$ids.Add($rootPid)',
    '$descendants = [System.Collections.Generic.List[int]]::new(); $created = @{}',
    '$root = Open-ManagedProcess $rootPid',
    String.raw`try {
    if ($root -and -not $root.HasExited) {
        if ($rootExited) { throw "Managed PID is still present; refusing orphan cleanup" }
        if ($protected.Contains($rootPid) -or -not $all.ContainsKey($rootPid) -or $all[$rootPid] -ne $ownerPid) {
            throw "Managed root is not an owned child; refusing cleanup"
        }
        $rootTicks = Read-CreationTicks $root
        if ($rootTicks -le $ownerTicks) { throw "Managed root predates owner; refusing cleanup" }
        $created[$rootPid] = $rootTicks
        $descendants.Add($rootPid)
    } else {
        # 已退出根没有可查询的创建时间，只能以仍存活 owner 的代际为下界。
        $created[$rootPid] = $ownerTicks
    }
} finally {
    if ($root) { $root.Dispose() }
}`,
    String.raw`do {
    $added = $false
    foreach ($item in $all.GetEnumerator()) {
        if (-not $created.ContainsKey($item.Value) -or -not $ids.Add($item.Key)) { continue }
        if ($protected.Contains($item.Key)) { continue }
        try { $p = Open-ManagedProcess $item.Key } catch { continue }
        try {
            if (-not $p -or $p.HasExited) { continue }
            try { $ticks = Read-CreationTicks $p } catch { continue }
            if ($ticks -le $ownerTicks -or $ticks -le $created[$item.Value]) { continue }
            $created[$item.Key] = $ticks
            $descendants.Add($item.Key)
            $added = $true
        } finally {
            if ($p) { $p.Dispose() }
        }
    }
} while ($added)`,
    '[Console]::Out.WriteLine("descendants-selected: $($clock.ElapsedMilliseconds)ms count=$($descendants.Count)")',
    String.raw`for ($i = $descendants.Count - 1; $i -ge 0; $i--) {
    $pidToStop = $descendants[$i]
    $p = Open-ManagedProcess $pidToStop
    try {
        if (-not $p -or $p.HasExited) { continue }
        if ((Read-CreationTicks $p) -ne $created[$pidToStop]) {
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
    } finally {
        if ($p) { $p.Dispose() }
    }
}`
  ].join('; ')
  const startedAt = performance.now()
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
      `清理 Windows 进程树失败：rootPid=${pid}，code=${error.code}，signal=${error.signal ?? '无'}，超时终止=${error.killed === true}，耗时=${Math.round(performance.now() - startedAt)}ms；${error.stderr?.trim().slice(-2000) ?? ''}\n${error.stdout?.trim().slice(-2000) ?? ''}`,
      { cause: error }
    )
  }
}

async function terminateManagedTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    await stopWindowsTree(child)
    return
  }

  // 托管服务与维护命令均以自己的进程组启动，不终止 CLI 所在进程组。
  const deadline = performance.now() + 5_000
  while (true) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    const { stdout } = await execFileAsync('ps', ['-eo', 'pgid=,stat='], {
      timeout: 1_000,
      maxBuffer: 1024 * 1024
    })
    const running = stdout.split('\n').some((line) => {
      const [group, state] = line.trim().split(/\s+/)
      // 僵尸已停止执行并释放文件和端口，只等待父进程回收退出状态。
      return Number(group) === child.pid && state && !state.startsWith('Z')
    })
    if (!running) return
    if (performance.now() >= deadline) {
      throw new Error(`进程组在终止后仍未退出：pgid=${child.pid}`)
    }
    await delay(50)
  }
}

module.exports = { terminateManagedTree }
