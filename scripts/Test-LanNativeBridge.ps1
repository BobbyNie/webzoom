# Creates one unique test-only HKCU native-host key and removes exactly that key in finally.
# Does not touch com.webzoom.lan, daily Chrome profiles, firewall, or production settings.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$id=[Guid]::NewGuid().ToString('N')
$hostName="com.webzoom.lan_test_$id"
$dir=Join-Path $repo "artifacts\native-bridge-$id"
New-Item -ItemType Directory -Path $dir | Out-Null
$exe=Join-Path $dir 'webzoom-lan-host.exe'
Push-Location $repo
try {
 & go test -count=1 -tags lanintegration -run TestUserRegistryRealIsolatedKey ./internal/lansetup
 if($LASTEXITCODE -ne 0){throw 'Isolated registry backend test failed.'}
} finally { Pop-Location }
Push-Location $repo
try { & go build -trimpath -o $exe ./cmd/lanhost; if($LASTEXITCODE -ne 0){throw 'Native fixture build failed.'} } finally { Pop-Location }
$utf8=New-Object System.Text.UTF8Encoding($false)
$extensionId='hmeoffkckocfjcblblfhpmjcighdehfa'
# An intentionally non-interface address makes both diagnose and start fail before socket bind.
$policy=@{origin='https://127.0.0.1:8743';extensionId=$extensionId;interfaceIP='0.0.0.0';port=34567;maxMbps=8}
[IO.File]::WriteAllText((Join-Path $dir 'policy.json'),($policy|ConvertTo-Json),$utf8)
$manifest=Join-Path $dir 'test-host.json'
$config=@{name=$hostName;description='WebZoom isolated native IPC test';path=$exe;type='stdio';allowed_origins=@("chrome-extension://$extensionId/")}
[IO.File]::WriteAllText($manifest,($config|ConvertTo-Json),$utf8)
$key="HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
if(Test-Path -LiteralPath $key){throw 'Unexpected pre-existing test key; nothing changed.'}
$created=$false
$previous=$env:WEBZOOM_TEST_NATIVE_HOST
try {
 New-Item -Path $key | Out-Null
 $created=$true
 Set-Item -LiteralPath $key -Value $manifest
 $env:WEBZOOM_TEST_NATIVE_HOST=$hostName
 Push-Location (Join-Path $repo 'web')
 try { & npx playwright test --config playwright.native.config.ts; if($LASTEXITCODE -ne 0){throw 'Real native bridge test failed.'} } finally { Pop-Location }
} finally {
 $env:WEBZOOM_TEST_NATIVE_HOST=$previous
 if($created -and (Test-Path -LiteralPath $key)) {
  $registered=(Get-Item -LiteralPath $key).GetValue('')
  if($registered -and $registered -ne $manifest){throw 'Test key was changed by another process; left untouched for inspection.'}
  Remove-Item -LiteralPath $key
  Write-Output "Removed isolated test registration: $hostName"
 }
}
