# Build from the same revision as the server image. No installation or admin rights.
param([string]$OutputDirectory = (Join-Path $PSScriptRoot '../artifacts/presenter-overlay-windows-x64'))
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64') {
    throw 'Build this package on Windows x64 with PowerShell 7 and Go.'
}
$Root = Split-Path $PSScriptRoot -Parent
Push-Location $Root
try {
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    $OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
    $Binary = Join-Path $OutputDirectory 'WebZoomOverlay.exe'
    go build -trimpath -ldflags='-s -w' -o $Binary ./cmd/webzoom-overlay
    if ($LASTEXITCODE -ne 0) { throw 'Helper build failed.' }
    Copy-Item -LiteralPath (Join-Path $Root 'docs/PRESENTER_OVERLAY.md') -Destination (Join-Path $OutputDirectory 'README.md')
    $Revision = git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Cannot determine source revision.' }
    $Dirty = [bool](git status --porcelain)
    "Source revision: $Revision`nUncommitted changes: $Dirty`nPlatform: Windows x64`nExperimental UAT build. Unsigned; requires company approval." | Set-Content -LiteralPath (Join-Path $OutputDirectory 'BUILD.txt') -Encoding utf8
    $Hashes = foreach ($Name in @('WebZoomOverlay.exe', 'README.md', 'BUILD.txt')) {
        $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $OutputDirectory $Name)).Hash.ToLowerInvariant()
        "$Hash  $Name"
    }
    $Hashes | Set-Content -LiteralPath (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Encoding ascii
    Write-Host "Portable helper package: $OutputDirectory"
} finally { Pop-Location }
