# 修复 DSH desktop profile 的 pnpm 依赖树
#
# 症状：node_modules/.pnpm 被清空（0 条目），插件目录还在但依赖链接全部断裂，
#       所有插件运行时 import 失败 → 插件"全部不生效"。
# 原因：10:07–10:41 那轮插件管理器的 pnpm 安装/卸载中断，留下半成品 node_modules。
#
# 用法（必须完全退出 DeepSeek Harness，含托盘图标）：
#   pwsh -ExecutionPolicy Bypass -File deploy/restore-dsh-plugins.ps1
#
# 脚本会：备份损坏的 node_modules → 用 DSH 自带 pnpm 按 lockfile 重装 → 校验 .pnpm 条目数。
# 失败会自动把原 node_modules 恢复回来。

$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$nodeExe = 'G:\DeepSeek Harness\resources\runtime\bin\node.cmd'
$pnpmCli = 'G:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs'

if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
  throw 'DeepSeek Harness 仍在运行，请先完全退出（含托盘图标）再执行。'
}
if (-not (Test-Path $pnpmCli)) { throw "找不到 pnpm：$pnpmCli" }
if (-not (Test-Path $profileDir)) { throw "找不到 profile：$profileDir" }

$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$nm = Join-Path $profileDir 'node_modules'
$backup = Join-Path $profileDir "node_modules.broken-$ts"

if (Test-Path $nm) {
  Rename-Item $nm $backup
  Write-Host "已把损坏的 node_modules 移到：$backup"
}

Push-Location $profileDir
try {
  & $nodeExe $pnpmCli install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "pnpm install 退出码 $LASTEXITCODE" }
} catch {
  Write-Host "重装失败：$_"
  Write-Host '回滚到原 node_modules……'
  if (Test-Path $nm) { Remove-Item $nm -Recurse -Force }
  Rename-Item $backup $nm
  throw
} finally {
  Pop-Location
}

$pnpmDir = Join-Path $nm '.pnpm'
$pnpmCount = if (Test-Path $pnpmDir) { (Get-ChildItem $pnpmDir -Directory -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 }
Write-Host ".pnpm 条目数：$pnpmCount"
if ($pnpmCount -eq 0) { throw '重装后 .pnpm 仍为空，请把上方 pnpm 输出发出来' }

Write-Host '完成。可以启动 DeepSeek Harness 了。'
Write-Host "（损坏副本保留在：$backup，确认正常后可手动删除）"
