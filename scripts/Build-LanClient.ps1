[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$Origin,
 [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$uri = [Uri]$Origin
if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or $Origin.EndsWith('/')) { throw 'Origin must be an exact HTTPS origin without a trailing slash.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'artifacts\lan-client' }
$out = [IO.Path]::GetFullPath($OutputDirectory)
$extension = Join-Path $out 'extension'
$native = Join-Path $out 'native'
New-Item -ItemType Directory -Force -Path $extension,$native | Out-Null
foreach ($name in @('manifest.json','background.js','content.js','popup.html')) { Copy-Item -LiteralPath (Join-Path $repo "clients\chrome\$name") -Destination (Join-Path $extension $name) }
$manifestPath = Join-Path $extension 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest | Add-Member -NotePropertyName content_scripts -NotePropertyValue @(@{matches=@("https://$($uri.Host)/m/*");js=@('content.js');run_at='document_start';all_frames=$false}) -Force
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding utf8
("export const origin = " + (ConvertTo-Json $Origin -Compress) + ";") | Set-Content -LiteralPath (Join-Path $extension 'policy.js') -Encoding utf8
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = $sha.ComputeHash([Convert]::FromBase64String($manifest.key)) } finally { $sha.Dispose() }
$id = -join (0..15 | ForEach-Object { [char](97 + ($hash[$_] -shr 4)); [char](97 + ($hash[$_] -band 15)) })
$oldOS,$oldArch = $env:GOOS,$env:GOARCH
try {
 $env:GOOS='windows'; $env:GOARCH='amd64'
 Push-Location $repo
 try { & go build -trimpath -o (Join-Path $native 'webzoom-lan-host.exe') ./cmd/lanhost; if ($LASTEXITCODE -ne 0) { throw 'Native host build failed.' } } finally { Pop-Location }
} finally { $env:GOOS=$oldOS; $env:GOARCH=$oldArch }
@{origin=$Origin;extensionId=$id} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $native 'bundle.json') -Encoding utf8
foreach ($name in @('Install-LanHost.ps1','Uninstall-LanHost.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $out $name) }
Get-ChildItem -LiteralPath $native -File | Get-FileHash -Algorithm SHA256 | Select-Object Hash,Path
Write-Output "Built extension ID: $id"
Write-Output "Package only; nothing installed. Load the extension directory through an approved Chrome channel, then run the per-user installer with the approved adapter and UDP port."
