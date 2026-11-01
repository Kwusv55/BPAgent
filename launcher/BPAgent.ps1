# BPAgent 托盘宿主：后台起服务（无黑窗）→ 打开独立窗口 → 托盘常驻
# 再次双击只把窗口提到前面；-NoWindow 只起服务和托盘；-Quit 让正在运行的那一份退出
param([switch]$NoWindow, [switch]$Quit)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$Root = Split-Path -Parent $PSScriptRoot
$cfg = Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'config\hub.json') | ConvertFrom-Json
$Port = if ($env:HUB_PORT) { [int]$env:HUB_PORT } elseif ($cfg.port) { [int]$cfg.port } else { 7788 }
$Base = "http://127.0.0.1:$Port"
$AppData = Join-Path $env:LOCALAPPDATA 'BPAgent'
$DataDir = Join-Path $Root 'data'
$Log = Join-Path $DataDir 'server.log'
New-Item -ItemType Directory -Force $AppData, $DataDir | Out-Null

# ───── 单实例：第二份只负责通知第一份「显示窗口」或「退出」 ─────
$showEvt = New-Object System.Threading.EventWaitHandle($false, 'AutoReset', 'Local\BPAgentShow')
$quitEvt = New-Object System.Threading.EventWaitHandle($false, 'AutoReset', 'Local\BPAgentQuit')
$first = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\BPAgentTray', [ref]$first)
if (-not $first) {
  if ($Quit) { [void]$quitEvt.Set() } elseif (-not $NoWindow) { [void]$showEvt.Set() }
  exit
}
if ($Quit) { $mutex.ReleaseMutex(); exit }

Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class BPWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  public static IntPtr Find(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().StartsWith(part)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Focus(string part) {
    var h = Find(part);
    if (h == IntPtr.Zero) return false;
    if (IsIconic(h)) ShowWindow(h, 9);
    SetForegroundWindow(h);
    return true;
  }
}
'@

function Show-Msg([string]$text, [string]$buttons = 'OK', [string]$icon = 'Information') {
  [System.Windows.Forms.MessageBox]::Show($text, 'BPAgent', $buttons, $icon)
}

function Test-Hub {
  try { (Invoke-WebRequest "$Base/api/state" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}

# ───── 服务：已经有一份在跑就直接用；否则后台起 node，日志写到 data\server.log ─────
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$script:proc = $null
$script:quitting = $false
function Start-Hub {
  if (Test-Hub) { return }
  if (-not $node) { Show-Msg '没有找到 Node.js（需要 20 以上版本），请先安装 Node.js 再打开 BPAgent。' 'OK' 'Error' | Out-Null; exit 1 }
  # 防止从旧终端继承到已删除的本地路由地址（同 start.cmd）
  Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
  $script:proc = Start-Process -FilePath $node -ArgumentList "`"$Root\src\server.js`"" -WorkingDirectory $Root `
    -WindowStyle Hidden -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" -PassThru
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Hub) { return }
    if ($script:proc.HasExited) { break }
  }
  Show-Msg "BPAgent 服务没能启动，请查看日志：`n$Log`n$Log.err" 'OK' 'Error' | Out-Null
}

function Stop-Hub {
  try { Invoke-RestMethod "$Base/api/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null } catch {}
  for ($i = 0; $i -lt 25 -and (Test-Hub); $i++) { Start-Sleep -Milliseconds 200 }
  if ($script:proc -and -not $script:proc.HasExited) { & taskkill.exe /pid $script:proc.Id /T /F | Out-Null }
  $script:proc = $null
}

# ───── 窗口：用本机 Edge 的应用模式开独立窗口，单独的用户目录，不和日常浏览器混在一起 ─────
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
$EdgeProfile = Join-Path $AppData 'edge'
function Open-Window([string]$page = '', [string]$title = 'BPAgent · 指挥中心') {
  if ([BPWin]::Focus($title)) { return }
  $url = "$Base/$page"
  if ($edge) {
    Start-Process $edge -ArgumentList "--app=$url", "--user-data-dir=`"$EdgeProfile`"", '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000'
  } else {
    Start-Process $url
  }
}

function Close-Windows {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$EdgeProfile*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Exit-App([bool]$ask = $true) {
  if ($ask) {
    $n = 0
    try { $n = @((Invoke-RestMethod "$Base/api/state" -TimeoutSec 3).runs | Where-Object { $_.status -in 'planning', 'running', 'summarizing' }).Count } catch {}
    if ($n -gt 0 -and (Show-Msg "有 $n 个编排正在进行，退出会中断它们（之后可以在界面上「继续运行」）。`n确定退出 BPAgent？" 'YesNo' 'Warning') -ne 'Yes') { return }
  }
  $script:quitting = $true
  Stop-Hub
  Close-Windows
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

# ───── 托盘 ─────
$iconFile = Join-Path $PSScriptRoot 'BPAgent.ico'
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = if (Test-Path $iconFile) { New-Object System.Drawing.Icon $iconFile } else { [System.Drawing.SystemIcons]::Application }
$tray.Text = 'BPAgent 编排台'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Add-Item([string]$text, [scriptblock]$fn) { $it = $menu.Items.Add($text); $it.add_Click($fn) | Out-Null }
Add-Item '显示指挥中心' { Open-Window }
[void]$menu.Items.Add('-')
Add-Item '打开数据目录' { Start-Process explorer.exe $DataDir }
Add-Item '查看服务日志' { Start-Process notepad.exe $Log }
Add-Item '重启服务' { Stop-Hub; Start-Hub; $tray.ShowBalloonTip(2000, 'BPAgent', '服务已重启', 'Info') }
[void]$menu.Items.Add('-')
Add-Item '退出 BPAgent' { Exit-App }
$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Window } })

# 轮询：别的实例要求显示 / 退出；服务意外退出时自动拉起
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$script:tick = 0
$timer.add_Tick({
  if ($showEvt.WaitOne(0)) { Open-Window }
  if ($quitEvt.WaitOne(0)) { Exit-App $false; return }
  $script:tick++
  if ($script:tick % 15 -eq 0 -and -not $script:quitting -and $script:proc -and $script:proc.HasExited) {
    $tray.ShowBalloonTip(3000, 'BPAgent', '服务意外退出，正在重启…', 'Warning')
    Start-Hub
  }
})

Start-Hub
$tray.Visible = $true
if (-not $NoWindow) { Open-Window }
$tray.ShowBalloonTip(3000, 'BPAgent 已启动', '关掉窗口后仍在托盘运行；左键托盘图标打开，右键可退出。', 'Info')
$timer.Start()
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
