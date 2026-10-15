[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$Origin,
 [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
 [switch]$TestOnly,
 [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$uri = [Uri]$Origin
if ($uri.Scheme -ne 'https' -or -not $uri.Host -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or $Origin.EndsWith('/')) { throw 'Origin must be an exact HTTPS origin without a trailing slash.' }
# The browser sends its serialized origin, not the operator's spelling. Reject
# aliases (uppercase/default port/Unicode) rather than shipping a mismatched policy.
$canonical = $uri.GetComponents([UriComponents]::SchemeAndServer,[UriFormat]::UriEscaped)
if ($Origin -cne $canonical -or $Origin -match '[^\x21-\x7e]') { throw 'Origin must match the browser HTTPS origin exactly: lowercase ASCII host, no default :443, whitespace or Unicode (use the punycode hostname).' }
if ($uri.IsLoopback -and -not $TestOnly) { throw 'Localhost packages must use -TestOnly; they cannot be installed.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'artifacts\lan-client' }
$out = [IO.Path]::GetFullPath($OutputDirectory)
$extension = Join-Path $out 'extension'
$native = Join-Path $out 'native'
New-Item -ItemType Directory -Force -Path $extension,$native | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$extensionFiles = @('manifest.json','background.js','content.js','popup.html','popup.js','messages.js','diagnostic-client.js')
foreach ($name in $extensionFiles) { Copy-Item -LiteralPath (Join-Path $repo "clients\chrome\$name") -Destination (Join-Path $extension $name) }
$manifestPath = Join-Path $extension 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest | Add-Member -NotePropertyName content_scripts -NotePropertyValue @(@{matches=@("https://$($uri.Host)/m/*");js=@('content.js');run_at='document_start';all_frames=$false}) -Force
[IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 10),$utf8)
[IO.File]::WriteAllText((Join-Path $extension 'policy.js'),('export const origin = ' + (ConvertTo-Json $Origin -Compress) + ';'),$utf8)
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = $sha.ComputeHash([Convert]::FromBase64String($manifest.key)) } finally { $sha.Dispose() }
$id = -join (0..15 | ForEach-Object { [char](97 + ($hash[$_] -shr 4)); [char](97 + ($hash[$_] -band 15)) })
$nonce = [Guid]::NewGuid().ToString('N')
$stub = Join-Path $out "setup-stub-$nonce.exe"
$archive = Join-Path $out "payload-$nonce.zip"
$next = Join-Path $out "setup-next-$nonce.exe"
$oldOS,$oldArch = $env:GOOS,$env:GOARCH
try {
 $env:GOOS='windows'; $env:GOARCH='amd64'
 Push-Location $repo
 try {
  & go build -trimpath -o (Join-Path $native 'webzoom-lan-host.exe') ./cmd/lanhost
  if ($LASTEXITCODE -ne 0) { throw 'Native host build failed.' }
  & go build -trimpath -ldflags '-H windowsgui' -o $stub ./cmd/lansetup
  if ($LASTEXITCODE -ne 0) { throw 'Setup build failed.' }
 } finally { Pop-Location }
} finally { $env:GOOS=$oldOS; $env:GOARCH=$oldArch }
$config = @{origin=$Origin;extensionId=$id;port=$Port;testOnly=[bool]$TestOnly}
[IO.File]::WriteAllText((Join-Path $native 'bundle.json'),($config | ConvertTo-Json),$utf8)
# Explicit entries only: stale files from older builds cannot enter the executable.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
try {
 foreach ($name in ($extensionFiles + @('policy.js'))) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $extension $name),"extension/$name") | Out-Null }
 foreach ($name in @('webzoom-lan-host.exe','bundle.json')) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $native $name),"native/$name") | Out-Null }
} finally { $zip.Dispose() }
Push-Location $repo
try {
 & go run ./cmd/lanpack $stub $archive $next
 if ($LASTEXITCODE -ne 0) { throw 'Self-contained setup packaging failed.' }
} finally { Pop-Location }
# All paths below are explicit files generated in this output directory, never recursive operations.
$setup = Join-Path $out 'WebZoom-LAN-Setup.exe'
Move-Item -LiteralPath $next -Destination $setup -Force
Remove-Item -LiteralPath $stub,$archive
Copy-Item -LiteralPath (Join-Path $repo 'docs\LAN_CLIENT_QUICKSTART.md') -Destination (Join-Path $out '使用说明.md')
foreach ($name in @('Install-LanHost.ps1','Uninstall-LanHost.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $out $name) }
$sum = Get-FileHash -LiteralPath $setup -Algorithm SHA256
[IO.File]::WriteAllText((Join-Path $out 'SHA256SUMS.txt'),($sum.Hash.ToLowerInvariant() + '  WebZoom-LAN-Setup.exe' + [Environment]::NewLine),$utf8)
$sum | Select-Object Hash,Path
Write-Output "Built extension ID: $id"
Write-Output 'Self-contained EXE created; nothing installed. This is an unsigned development candidate, not a production approval.'
if ($TestOnly) { Write-Output 'TEST ONLY: this package refuses installation and uninstall operations.' }
