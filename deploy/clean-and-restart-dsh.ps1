# 清理 dsh-auth-* cookie 后启动 DeepSeek Harness
#
# 背景：桌面端每次启动都会新增一条 dsh-auth-<random> cookie，累积到 16 KB 会撑爆
#       Node 默认的 maxHeaderSize，导致 "Web authentication failed" 启动崩溃。
# 用法：
#   1. 完全退出 DeepSeek Harness（含托盘图标）
#   2. 运行本脚本：pwsh -ExecutionPolicy Bypass -File deploy/clean-and-restart-dsh.ps1
#      脚本会先清理 cookie，再启动 DSH。
#
# 参数：
#   -NoStart   只清理，不启动 DSH

param([switch]$NoStart)

$ErrorActionPreference = 'Stop'
$dshExe = 'G:\DeepSeek Harness\DeepSeek Harness.exe'
$cleaner = Join-Path $PSScriptRoot 'clean-dsh-auth-cookies.mjs'

if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
  Write-Host 'DeepSeek Harness 仍在运行。请先完全退出（含托盘图标），再运行本脚本。'
  exit 2
}

Write-Host '=== 清理 dsh-auth-* cookie ==='
& node $cleaner
if ($LASTEXITCODE -ne 0) {
  Write-Host "清理脚本失败（退出码 $LASTEXITCODE），不启动 DSH。"
  exit $LASTEXITCODE
}

if ($NoStart) {
  Write-Host '已完成清理（-NoStart，不启动 DSH）。'
  exit 0
}

Write-Host '=== 启动 DeepSeek Harness ==='
Start-Process $dshExe
Write-Host '已启动。'
