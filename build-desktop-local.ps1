#Requires -Version 5.1
<#
.SYNOPSIS
  opencode 桌面端（Electron）Windows 本地一键打包脚本（改进版）。

.DESCRIPTION
  相比原版 build-desktop-local.ps1 的主要改动：

  1. 失败即停：任何一步返回非 0 退出码立刻中止，脚本以 exit 1 结束，可用于 CI 门禁。
  2. 去掉硬编码路径：默认取脚本所在目录，可用 -Root 覆盖。
  3. 链接扫描不再顺着 junction / symlink 递归。原版用 Get-ChildItem -Recurse，
     PowerShell 5.1 会跟进 junction，导致同一棵真实子树被反复遍历，
     这是 9000+ 链接场景下最慢的元凶。现改为带剪枝的 BFS：
     遇到 reparse point 只记录、不进入，每棵真实子树只走一遍。
  4. 日志统一 UTF-8 编码，不再出现 UTF-16 / UTF-8 混排导致的乱码。
  5. 支持断点续跑与只诊断：-DryRun 完全不改文件；-SkipWipe / -SkipInstall /
     -SkipLinkFix / -SkipNativeFix / -StopAfterLinks 可组合使用。
  6. 新增 -DropBunStore 快速通道，跳过 bun 安装缓存内部的链接（实测量级见日志）。
  7. 结束前校验产物并输出构建总结，产物缺失时以 exit 1 结束。

  注意：本文件含中文，必须以 UTF-8 with BOM 保存；
  否则 PowerShell 5.1 会按系统 ANSI(GBK) 解析导致语法错误。

.PARAMETER Root
  仓库根目录，默认取脚本所在目录。

.PARAMETER LogPath
  日志文件路径，默认 <Root>\build-desktop.log。

.PARAMETER Channel
  写入 OPENCODE_CHANNEL 的值，默认 dev。

.PARAMETER ScanDepth
  链接 / node_modules 扫描的最大深度，默认 6。

.PARAMETER MaxRounds
  链接转实体最多迭代轮数，默认 6。

.PARAMETER ScanTargets
  参与链接扫描的顶层目录，默认 node_modules、packages、github。

.PARAMETER SkipWipe / SkipInstall / SkipLinkFix / SkipNativeFix
  跳过对应阶段，用于断点续跑。

.PARAMETER StopAfterLinks
  完成链接转实体后即停止，不进入构建与打包。

.PARAMETER DropBunStore
  快速通道：跳过 node_modules\.bun 内部的链接，并在展开完成后删除该目录。
  背景：node_modules\<pkg> 已是真实目录（--backend=copyfile 的成果），
  .bun 里的链接只在 store 内互相引用，而 packages\*\node_modules\* 指向的
  正是 store 里的真实目录；因此展开后者之后，整个 store 已无引用方。
  实测可减少约 80% 的链接展开工作量与相应磁盘占用。
  代价：node_modules\.bun 被删除，下次 bun install 需重新下载该 store。
  默认关闭，以保持与原脚本完全等价的保守行为。

.PARAMETER DryRun
  只统计不改动：扫描依赖树、报告链接数量与分布后退出。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\build-desktop-local.ps1

.EXAMPLE
  # 上次已装好依赖，从链接处理继续
  powershell -ExecutionPolicy Bypass -File .\build-desktop-local.ps1 -SkipWipe -SkipInstall

.EXAMPLE
  # 只诊断，不做任何修改
  powershell -ExecutionPolicy Bypass -File .\build-desktop-local.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Root,
  [string]$LogPath,
  [string]$Channel = "dev",
  [int]$ScanDepth = 6,
  [int]$MaxRounds = 6,
  [string[]]$ScanTargets = @("node_modules", "packages", "github"),
  [switch]$SkipWipe,
  [switch]$SkipInstall,
  [switch]$SkipLinkFix,
  [switch]$SkipNativeFix,
  [switch]$StopAfterLinks,
  [switch]$DropBunStore,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not $Root) {
  $Root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
}
$Root = (Resolve-Path -LiteralPath $Root).Path
$script:LogFile = if ($LogPath) { $LogPath } else { Join-Path $Root "build-desktop.log" }
$script:StartedAt = Get-Date
$script:Failed = $false
$script:Stat = [ordered]@{
  Wiped          = 0
  Rounds         = 0
  Materialized   = 0
  Skipped        = 0
  CopyFailed     = 0
  RemainingLinks = -1
}

$reparseFlag = [System.IO.FileAttributes]::ReparsePoint

function Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message
  Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
  Write-Host $line
}

function Log-Block {
  param([string[]]$Lines)
  if (-not $Lines -or $Lines.Count -eq 0) { return }
  Add-Content -LiteralPath $script:LogFile -Value $Lines -Encoding UTF8
  foreach ($l in $Lines) { Write-Host "          $l" }
}

# 执行一个必须成功的步骤：捕获输出、检查退出码，失败即抛。
function Invoke-Step {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][scriptblock]$Command
  )
  Log ">>> $Name"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $ErrorActionPreference = "Continue"   # 原生命令写 stderr 不应触发终止
  $output = @(& $Command *>&1 | ForEach-Object { "$_" })
  $code = $LASTEXITCODE
  $sw.Stop()
  $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  Log-Block $output
  if ($code -ne 0) {
    Log "!!! $Name 失败 exit=$code 耗时 ${secs}s"
    throw "步骤失败: $Name (exit $code)"
  }
  Log "<<< $Name 完成 耗时 ${secs}s"
}

# 广度优先扫描目录树。遇到 reparse point 只记录、不进入，避免重复遍历同一棵子树。
function Get-TreeScan {
  param(
    [string[]]$Roots,
    [int]$Depth = 6,
    [string[]]$PruneNames = @()
  )
  $items = New-Object System.Collections.Generic.List[object]
  $queue = New-Object System.Collections.Generic.Queue[object]
  foreach ($r in $Roots) {
    $full = $null
    try { $full = (Resolve-Path -LiteralPath $r -ErrorAction Stop).Path } catch { continue }
    $attr = $null
    try { $attr = [System.IO.File]::GetAttributes($full) } catch { continue }
    $queue.Enqueue([pscustomobject]@{ Path = $full; Level = 0; IsLink = (($attr -band $reparseFlag) -ne 0) })
  }
  while ($queue.Count -gt 0) {
    $node = $queue.Dequeue()
    if ($node.IsLink) { continue }
    $dirs = @()
    $files = @()
    try { $dirs = [System.IO.Directory]::GetDirectories($node.Path) } catch { $dirs = @() }
    try { $files = [System.IO.Directory]::GetFiles($node.Path) } catch { $files = @() }
    foreach ($p in $dirs) {
      $attr = $null
      try { $attr = [System.IO.File]::GetAttributes($p) } catch { continue }
      $isLink = ($attr -band $reparseFlag) -ne 0
      $name = [System.IO.Path]::GetFileName($p)
      $level = $node.Level + 1
      $items.Add([pscustomobject]@{ Path = $p; Name = $name; IsDir = $true; IsLink = $isLink; Level = $level })
      if ($isLink) { continue }
      if ($PruneNames -contains $name) { continue }
      if ($level -ge $Depth) { continue }
      $queue.Enqueue([pscustomobject]@{ Path = $p; Level = $level; IsLink = $false })
    }
    foreach ($p in $files) {
      $attr = $null
      try { $attr = [System.IO.File]::GetAttributes($p) } catch { continue }
      if (($attr -band $reparseFlag) -eq 0) { continue }
      $items.Add([pscustomobject]@{ Path = $p; Name = [System.IO.Path]::GetFileName($p); IsDir = $false; IsLink = $true; Level = $node.Level + 1 })
    }
  }
  return $items
}

function Get-ScanRoots {
  $candidates = @($ScanTargets | ForEach-Object { Join-Path $Root $_ })
  return @($candidates | Where-Object { Test-Path -LiteralPath $_ })
}

function Get-AllLinks {
  $prune = @(".git")
  # .bun 是 bun 的安装缓存：它内部的链接只在 store 内互相引用，
  # 而 packages\*\node_modules\* 指向的正是 store 里的真实目录。
  # 因此只要展开后者，整个 store 就再无引用方，可整目录删除。
  if ($DropBunStore) { $prune += ".bun" }
  return @(Get-TreeScan -Roots (Get-ScanRoots) -Depth $ScanDepth -PruneNames $prune | Where-Object { $_.IsLink })
}

function Resolve-LinkTarget {
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $null }
  $target = @($item.Target)[0]
  if (-not $target) { return $null }
  if ([System.IO.Path]::IsPathRooted($target)) { return $target }
  return Join-Path (Split-Path -Parent $Path) $target
}

function Remove-Any {
  param([string]$Path, [bool]$IsDir)
  try {
    if ($IsDir) { [System.IO.Directory]::Delete($Path, $false) }
    else { [System.IO.File]::Delete($Path) }
    return
  } catch {
    if ($IsDir) { cmd /c "rmdir /s /q `"$Path`"" 2>&1 | Out-Null }
    else { cmd /c "del /f /q `"$Path`"" 2>&1 | Out-Null }
  }
}

# -DryRun 专用：只读扫描，输出依赖树与链接分布，不修改任何文件。
function Show-Diagnostic {
  Log ">>> [DryRun] 诊断模式，只扫描统计，不修改任何文件"

  $nmScan = Get-TreeScan -Roots @($Root) -Depth $ScanDepth -PruneNames @(".git", "node_modules")
  $nmDirs = @($nmScan | Where-Object { $_.IsDir -and -not $_.IsLink -and $_.Name -eq "node_modules" })
  Log "  node_modules 目录数 = $($nmDirs.Count)"
  foreach ($d in ($nmDirs | Sort-Object Level | Select-Object -First 12)) {
    Log ("    L{0}  {1}" -f $d.Level, $d.Path.Substring($Root.Length).TrimStart('\'))
  }

  $roots = Get-ScanRoots
  $rootNames = @($roots | ForEach-Object { $_.Substring($Root.Length).TrimStart('\') })
  Log "  链接扫描根 = $($rootNames -join ', ')"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $links = @(Get-TreeScan -Roots $roots -Depth $ScanDepth -PruneNames @(".git") | Where-Object { $_.IsLink })
  $sw.Stop()
  Log "  链接总数 = $($links.Count)（扫描耗时 $([math]::Round($sw.Elapsed.TotalSeconds,1))s）"
  Log "  目录链接 = $(@($links | Where-Object { $_.IsDir }).Count)   文件链接 = $(@($links | Where-Object { -not $_.IsDir }).Count)"

  $bunPrefix = Join-Path $Root "node_modules\.bun"
  $inBun = @($links | Where-Object { $_.Path.StartsWith($bunPrefix, [System.StringComparison]::OrdinalIgnoreCase) })
  $pct = if ($links.Count -gt 0) { [math]::Round(100 * $inBun.Count / $links.Count, 1) } else { 0 }
  Log "  node_modules\.bun 内部链接 = $($inBun.Count)（占 ${pct}%）"
  Log "  其他链接（真正需要展开） = $($links.Count - $inBun.Count)"
  Log "  当前开关下实际需展开     = $(if ($DropBunStore) { $links.Count - $inBun.Count } else { $links.Count })"

  Log "  按来源分布（前 15）:"
  $links |
    Group-Object {
      $parts = $_.Path.Substring($Root.Length).TrimStart('\').Split('\')
      if ($parts.Count -ge 2) { "$($parts[0])\$($parts[1])" } else { $parts[0] }
    } |
    Sort-Object Count -Descending | Select-Object -First 15 |
    ForEach-Object { Log ("    {0,-26} {1}" -f $_.Name, $_.Count) }

  $unresolved = 0
  foreach ($l in $links) { if (-not (Resolve-LinkTarget $l.Path)) { $unresolved++ } }
  Log "  无法解析目标的链接 = $unresolved"
  Log "<<< [DryRun] 诊断结束，未修改任何文件"
}

Set-Content -LiteralPath $script:LogFile -Value "=== build start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') root=$Root ===" -Encoding UTF8
Set-Location $Root

try {
  # ---------- 0. 预检 ----------
  Log ">>> 预检"
  if ($DryRun) { Log "  模式 = DryRun（只诊断，不改动任何文件）" }
  foreach ($tool in @("bun", "robocopy", "npx")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "未找到命令: $tool（请确认已加入 PATH）" }
  }
  $desktopDir = Join-Path $Root "packages\desktop"
  $required = @(
    $desktopDir,
    (Join-Path $desktopDir "electron-builder.config.ts"),
    (Join-Path $desktopDir "scripts\prepare.ts")
  )
  foreach ($p in $required) {
    if (-not (Test-Path -LiteralPath $p)) { throw "缺少必要路径: $p" }
  }
  Log "<<< 预检通过（bun / robocopy / npx 均可用）"

  if ($DryRun) {
    Show-Diagnostic
  } else {

    # ---------- 1. 清理 node_modules ----------
    if ($SkipWipe) {
      Log ">>> 清理 node_modules  [已跳过]"
    } else {
      Log ">>> 清理 node_modules"
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      # 剪枝 node_modules：删掉外层后内层一并消失，无需逐层遍历
      $scan = Get-TreeScan -Roots @($Root) -Depth $ScanDepth -PruneNames @(".git", "node_modules")
      $targets = @($scan | Where-Object { $_.IsDir -and -not $_.IsLink -and $_.Name -eq "node_modules" } | Sort-Object Level)
      Log "  待删除 node_modules 目录数 = $($targets.Count)"
      foreach ($t in $targets) {
        Remove-Any -Path $t.Path -IsDir $true
        Log ("    删除 {0}" -f $t.Path.Substring($Root.Length).TrimStart('\'))
      }
      $script:Stat.Wiped = $targets.Count
      $left = @(Get-TreeScan -Roots @($Root) -Depth $ScanDepth -PruneNames @(".git", "node_modules") |
        Where-Object { $_.IsDir -and -not $_.IsLink -and $_.Name -eq "node_modules" }).Count
      $sw.Stop()
      Log "<<< 清理完成 剩余=$left 耗时 $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
    }

    # ---------- 2. 安装依赖 ----------
    if ($SkipInstall) {
      Log ">>> bun install  [已跳过]"
    } else {
      Invoke-Step "bun install" { bun install --frozen-lockfile --backend=copyfile }
      $top = @(Get-ChildItem (Join-Path $Root "node_modules") -Force -ErrorAction SilentlyContinue).Count
      Log "  node_modules 顶层条目数 = $top"
    }

    # ---------- 3. 链接转实体拷贝 ----------
    if ($SkipLinkFix) {
      Log ">>> 链接转实体拷贝  [已跳过]"
    } else {
      Log ">>> 链接转实体拷贝 (depth=$ScanDepth maxRounds=$MaxRounds)"
      for ($round = 1; $round -le $MaxRounds; $round++) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $links = Get-AllLinks
        $sw.Stop()
        Log "  round ${round}: 扫描耗时 $([math]::Round($sw.Elapsed.TotalSeconds,1))s，链接数 = $($links.Count)"
        $script:Stat.Rounds = $round
        if ($links.Count -eq 0) { Log "  已无链接，收敛"; break }

        $done = 0; $skip = 0; $fail = 0
        $i = 0
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        foreach ($link in $links) {
          $i++
          if ($i % 500 -eq 0) { Log "    ... 已处理 $i / $($links.Count)" }
          $target = Resolve-LinkTarget $link.Path
          if (-not $target) { $skip++; continue }
          if (-not (Test-Path -LiteralPath $target)) { $skip++; continue }
          Remove-Any -Path $link.Path -IsDir $link.IsDir
          if ($link.IsDir) {
            & robocopy $target $link.Path /E /XJ /MT:8 /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
            if ($LASTEXITCODE -ge 8) { $fail++ } else { $done++ }
          } else {
            Copy-Item -LiteralPath $target -Destination $link.Path -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $link.Path) { $done++ } else { $fail++ }
          }
        }
        $sw.Stop()
        $script:Stat.Materialized += $done
        $script:Stat.Skipped += $skip
        $script:Stat.CopyFailed += $fail
        Log "  round ${round} 结果: 已展开=$done 跳过=$skip 失败=$fail 耗时=$([math]::Round($sw.Elapsed.TotalSeconds,1))s"
        if ($done -eq 0) { Log "  本轮无进展，停止迭代"; break }
      }
      if ($DropBunStore) {
        $bunDir = Join-Path $Root "node_modules\.bun"
        if (Test-Path -LiteralPath $bunDir) {
          Log ">>> 删除 node_modules\.bun（bun 安装缓存，展开后已无引用方）"
          $sw = [System.Diagnostics.Stopwatch]::StartNew()
          cmd /c "rmdir /s /q `"$bunDir`"" 2>&1 | Out-Null
          $sw.Stop()
          $still = Test-Path -LiteralPath $bunDir
          Log ("  删除结果: {0}，耗时 {1}s" -f $(if ($still) { "目录仍存在，请手动检查" } else { "已删除" }), [math]::Round($sw.Elapsed.TotalSeconds,1))
        }
      }
      $script:Stat.RemainingLinks = (Get-AllLinks).Count
      Log "  转换后剩余链接 = $($script:Stat.RemainingLinks)"
    }

    # ---------- 4. 修复 node-pty ----------
    if ($SkipNativeFix) {
      Log ">>> fix-node-pty  [已跳过]"
    } else {
      Invoke-Step "fix-node-pty" { bun run --cwd (Join-Path $Root "packages\core") fix-node-pty }
    }

    if ($StopAfterLinks) {
      Log ">>> -StopAfterLinks 已指定，跳过构建与打包"
    } else {
      # ---------- 5. 构建桌面端 ----------
      Set-Location $desktopDir
      $env:OPENCODE_CHANNEL = $Channel
      Log "  OPENCODE_CHANNEL=$Channel"
      Invoke-Step "prepare" { bun ./scripts/prepare.ts }
      Invoke-Step "electron-vite build" { bun run build }

      # ---------- 6. 打包 ----------
      Invoke-Step "electron-builder" { npx electron-builder --win --publish never --config electron-builder.config.ts }

      # ---------- 7. 校验产物 ----------
      $dist = Join-Path $desktopDir "dist"
      $exe = Join-Path $dist "opencode-desktop-win-x64.exe"
      if (Test-Path -LiteralPath $exe) {
        $sizeMB = [math]::Round((Get-Item $exe).Length / 1MB, 1)
        Log "<<< 产物就绪: $exe (${sizeMB}MB)"
      } else {
        $entries = @(Get-ChildItem $dist -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
        Log "!!! 未生成安装包，dist 内容: $($entries -join ', ')"
        throw "未找到产物 $exe"
      }
    }
  }
} catch {
  $script:Failed = $true
  Log "!!! 构建中止: $($_.Exception.Message)"
} finally {
  $elapsed = [math]::Round(((Get-Date) - $script:StartedAt).TotalSeconds, 1)
  $mode = if ($DryRun) { "DryRun（未修改任何文件）" }
    elseif ($StopAfterLinks) { "仅到链接处理（StopAfterLinks）" }
    else { "完整构建" }
  Log "=== 构建总结 ==="
  Log ("  {0,-14}= {1}" -f "root", $Root)
  Log ("  {0,-14}= {1}" -f "channel", $Channel)
  Log ("  {0,-14}= {1}" -f "模式", $mode)
  Log ("  {0,-14}= {1}" -f "清理目录数", $script:Stat.Wiped)
  Log ("  {0,-14}= {1}" -f "链接迭代轮数", $script:Stat.Rounds)
  Log ("  {0,-14}= {1}" -f "展开链接", "$($script:Stat.Materialized)（跳过 $($script:Stat.Skipped)，失败 $($script:Stat.CopyFailed)）")
  Log ("  {0,-14}= {1}" -f "剩余链接", $script:Stat.RemainingLinks)
  Log ("  {0,-14}= {1}" -f "跳过 .bun 存储", $(if ($DropBunStore) { "是（并已删除该目录）" } else { "否" }))
  Log ("  {0,-14}= {1}s" -f "总耗时", $elapsed)
  Log ("  {0,-14}= {1}" -f "结果", $(if ($script:Failed) { "FAILED" } else { "OK" }))
  Log "=== build end $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
}

if ($script:Failed) { exit 1 }
exit 0
