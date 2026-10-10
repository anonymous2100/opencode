#Requires -Version 5.1
<#
.SYNOPSIS
  opencode 桌面端（Electron）Windows 一键打包脚本（快速版）。

.DESCRIPTION
  与 build-desktop-local.ps1 的区别（那个脚本慢的根因）：

  1. 不删 node_modules，不做「链接转实体拷贝」。
     build-desktop-local.ps1 会把 node_modules 里 8000+ 个 bun junction
     逐个用 robocopy 展开成实体目录，这是它耗时十几分钟到几十分钟的原因。
     本脚本直接复用现有 node_modules，仅在其缺失时才 bun install。
     electron-builder 本身能正确处理 bun 的链接布局（实测通过）。

  2. 完整流程只有三步：
       prepare（写版本号 + 构建内嵌 CLI）
       → electron-vite build（渲染进程/主进程）
       → electron-builder（Windows NSIS 安装包）

  3. 失败即停，产物缺失以 exit 1 结束。

.ENVIRONMENT
  electron-builder 默认从 GitHub 下载 nsis / 7zip 等二进制，在国内网络下
  经常 502。本脚本默认走 npmmirror 镜像，可用 -Mirror 覆盖。

.PARAMETER Version
  写进产物的版本号，默认读取 packages/opencode/package.json 的 version。

.PARAMETER Channel
  写入 OPENCODE_CHANNEL，默认 prod（产物名 OpenCode，正式图标）。
  可选 dev / beta / prod；dev 为开发渠道（蓝色图标，产物名 OpenCode Dev）。

.PARAMETER SidecarCli
  prod / beta 渠道下要内嵌的 opencode CLI 版本。
  默认取 -Version，即与桌面端版本一致；传 "none" 表示不内嵌。
  说明：正式构建里 CLI 随包分发，而 dev 渠道的 prepare 只会下载 next
  快照版，因此 prod / beta 必须自己下载一个发布版本放进 resources\。

.PARAMETER Mirror
  electron / electron-builder-binaries 的下载镜像根地址。传空字符串则用官方源。

.PARAMETER Force
  node_modules 已存在时也强制 bun install。

.PARAMETER SkipClean
  跳过构建产物清理。默认会先删除上一次的 dist / out /
  packages/opencode/dist 以及遗留日志，保证产物是全新构建的。

.PARAMETER KeepLogs
  清理时保留旧日志文件（默认一并删除 build-desktop.log、
  packages/desktop/*.log 等历史日志）。

.PARAMETER SkipInstall / SkipPrepare / SkipBuild / SkipPackage
  跳过对应阶段，用于断点续跑。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\package-desktop.ps1

.EXAMPLE
  # 正式包；默认内嵌与桌面端同版本的 CLI
  powershell -ExecutionPolicy Bypass -File .\package-desktop.ps1

.EXAMPLE
  # 正式包，显式指定要内嵌的 CLI 版本
  powershell -ExecutionPolicy Bypass -File .\package-desktop.ps1 -SidecarCli 1.18.35

.EXAMPLE
  # 不内嵌 CLI（产物需要外部 CLI 才能连上后端）
  powershell -ExecutionPolicy Bypass -File .\package-desktop.ps1 -SidecarCli none

.EXAMPLE
  # 开发渠道（蓝色图标，prepare 会自动下载快照版 CLI）
  powershell -ExecutionPolicy Bypass -File .\package-desktop.ps1 -Channel dev

.EXAMPLE
  # 上次已构建完，只重新打包（保留产物，不清理）
  powershell -ExecutionPolicy Bypass -File .\package-desktop.ps1 -SkipClean -SkipInstall -SkipPrepare -SkipBuild
#>
[CmdletBinding()]
param(
  [string]$Version,
  [ValidateSet("dev", "beta", "prod")][string]$Channel = "prod",
  [string]$SidecarCli = "auto",
  [string]$Mirror = "https://registry.npmmirror.com",
  [switch]$Force,
  [switch]$SkipClean,
  [switch]$KeepLogs,
  [switch]$SkipInstall,
  [switch]$SkipPrepare,
  [switch]$SkipBuild,
  [switch]$SkipPackage
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# 原生工具（electron-builder 等）按 UTF-8 输出，PS 5.1 默认用控制台代码页解码会乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$Root = (Resolve-Path -LiteralPath $Root).Path
$desktopDir = Join-Path $Root "packages\desktop"
$logFile = Join-Path $Root "package-desktop.log"
$startedAt = Get-Date
$failed = $false

function Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

# 执行一个必须成功的步骤：捕获输出、检查退出码，失败即抛。
function Invoke-Step {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$WorkDir,
    [Parameter(Mandatory)][scriptblock]$Command
  )
  Log ">>> $Name"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Push-Location $WorkDir
  try {
    $ErrorActionPreference = "Continue"   # 原生命令写 stderr 不应触发终止
    $output = @(& $Command *>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  $sw.Stop()
  foreach ($l in $output) { Add-Content -LiteralPath $logFile -Value $l -Encoding UTF8 }
  $tail = if ($output.Count -gt 25) { $output[-25..-1] } else { $output }
  foreach ($l in $tail) { Write-Host "          $l" }
  if ($code -ne 0) {
    Log "!!! $Name 失败 exit=$code 耗时 $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
    throw "步骤失败: $Name (exit $code)"
  }
  Log "<<< $Name 完成 耗时 $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
}

# 删除目录或文件，容忍长路径、只读项与占用重试；始终不抛异常，返回是否已不存在。
# 注意：调用方可能处于 $ErrorActionPreference = "Stop"（脚本顶层即如此），
# 因此这里必须自己把偏好改成 Continue，否则删除失败会把整个打包流程中断。
function Remove-Tree {
  param([string]$Path)
  $pref = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    # bun 下载的 opencode.exe 带 hidden/system 属性，直接删除会报「访问被拒绝」，
    # 必须先清掉属性。
    if (Test-Path -LiteralPath $Path -PathType Container) {
      cmd /c "attrib -r -h -s /s /d `"$Path\*`"" 2>&1 | Out-Null
    } else {
      cmd /c "attrib -r -h -s `"$Path`"" 2>&1 | Out-Null
    }
    for ($i = 1; $i -le 3; $i++) {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $Path)) { return $true }
      if (Test-Path -LiteralPath $Path -PathType Container) {
        cmd /c "rmdir /s /q `"$Path`"" 2>&1 | Out-Null
      } else {
        cmd /c "del /f /q `"$Path`"" 2>&1 | Out-Null
      }
      if (-not (Test-Path -LiteralPath $Path)) { return $true }
      Start-Sleep -Milliseconds 500
    }
    return $false
  } finally {
    $ErrorActionPreference = $pref
  }
}

Set-Content -LiteralPath $logFile -Value "=== package start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') root=$Root ===" -Encoding UTF8
Set-Location $Root

try {
  # ---------- 0. 预检 ----------
  Log ">>> 预检"
  foreach ($tool in @("bun", "npx")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "未找到命令: $tool（请确认已加入 PATH）" }
  }
  foreach ($p in @($desktopDir, (Join-Path $desktopDir "electron-builder.config.ts"))) {
    if (-not (Test-Path -LiteralPath $p)) { throw "缺少必要路径: $p" }
  }
  if (-not $Version) {
    $Version = (Get-Content -LiteralPath (Join-Path $Root "packages\opencode\package.json") -Raw | ConvertFrom-Json).version
  }
  Log "  版本 = $Version  渠道 = $Channel"
  Log "<<< 预检通过"

  if ($Mirror) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "$Mirror/-/binary/electron-builder-binaries/"
    $env:ELECTRON_MIRROR = "$Mirror/-/binary/electron/"
    Log "  二进制镜像 = $Mirror"
  }
  $env:OPENCODE_VERSION = $Version
  $env:OPENCODE_CHANNEL = $Channel

  # ---------- 0.5 清理旧产物 ----------
  if ($SkipClean) {
    Log ">>> 清理旧产物  [已跳过]"
  } else {
    Log ">>> 清理旧产物"
    $cleanDirs = @(
      (Join-Path $desktopDir "dist"),
      (Join-Path $desktopDir "out"),
      (Join-Path $desktopDir "resources\opencode-cli.exe"),
      (Join-Path $Root "packages\opencode\dist")
    )
    $cleanLogs = if ($KeepLogs) { @() } else { @(
      (Join-Path $Root "build-desktop.log"),
      (Join-Path $desktopDir "p.log"),
      (Join-Path $desktopDir "pkg.log"),
      (Join-Path $desktopDir "build.log"),
      (Join-Path $desktopDir "package.log"),
      (Join-Path $desktopDir "dist.log")
    )}
    $freed = 0
    foreach ($t in ($cleanDirs + $cleanLogs)) {
      if (-not (Test-Path -LiteralPath $t)) { continue }
      if (Test-Path -LiteralPath $t -PathType Container) {
        $size = (Get-ChildItem -LiteralPath $t -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        if ($size) { $freed += $size }
      } else {
        $freed += (Get-Item -LiteralPath $t -Force).Length
      }
      $ok = Remove-Tree $t
      Log ("  {0} {1}" -f $(if ($ok) { "已删除" } else { "删除失败" }), $t.Substring($Root.Length).TrimStart('\'))
    }
    Log ("  释放 {0}MB" -f [math]::Round($freed / 1MB, 1))
  }

  # ---------- 1. 依赖（仅在缺失或 -Force 时安装） ----------
  $nm = Join-Path $Root "node_modules"
  $hasStore = Test-Path -LiteralPath (Join-Path $nm ".bun")
  if ($SkipInstall) {
    Log ">>> bun install  [已跳过]"
  } elseif ($hasStore -and -not $Force) {
    Log ">>> bun install  [复用现有 node_modules，未重装；需要重建请加 -Force]"
  } else {
    Invoke-Step "bun install" $Root { bun install --frozen-lockfile --backend=copyfile }
  }

  # ---------- 2. prepare：写版本号 + 构建内嵌 CLI ----------
  if ($SkipPrepare) {
    Log ">>> prepare  [已跳过]"
  } else {
    Invoke-Step "prepare" $desktopDir { bun ./scripts/prepare.ts }
  }

  # ---------- 2.5 内嵌 CLI（prod / beta 渠道） ----------
  # 正式包把 CLI 一起分发；dev 渠道的 prepare 只会塞入 next 快照版，
  # 因此 prod / beta 需要自己装一个发布版本，否则包内缺失 CLI、装完连不上后端。
  $cliVersion = if ($SidecarCli -eq "auto") { $Version } else { $SidecarCli }
  if ($cliVersion -eq "none") {
    Log ">>> 内嵌 CLI  [已禁用]"
  } elseif ($Channel -eq "dev") {
    Log ">>> 内嵌 CLI  [dev 渠道由 prepare 下载快照版，忽略 -SidecarCli]"
  } else {
    $cliExe = Join-Path $desktopDir "resources\opencode-cli.exe"
    $cliTmp = Join-Path $env:TEMP ("opencode-cli-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $cliTmp -Force | Out-Null
    try {
      Invoke-Step "下载 CLI $cliVersion" $cliTmp {
        bun add --no-save --exact --os=win32 --cpu=x64 "opencode-ai@$cliVersion"
      }
      $src = Join-Path $cliTmp "node_modules\opencode-ai\bin\opencode.exe"
      if (-not (Test-Path -LiteralPath $src)) { throw "未在 opencode-ai@$cliVersion 中找到 Windows CLI 二进制" }
      Copy-Item -LiteralPath $src -Destination $cliExe -Force
      $sizeMB = [math]::Round((Get-Item -LiteralPath $cliExe).Length / 1MB, 1)
      Log "  内嵌 CLI <- $src (${sizeMB}MB)"
    } finally {
      if (Test-Path -LiteralPath $cliTmp) { Remove-Tree $cliTmp | Out-Null }
    }
  }

  # ---------- 3. 渲染进程 / 主进程构建 ----------
  if ($SkipBuild) {
    Log ">>> electron-vite build  [已跳过]"
  } else {
    $env:NODE_OPTIONS = "--max-old-space-size=4096"
    Invoke-Step "electron-vite build" $desktopDir { bunx electron-vite build }
  }

  # ---------- 4. 打包 Windows 安装包 ----------
  if (-not $SkipPackage) {
    Invoke-Step "electron-builder" $desktopDir {
      bunx electron-builder --win --publish never --config electron-builder.config.ts
    }
  }

  # ---------- 5. 校验产物 ----------
  $exe = Join-Path $desktopDir "dist\opencode-desktop-win-x64.exe"
  if (Test-Path -LiteralPath $exe) {
    $sizeMB = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    $meta = (Get-Item $exe).VersionInfo
    Log "产物: $exe"
    Log "  大小 = ${sizeMB}MB   版本 = $($meta.ProductVersion)   名称 = $($meta.ProductName)"
  } else {
    $entries = @(Get-ChildItem (Join-Path $desktopDir "dist") -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
    Log "!!! 未生成安装包，dist 内容: $($entries -join ', ')"
    if (-not $SkipPackage) { throw "未找到产物 $exe" }
    Log "  （-SkipPackage 已指定，视为正常）"
  }
} catch {
  $failed = $true
  Log "!!! 打包中止: $($_.Exception.Message)"
} finally {
  $elapsed = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
  Log "=== 总结 ==="
  Log ("  版本 = {0}  渠道 = {1}" -f $Version, $Channel)
  Log ("  总耗时 = {0}s" -f $elapsed)
  Log ("  结果 = {0}" -f $(if ($failed) { "FAILED" } else { "OK" }))
  Log "=== package end $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
}

if ($failed) { exit 1 }
exit 0
