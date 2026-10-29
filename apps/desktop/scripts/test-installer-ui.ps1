param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$settings = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class InstallerUI {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUIINFO { public int Size,Flags; public IntPtr Active,Focus,Capture,Menu,Move,Caret; public RECT Rect; }
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent,IntPtr after,string cls,string name);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h,int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll",EntryPoint="SendMessageW",CharSet=CharSet.Unicode)] public static extern IntPtr ReadText(IntPtr h,uint m,IntPtr size,StringBuilder text);
  [DllImport("user32.dll",EntryPoint="SendMessageW",CharSet=CharSet.Unicode)] public static extern IntPtr WriteText(IntPtr h,uint m,IntPtr unused,string text);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool UpdateWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr pid);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint id,ref GUIINFO info);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
  public delegate bool EnumProc(IntPtr h, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int size);
  public static string Windows(int pid) {
    string found = "";
    EnumWindows((handle, data) => {
      uint owner;
      GetWindowThreadProcessId(handle, out owner);
      if (owner != pid) {
        return true;
      }
      var text = new StringBuilder(2048);
      GetWindowText(handle, text, 2048);
      found += handle + ": " + text + "\n";
      EnumChildWindows(handle, (child, context) => {
        var label = new StringBuilder(2048);
        GetWindowText(child, label, 2048);
        if (label.Length > 0) {
          found += " child " + child + ": " + label + "\n";
        }
        return true;
      }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr Focus(IntPtr hwnd) {
    GUIINFO info = new GUIINFO();
    info.Size = Marshal.SizeOf(info);
    GetGUIThreadInfo(GetWindowThreadProcessId(hwnd, IntPtr.Zero), ref info);
    return info.Focus;
  }
}
'@
[InstallerUI]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$owned = [Collections.Generic.List[Diagnostics.Process]]::new()
function Assert($ok,$message) {
  if (-not $ok) { throw $message }
  Write-Output "通过：$message"
}
function Wait-Until([scriptblock]$condition,$message,[int]$timeout=15000) {
  $clock=[Diagnostics.Stopwatch]::StartNew()
  while(-not (& $condition)) {
    if($clock.ElapsedMilliseconds -gt $timeout) { throw "等待超时：$message" }
    Start-Sleep -Milliseconds 30
  }
}
function Text([IntPtr]$hwnd) {
  $value=[Text.StringBuilder]::new(2048)
  [InstallerUI]::ReadText($hwnd,0xD,[IntPtr]2048,$value) | Out-Null
  return $value.ToString()
}
function Page([IntPtr]$hwnd) {
  return [InstallerUI]::FindWindowEx($hwnd,[IntPtr]::Zero,'PiDeskInstallerPage',$null)
}
function Control([IntPtr]$hwnd,[int]$id) {
  return [InstallerUI]::GetDlgItem((Page $hwnd),$id)
}
function Click([IntPtr]$hwnd,[int]$id) {
  $target=Control $hwnd $id
  if($target -eq [IntPtr]::Zero) { throw "控件不存在：$id" }
  [InstallerUI]::SendMessage($target,0xF5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
}
function Key([IntPtr]$hwnd,[int]$key) {
  [InstallerUI]::PostMessage($hwnd,0x100,[IntPtr]$key,[IntPtr]1) | Out-Null
  [InstallerUI]::PostMessage($hwnd,0x101,[IntPtr]$key,[IntPtr]0xC0000001L) | Out-Null
}
function Capture([IntPtr]$hwnd,$name) {
  [InstallerUI]::UpdateWindow($hwnd) | Out-Null
  [InstallerUI]::DwmFlush() | Out-Null
  $rect=[InstallerUI+RECT]::new()
  [InstallerUI]::GetWindowRect($hwnd,[ref]$rect) | Out-Null
  $image=[Drawing.Bitmap]::new($rect.Right-$rect.Left,$rect.Bottom-$rect.Top)
  $graphics=[Drawing.Graphics]::FromImage($image)
  $dc=$graphics.GetHdc()
  try { if(-not [InstallerUI]::PrintWindow($hwnd,$dc,2)) { throw '截图失败' } }
  finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
  $image.Save((Join-Path $settings.root "$name.png"),[Drawing.Imaging.ImageFormat]::Png)
  $image.Dispose()
}
function Start-Installer {
  $process=Start-Process -FilePath $settings.setup -PassThru -RedirectStandardError (Join-Path $settings.root "ui-$($owned.Count).log")
  $owned.Add($process)
  $null = $process.Handle
  Wait-Until { $process.Refresh(); $process.MainWindowHandle -ne [IntPtr]::Zero -or $process.HasExited } '窗口启动'
  if($process.HasExited) { throw "安装器提前退出：$($process.ExitCode)" }
  $hwnd=$process.MainWindowHandle
  Wait-Until { (Page $hwnd) -ne [IntPtr]::Zero } '原生安装页'
  return $process
}
try {
  $cancel=Start-Installer
  $hwnd=$cancel.MainWindowHandle
  Capture $hwnd 'ready'
  $pathControl=Control $hwnd 101
  [InstallerUI]::SendMessage((Page $hwnd),0x28,$pathControl,[IntPtr]1) | Out-Null
  Key $pathControl 9
  Wait-Until { [InstallerUI]::Focus($hwnd) -eq (Control $hwnd 102) } 'Tab进入更改'
  Key (Control $hwnd 102) 9
  Wait-Until { [InstallerUI]::Focus($hwnd) -eq (Control $hwnd 103) } 'Tab进入快捷方式'
  Key (Control $hwnd 103) 32
  Wait-Until { [InstallerUI]::SendMessage((Control $hwnd 103),0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -eq 0 } '空格取消勾选'
  Capture $hwnd 'keyboard-focus'
  Click $hwnd 104
  Wait-Until { (Text $hwnd) -match '正在安装' } '真实安装阶段'
  Capture $hwnd 'progress'
  Click $hwnd 104
  Wait-Until { (Text $hwnd) -match '取消安装' } '取消确认'
  Capture $hwnd 'cancel-confirm'
  Click $hwnd 105
  Wait-Until { (Text $hwnd) -match '安装未完成' } '安全取消结果'
  Capture $hwnd 'cancelled'
  Assert (-not (Test-Path (Join-Path $settings.install "$($settings.binary).exe"))) '取消未复制应用'
  Click $hwnd 104
  Assert ($cancel.WaitForExit(5000)) '取消后正常退出'
  Assert ($cancel.ExitCode -ne 0) '取消返回非零结果'

  $failure=Start-Installer
  $hwnd=$failure.MainWindowHandle
  $blocked=Join-Path $settings.root 'blocked'
  [IO.File]::WriteAllText($blocked,'not-a-directory')
  [InstallerUI]::WriteText((Control $hwnd 101),0xC,[IntPtr]::Zero,(Join-Path $blocked 'child')) | Out-Null
  Click $hwnd 104
  Wait-Until { (Text $hwnd) -match '安装未完成' } '文件写入失败'
  Capture $hwnd 'failed'
  Assert (-not (Test-Path $settings.uninstallKey)) '失败不登记为安装成功'
  Click $hwnd 104
  Assert ($failure.WaitForExit(5000)) '失败页可关闭'
  Assert ($failure.ExitCode -ne 0) '失败返回非零结果'

  foreach($shortcut in @($false,$true)) {
    $process=Start-Installer
    $hwnd=$process.MainWindowHandle
    $actual=Join-Path $settings.root '安装目录'
    [InstallerUI]::WriteText((Control $hwnd 101),0xC,[IntPtr]::Zero,$actual) | Out-Null
    if(-not $shortcut) { Click $hwnd 103 }
    Click $hwnd 104
    Wait-Until { (Text $hwnd) -match '正在安装' } '安装阶段'
    Click $hwnd 104
    Wait-Until { (Text $hwnd) -match '取消安装' } '继续场景确认页'
    Click $hwnd 104
    Wait-Until { -not [InstallerUI]::IsWindowEnabled((Control $hwnd 104)) } '文件替换关闭取消'
    Assert ((Text $hwnd) -match '正在安装') '文件替换阶段没有提前显示成功'
    Capture $hwnd 'committing'
    Wait-Until { (Text $hwnd) -match '安装完成' } '真实完成结果'
    Capture $hwnd 'complete'
    Assert (Test-Path (Join-Path $actual "$($settings.binary).exe")) '程序文件实际存在'
    Assert ((Get-ItemProperty $settings.uninstallKey).DisplayVersion -eq '1.0.0') '安装版本实际登记'
    Assert ((Test-Path (Join-Path $settings.desktop "$($settings.product).lnk")) -eq $shortcut) '桌面快捷方式遵循选择'
    Assert (Test-Path (Join-Path $settings.menu "$($settings.product)/$($settings.product).lnk")) '开始菜单快捷方式存在'
    if($shortcut) {
      Click $hwnd 104
      Wait-Until { Test-Path (Join-Path $actual 'opened.txt') } '打开应用执行fixture'
    } else {
      Click $hwnd 105
      Assert (-not (Test-Path (Join-Path $actual 'opened.txt'))) '关闭不启动应用'
    }
    Assert ($process.WaitForExit(5000)) '完成后安装器退出'
    Assert ($process.ExitCode -eq 0) "成功退出码为零，实际：$($process.ExitCode)"
  }
  $passive=Start-Process -FilePath $settings.setup -ArgumentList '/P' -PassThru
  $owned.Add($passive)
  $null = $passive.Handle
  Assert ($passive.WaitForExit(15000)) '被动安装自动结束'
  Assert ($passive.ExitCode -eq 0) '被动安装成功'
} catch {
  foreach($process in $owned) {
    if(-not $process.HasExited) {
      $process.Refresh()
      Write-Output ([InstallerUI]::Windows($process.Id))
      if($process.MainWindowHandle -ne [IntPtr]::Zero) { Capture $process.MainWindowHandle "failure-$($process.Id)" }
    }
  }
  throw
} finally {
  foreach($process in $owned) {
    if(-not $process.HasExited) {
      & taskkill.exe /PID $process.Id /T /F | Out-Null
      $process.WaitForExit(5000) | Out-Null
    }
    if(-not $process.HasExited) { Write-Error "测试进程未退出：$($process.Id)" }
  }
}
