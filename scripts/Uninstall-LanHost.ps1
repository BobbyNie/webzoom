[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$registry='HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.webzoom.lan'
$base=[IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
$target=[IO.Path]::GetFullPath((Join-Path $base 'WebZoomLAN'))
if ($target -ne ($base+'\WebZoomLAN')) { throw 'Unexpected uninstall target.' }
if (Test-Path -LiteralPath $registry) {
 $registered=(Get-Item -LiteralPath $registry).GetValue('')
 if ($registered -ne (Join-Path $target 'com.webzoom.lan.json')) { throw 'Host registration belongs to another installation; no changes made.' }
 Remove-Item -LiteralPath $registry
}
# Only remove our three known files. No recursive filesystem removal.
foreach($name in @('webzoom-lan-host.exe','policy.json','com.webzoom.lan.json')) {
 $file=Join-Path $target $name
 if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file}
}
Write-Output 'Native host removed. Remove the extension through the approved Chrome management channel separately.'
