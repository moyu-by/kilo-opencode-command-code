# install.ps1 — Windows (PowerShell 5.1+) 安装脚本
#
# 原理：Kilo 与 OpenCode 都会自动加载全局 plugins 目录下的 *.js 文件，
# 因此这里只做“复制文件”，不修改任何 json/jsonc 配置文件，规避 JSONC 注释
# 被 PowerShell 重写破坏的问题。
#
# 用法（在插件目录下）：
#   双击 install.cmd（推荐：自动绕过执行策略限制）
#   或 powershell -ExecutionPolicy Bypass -File .\install.ps1
#   （执行策略为 Restricted 时直接 .\install.ps1 会被拒绝，这是 Windows 默认行为）

$ErrorActionPreference = "Stop"

$PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$IndexFile = Join-Path $PluginDir "index.js"

# 当前用户主目录：优先 .NET API，避免 $env:USERPROFILE 缺失或被污染的边缘情况。
$HomeDir = [Environment]::GetFolderPath("UserProfile")
if (-not $HomeDir) { $HomeDir = $env:USERPROFILE }

# 配置根目录：与插件 authRoots 保持一致，支持 XDG_CONFIG_HOME。
$ConfigHome = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HomeDir ".config" }

if (-not (Test-Path -LiteralPath $IndexFile)) {
  throw "index.js not found: $IndexFile"
}

# Kilo 全局 plugins 目录
$KiloPlugins = Join-Path $ConfigHome "kilo\plugins"
New-Item -ItemType Directory -Force -Path $KiloPlugins | Out-Null
# 清理历史遗留的旧版 cmdcode 插件文件，避免重复注册（只删已知的旧文件名）
$LegacyPluginNames = @("cmdcode.js", "cmdcode-models.js", "cmdcode-auth.js")
Get-ChildItem -LiteralPath $KiloPlugins -File -ErrorAction SilentlyContinue |
  Where-Object { $LegacyPluginNames -contains $_.Name } |
  Remove-Item -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $IndexFile -Destination (Join-Path $KiloPlugins "command-code.js") -Force
Write-Host "Installed to Kilo: $KiloPlugins\command-code.js"

# OpenCode 全局 plugins 目录
$OcPlugins = Join-Path $ConfigHome "opencode\plugins"
New-Item -ItemType Directory -Force -Path $OcPlugins | Out-Null
Copy-Item -LiteralPath $IndexFile -Destination (Join-Path $OcPlugins "command-code.js") -Force
Write-Host "Installed to OpenCode: $OcPlugins\command-code.js"

# 提示：plugins 目录里的文件与配置文件 "plugin" 数组里的条目会被分别加载，
# 同一个插件命中两处就会重复注册，二选一即可。
$configs = @(
  (Join-Path $ConfigHome "kilo\kilo.jsonc"),
  (Join-Path $ConfigHome "kilo\kilo.json"),
  (Join-Path $ConfigHome "opencode\opencode.json"),
  (Join-Path $ConfigHome "opencode\opencode.jsonc")
)
foreach ($cfg in $configs) {
  if (-not (Test-Path -LiteralPath $cfg)) { continue }
  $text = Get-Content -LiteralPath $cfg -Raw -ErrorAction SilentlyContinue
  if (-not $text) { continue }

  # 必须精确匹配引号内的包名：仓库目录名也叫这个，指向本地目录的 file:// 引用
  # 不能被误判成 npm 插件。
  if ($text -match '"(kilo-opencode-command-code)(@[^"]*)?"') {
    Write-Warning "Found npm plugin 'kilo-opencode-command-code' in $cfg. Remove it to avoid loading the plugin twice (local plugins and npm plugins are loaded separately)."
  }

  # 指向本插件仓库/拷贝的 file:// 引用：与刚复制到 plugins 目录的文件也会重复加载。
  if ($text -match 'file://[^"]*kilo-opencode-command-code') {
    Write-Warning "Found a file:// plugin reference to this repo in $cfg. This installer also copies index.js into the plugins directory; keep only one to avoid loading the plugin twice."
  }
}

Write-Host ""
Write-Host "Done! Restart Kilo / OpenCode, then run:"
Write-Host "  kilo auth login -p cmdcode"
Write-Host "  opencode auth login"
