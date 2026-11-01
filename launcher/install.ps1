# 安装 BPAgent 桌面入口：生成图标，在桌面和开始菜单建快捷方式（双击即启动托盘 + 独立窗口）
# 卸载：install.ps1 -Uninstall（只删快捷方式，不动代码和数据）
param([switch]$Uninstall)

$here = $PSScriptRoot
$icon = Join-Path $here 'BPAgent.ico'
$links = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'BPAgent.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'BPAgent.lnk')
)

if ($Uninstall) {
  foreach ($l in $links) { if (Test-Path $l) { Remove-Item $l -Force; "已删除 $l" } }
  return
}

# 图标：深色底 + 冷蓝三角徽标（和网页左上角一致），打包 16/32/48/256 四种尺寸
function New-BPIcon([string]$path) {
  Add-Type -AssemblyName System.Drawing
  $pngs = foreach ($size in 16, 32, 48, 256) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $k = $size / 48.0
    $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 10 * $k
    $bg.AddArc(0, 0, $r, $r, 180, 90); $bg.AddArc($size - $r - 1, 0, $r, $r, 270, 90)
    $bg.AddArc($size - $r - 1, $size - $r - 1, $r, $r, 0, 90); $bg.AddArc(0, $size - $r - 1, $r, $r, 90, 90); $bg.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 3, 14, 26))), $bg)
    $cyan = [System.Drawing.Color]::FromArgb(255, 53, 214, 255)
    $glow = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 53, 214, 255)), ([Math]::Max(2, 5 * $k))
    $pen = New-Object System.Drawing.Pen $cyan, ([Math]::Max(1.2, 2.6 * $k))
    $outer = [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF (24 * $k), (6 * $k)), (New-Object System.Drawing.PointF (43 * $k), (40 * $k)), (New-Object System.Drawing.PointF (5 * $k), (40 * $k)))
    $g.DrawPolygon($glow, $outer); $g.DrawPolygon($pen, $outer)
    if ($size -ge 32) {
      $thin = New-Object System.Drawing.Pen $cyan, ([Math]::Max(1, 1.4 * $k))
      $inner = [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF (24 * $k), (17 * $k)), (New-Object System.Drawing.PointF (35 * $k), (36 * $k)), (New-Object System.Drawing.PointF (13 * $k), (36 * $k)))
      $g.DrawPolygon($thin, $inner)
    }
    $c = 4.2 * $k
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $cyan), (24 * $k - $c), (30 * $k - $c), (2 * $c), (2 * $c))
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    if ($size -ge 256) {
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    } else {
      # 小尺寸写成 32 位 DIB：托盘用的 System.Drawing.Icon 读不了 PNG 压缩的小图标
      $bw = New-Object System.IO.BinaryWriter $ms
      $bw.Write([uint32]40); $bw.Write([int32]$size); $bw.Write([int32]($size * 2)); $bw.Write([uint16]1); $bw.Write([uint16]32)
      $bw.Write([uint32]0); $bw.Write([uint32]0); $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
      for ($y = $size - 1; $y -ge 0; $y--) {
        for ($x = 0; $x -lt $size; $x++) { $c = $bmp.GetPixel($x, $y); $bw.Write([byte]$c.B); $bw.Write([byte]$c.G); $bw.Write([byte]$c.R); $bw.Write([byte]$c.A) }
      }
      $bw.Write((New-Object byte[] ([Math]::Ceiling($size / 32) * 4 * $size))) # AND 掩码全 0，透明度靠 alpha
      $bw.Flush()
    }
    $bmp.Dispose()
    , @($size, $ms.ToArray())
  }
  # ICO 容器：头 + 目录项 + 图像数据（小尺寸 DIB，256 用 PNG）
  $fs = [System.IO.File]::Create($path)
  $w = New-Object System.IO.BinaryWriter $fs
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$pngs.Count)
  $offset = 6 + 16 * $pngs.Count
  foreach ($p in $pngs) {
    $s = if ($p[0] -ge 256) { 0 } else { $p[0] }
    $w.Write([byte]$s); $w.Write([byte]$s); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$p[1].Length); $w.Write([uint32]$offset)
    $offset += $p[1].Length
  }
  foreach ($p in $pngs) { $w.Write($p[1]) }
  $w.Close()
}

if (-not (Test-Path $icon)) { New-BPIcon $icon; "已生成图标 $icon" }

$shell = New-Object -ComObject WScript.Shell
foreach ($l in $links) {
  $sc = $shell.CreateShortcut($l)
  $sc.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $sc.Arguments = '"' + (Join-Path $here 'BPAgent.vbs') + '"'
  $sc.WorkingDirectory = Split-Path -Parent $here
  $sc.IconLocation = "$icon,0"
  $sc.Description = 'BPAgent：多 AI 编排台'
  $sc.Save()
  "已创建 $l"
}
