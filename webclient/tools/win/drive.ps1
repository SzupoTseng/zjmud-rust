Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;using System.Runtime.InteropServices;
public class L {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
}
"@
$proc = Get-Process zjmud-client -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output "NO_PROCESS"; exit 1 }
$hwnd = $proc.MainWindowHandle
[void][L]::ShowWindow($hwnd,9)
[void][L]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 600

$rc = New-Object L+RECT
[void][L]::GetWindowRect($hwnd,[ref]$rc)
$left=[int]$rc.Left; $top=[int]$rc.Top
$wid=[int]$rc.Right-[int]$rc.Left; $hei=[int]$rc.Bottom-[int]$rc.Top
$px = $left + [int]([double]$wid*543.0/1196.0)
$py = $top  + [int]([double]$hei*591.0/819.0)
[void][L]::SetCursorPos($px,$py)
Start-Sleep -Milliseconds 200
[L]::mouse_event(0x0002,0,0,0,0); [L]::mouse_event(0x0004,0,0,0,0)
Start-Sleep -Milliseconds 300

$lines = [System.IO.File]::ReadAllLines("C:\Windows\Temp\login.txt", [System.Text.Encoding]::UTF8)
foreach ($ln in $lines) {
  if ($ln -eq "") { continue }
  Set-Clipboard -Value $ln
  Start-Sleep -Milliseconds 180
  [System.Windows.Forms.SendKeys]::SendWait("^a")
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  Write-Output ("SENT[{0}] {1}" -f $ln.Length, $ln)
  Start-Sleep -Milliseconds 700
}
