# Invalid input must fail before building or creating an output directory.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$out=Join-Path $repo ('artifacts\invalid-lan-input-'+[Guid]::NewGuid().ToString('N'))
$cases=@(
 @{origin='https://Approved.Example';testOnly=$true;expected='Origin must match'},
 @{origin='https://approved.example:443';testOnly=$true;expected='Origin must match'},
 @{origin='https://例子.测试';testOnly=$true;expected='Origin must match'},
 @{origin=' https://approved.example';testOnly=$true;expected='Origin must match'},
 @{origin='https://approved.example/';testOnly=$true;expected='Origin must be an exact'},
 @{origin='https://approved.example?query=1';testOnly=$true;expected='Origin must be an exact'},
 @{origin='https://user@approved.example';testOnly=$true;expected='Origin must be an exact'},
 @{origin='http://approved.example';testOnly=$true;expected='Origin must be an exact'},
 @{origin='https://127.0.0.1:8743';testOnly=$false;expected='Localhost packages must use'}
)
foreach($case in $cases){
 $caught=$null
 try { & (Join-Path $PSScriptRoot 'Build-LanClient.ps1') -Origin $case.origin -Port 34567 -TestOnly:$case.testOnly -OutputDirectory $out }
 catch { $caught=$_.Exception.Message }
 if(-not $caught -or -not $caught.StartsWith($case.expected)){throw "Unexpected validation result for $($case.origin): $caught"}
 if(Test-Path -LiteralPath $out){throw 'Invalid input created an output directory.'}
}
Write-Output "LAN package input checks passed: $($cases.Count)"
