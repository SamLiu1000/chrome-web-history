# 生成扩展图标：圆角渐变底 + 白色时钟（象征"历史档案"）。
# 输出 icons/icon16.png / icon48.png / icon128.png

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $s = $size
  # 圆角矩形底 + 对角渐变
  $radius = [Math]::Max(2, [int]($s * 0.22))
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $gp.AddArc(0, 0, $d, $d, 180, 90)
  $gp.AddArc($s - $d - 1, 0, $d, $d, 270, 90)
  $gp.AddArc($s - $d - 1, $s - $d - 1, $d, $d, 0, 90)
  $gp.AddArc(0, $s - $d - 1, $d, $d, 90, 90)
  $gp.CloseFigure()
  $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($s, $s)),
    [System.Drawing.Color]::FromArgb(255, 74, 108, 247),
    [System.Drawing.Color]::FromArgb(255, 123, 84, 226))
  $g.FillPath($brush, $gp)

  # 白色时钟圆环
  $cx = $s * 0.5; $cy = $s * 0.52
  $r = $s * 0.30
  $ringW = [Math]::Max(1.0, $s * 0.085)
  $white = [System.Drawing.Brushes]::White
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $ringW)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawEllipse($pen, ($cx - $r), ($cy - $r), ($r * 2), ($r * 2))

  # 时针与分针
  $handW = [Math]::Max(1.0, $s * 0.075)
  $handPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $handW)
  $handPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $handPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  # 分针（向上）
  $g.DrawLine($handPen, $cx, $cy, $cx, ($cy - $r * 0.78))
  # 时针（向右上）
  $g.DrawLine($handPen, $cx, $cy, ($cx + $r * 0.52), ($cy + $r * 0.05))

  # 12 点刻度点
  $dotR = [Math]::Max(0.8, $s * 0.045)
  $g.FillEllipse($white, ($cx - $dotR), ($cy - $r - $dotR * 0.2), ($dotR * 2), ($dotR * 2))

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "saved $path"
}

New-Icon 128 (Join-Path $outDir 'icon128.png')
New-Icon 48  (Join-Path $outDir 'icon48.png')
New-Icon 16  (Join-Path $outDir 'icon16.png')
Write-Host 'done'
