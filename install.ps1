# install.ps1 — Windows (PowerShell 5.1+) 安装脚本
#
# 原理：Kilo 与 OpenCode 都会自动加载全局 plugins 目录下的 *.js 文件，
# 因此这里只做“复制文件”，不修改任何 json/jsonc 配置文件，规避 JSONC 注释
# 被 PowerShell 重写破坏的问题。
#
# 用法（在插件目录下）：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# 或右键“使用 PowerShell 运行”。

$ErrorActionPreference = "Stop"

$PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$IndexFile = Join-Path $PluginDir "index.js"
$HomeDir   = $env:USERPROFILE

if (-not (Test-Path -LiteralPath $IndexFile)) {
  throw "index.js not found: $IndexFile"
}

# Kilo 全局 plugins 目录
$KiloPlugins = Join-Path $HomeDir ".config\kilo\plugins"
New-Item -ItemType Directory -Force -Path $KiloPlugins | Out-Null
# 清理历史遗留的旧版 cmdcode 插件文件，避免重复注册
Get-ChildItem -LiteralPath $KiloPlugins -Filter "cmdcode*.js" -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $IndexFile -Destination (Join-Path $KiloPlugins "command-code.js") -Force
Write-Host "Installed to Kilo: $KiloPlugins\command-code.js"

# OpenCode 全局 plugins 目录
$OcPlugins = Join-Path $HomeDir ".config\opencode\plugins"
New-Item -ItemType Directory -Force -Path $OcPlugins | Out-Null
Copy-Item -LiteralPath $IndexFile -Destination (Join-Path $OcPlugins "command-code.js") -Force
Write-Host "Installed to OpenCode: $OcPlugins\command-code.js"

# 提示：若配置文件的 "plugin" 数组里已经写了 npm 包 "kilo-opencode-command-code"，
# 本地插件与同名 npm 插件会被分别加载（重复注册），二选一即可。
$configs = @(
  (Join-Path $HomeDir ".config\kilo\kilo.jsonc"),
  (Join-Path $HomeDir ".config\kilo\opencode.json"),
  (Join-Path $HomeDir ".config\opencode\opencode.json")
)
foreach ($cfg in $configs) {
  if (Test-Path -LiteralPath $cfg) {
    $text = Get-Content -LiteralPath $cfg -Raw -ErrorAction SilentlyContinue
    if ($text -and $text -match "kilo-opencode-command-code") {
      Write-Warning "Found npm plugin 'kilo-opencode-command-code' in $cfg. Remove it to avoid loading the plugin twice (local plugins and npm plugins are loaded separately)."
    }
  }
}

Write-Host ""
Write-Host "Done! Restart Kilo / OpenCode, then run:"
Write-Host "  kilo auth login -p cmdcode"
Write-Host "  opencode auth login"
