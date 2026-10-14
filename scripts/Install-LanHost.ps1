[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$InterfaceIP,
 [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
 [Parameter(Mandatory=$true)][switch]$ApprovedByIT
)
$ErrorActionPreference='Stop'
if (-not $ApprovedByIT) { throw 'IT approval for software, adapter, UDP and firewall policy is required.' }
$ip=[Net.IPAddress]::Parse($InterfaceIP)
if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or [Net.IPAddress]::IsLoopback($ip)) { throw 'An approved non-loopback IPv4 address is required.' }
$source=Join-Path $PSScriptRoot 'native'
$bundle=Get-Content -LiteralPath (Join-Path $source 'bundle.json') -Raw | ConvertFrom-Json
if ($bundle.extensionId -notmatch '^[a-p]{32}$' -or ([Uri]$bundle.origin).Scheme -ne 'https') { throw 'Invalid bundle.' }
$target=Join-Path $env:LOCALAPPDATA 'WebZoomLAN'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'webzoom-lan-host.exe') -Destination (Join-Path $target 'webzoom-lan-host.exe')
$policy=@{origin=$bundle.origin;extensionId=$bundle.extensionId;interfaceIP=$InterfaceIP;port=$Port;maxMbps=8}
$utf8=New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $target 'policy.json'),($policy|ConvertTo-Json),$utf8)
$hostManifest=@{name='com.webzoom.lan';description='WebZoom approved LAN relay';path=(Join-Path $target 'webzoom-lan-host.exe');type='stdio';allowed_origins=@("chrome-extension://$($bundle.extensionId)/")}
$manifestPath=Join-Path $target 'com.webzoom.lan.json'
[IO.File]::WriteAllText($manifestPath,($hostManifest|ConvertTo-Json),$utf8)
$registry='HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.webzoom.lan'
New-Item -Path $registry -Force | Out-Null
Set-Item -LiteralPath $registry -Value $manifestPath
Write-Output 'Installed for this user only. No service, driver, elevation or firewall changes. Use the approved Chrome extension and opt into LAN mode on the meeting page.'
