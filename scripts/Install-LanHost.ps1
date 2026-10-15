# Compatibility launcher. Policy is baked into the EXE; no script-only installation path.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$setup=Join-Path $PSScriptRoot 'WebZoom-LAN-Setup.exe'
if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw '请先构建配套安装包，再运行包内的 WebZoom-LAN-Setup.exe。' }
& $setup
