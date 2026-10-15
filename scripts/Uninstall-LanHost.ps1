# Open the same management window; removal requires its explicit Uninstall confirmation.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$setup=Join-Path $PSScriptRoot 'WebZoom-LAN-Setup.exe'
if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw '请运行配套的 WebZoom-LAN-Setup.exe 并点击「卸载」。' }
& $setup
