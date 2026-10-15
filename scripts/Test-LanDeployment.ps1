# Isolated oc emulator: no network, cluster credentials or actual Kubernetes operations.
$ErrorActionPreference='Stop'
$scriptPath=Join-Path $PSScriptRoot 'Deploy-LanUat.ps1'
$root=Join-Path (Split-Path $PSScriptRoot -Parent) ('artifacts/deploy-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$backup=Join-Path $root 'rollback.json'
$base=@{
 metadata=@{uid='fixture-uid';resourceVersion='123'}
 spec=@{replicas=1;strategy=@{type='Recreate'};template=@{spec=@{
  containers=@(@{name='webzoom';image='registry.example/app:old';env=@(@{name='SSO_CLIENT_SECRET';valueFrom=@{secretKeyRef=@{name='existing-secret';key='client-secret'}}},@{name='ADMIN_USER_IDS';value='fixture-admin'},@{name='LAN_RELAY_ENABLED';value='false'});volumeMounts=@(@{name='data';mountPath='/data'},@{name='ca';mountPath='/etc/webzoom/trust'});securityContext=@{readOnlyRootFilesystem=$true}})
  volumes=@(@{name='data';persistentVolumeClaim=@{claimName='webzoom-data'}},@{name='ca';configMap=@{name='existing-ca'}});imagePullSecrets=@(@{name='existing-pull-secret'})
 }}}
} | ConvertTo-Json -Depth 30
function ConvertTo-Canonical($Value) {
 if ($null -eq $Value) { return $null }
 if ($Value -is [System.Collections.IDictionary]) {
  $out=[ordered]@{}; foreach($key in @($Value.Keys | Sort-Object)) { $out[$key]=ConvertTo-Canonical $Value[$key] }; return $out
 }
 if ($Value -is [pscustomobject]) {
  $out=[ordered]@{}; foreach($key in @($Value.PSObject.Properties.Name | Sort-Object)) { $out[$key]=ConvertTo-Canonical $Value.$key }; return $out
 }
 if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
  $out=@(); foreach($item in $Value) { $out+=,(ConvertTo-Canonical $item) }; return ,$out
 }
 return $Value
}
function Reset-Fixture {
 $global:wzDeployment=$base | ConvertFrom-Json
 $global:wzPatchCount=0; $global:wzStale=$false; $global:wzBadPVC=$false; $global:wzUnhealthy=$false
 if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup }
}
function Assert($Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Expect-Failure([scriptblock]$Run,[string]$Pattern) {
 $errorText='';try { & $Run } catch { $errorText=$_.Exception.Message }
 Assert ($errorText -match $Pattern) "Expected failure '$Pattern', got '$errorText'"
}
function global:oc {
 $global:LASTEXITCODE=0
 switch ($args[0]) {
  'whoami' { return 'offline-fixture' }
  'rollout' { if ($global:wzUnhealthy -and $args -contains '--timeout=60s') { $global:LASTEXITCODE=1 };return 'fixture rollout' }
  'get' {
   if ($args[1] -eq 'deployment') { return ($global:wzDeployment | ConvertTo-Json -Depth 30) }
   if ($args[1] -eq 'pvc') { if ($global:wzBadPVC) {return '{"status":{"phase":"Pending"}}'};return '{"status":{"phase":"Bound"}}' }
   if ($args[1] -eq 'pods') {return 'fixture pod'}
   throw 'Unexpected get'
  }
  'patch' {
   $global:wzPatchCount++
   $p=Get-Content -LiteralPath $args[($args.IndexOf('--patch-file')+1)] -Raw | ConvertFrom-Json
   if ($global:wzStale -or $p[0].op -ne 'test' -or $p[0].value -ne $global:wzDeployment.metadata.resourceVersion) { $global:LASTEXITCODE=1;return 'conflict' }
   Assert ($p[1].op -eq 'test' -and $p[1].value -eq $global:wzDeployment.metadata.uid) 'missing UID guard'
   Assert ($p[2].op -eq 'test' -and $p[2].value -eq $global:wzDeployment.spec.template.spec.containers[0].image) 'missing image guard'
   foreach ($op in @($p | Select-Object -Skip 3)) {
    if ($op.path -eq '/spec/template/spec/containers/0/image') { $global:wzDeployment.spec.template.spec.containers[0].image=$op.value }
    elseif ($op.path -eq '/spec/template/spec/containers/0/env') { $global:wzDeployment.spec.template.spec.containers[0] | Add-Member -NotePropertyName env -NotePropertyValue @($op.value) -Force }
    else { throw "Unexpected patch path: $($op.path)" }
   }
   $global:wzDeployment.metadata.resourceVersion='124'
   return 'fixture patched'
  }
  default { throw "Unexpected oc invocation: $args" }
 }
}
try {
 Reset-Fixture
 & $scriptPath -Image registry.example/app:new -EnableLan -BackupPath $backup
 Assert ($global:wzPatchCount -eq 1) 'upgrade was not atomic'
 $saved=Get-Content -LiteralPath $backup -Raw | ConvertFrom-Json
 Assert ($saved.oldImage -eq 'registry.example/app:old' -and $saved.changedLan -and $saved.oldLan[0].value -eq 'false') 'rollback record incomplete'
 Assert ((Get-Content -LiteralPath $backup -Raw) -notmatch 'fixture-admin|existing-secret') 'backup leaked unrelated configuration'
 $global:wzUnhealthy=$true
 & $scriptPath -Rollback -BackupPath $backup
 $restored=$global:wzDeployment | ConvertTo-Json -Depth 30
 $expected=$base | ConvertFrom-Json; $expected.metadata.resourceVersion='124'
 Assert ((ConvertTo-Canonical $global:wzDeployment | ConvertTo-Json -Depth 30) -eq (ConvertTo-Canonical $expected | ConvertTo-Json -Depth 30)) 'rollback changed unrelated settings'
 $count=$global:wzPatchCount
 & $scriptPath -Rollback -BackupPath $backup
 Assert ($global:wzPatchCount -eq $count) 'rollback not idempotent'
 Reset-Fixture
 & $scriptPath -Image registry.example/app:new -BackupPath $backup
 Assert (-not (Get-Content -LiteralPath $backup -Raw | ConvertFrom-Json).changedLan) 'image-only upgrade changed LAN'
 Assert (($global:wzDeployment.spec.template.spec.containers[0].env | Where-Object name -eq LAN_RELAY_ENABLED).value -eq 'false') 'image-only upgrade enabled LAN'
 & $scriptPath -Rollback -BackupPath $backup
 Reset-Fixture
 $global:wzDeployment.spec.template.spec.containers[0].PSObject.Properties.Remove('env')
 & $scriptPath -Image registry.example/app:new -EnableLan -BackupPath $backup
 & $scriptPath -Rollback -BackupPath $backup
 Assert (@($global:wzDeployment.spec.template.spec.containers[0].env).Count -eq 0) 'rollback did not remove newly introduced flag'
 Reset-Fixture
 $global:wzStale=$true
 Expect-Failure { & $scriptPath -Image registry.example/app:new -EnableLan -BackupPath $backup } 'oc failed'
 Assert ($global:wzDeployment.spec.template.spec.containers[0].image -eq 'registry.example/app:old') 'conflict changed deployment'
 Assert (@(Get-ChildItem -LiteralPath $root -Filter 'webzoom-patch-*').Count -eq 0) 'temporary patch leaked'
 Reset-Fixture
 $global:wzBadPVC=$true
 Expect-Failure { & $scriptPath -Image registry.example/app:new -EnableLan -BackupPath $backup } 'not Bound'
 Assert ($global:wzPatchCount -eq 0 -and -not (Test-Path -LiteralPath $backup)) 'invalid PVC caused writes'
 Reset-Fixture
 Set-Content -LiteralPath $backup -Value 'existing backup'
 Expect-Failure { & $scriptPath -Image registry.example/app:new -EnableLan -BackupPath $backup } 'Backup already exists'
 Assert ((Get-Content -LiteralPath $backup -Raw).Trim() -eq 'existing backup') 'backup overwritten'
 Reset-Fixture
 & $scriptPath -Image registry.example/app:new -EnableLan -BackupPath $backup
 $global:wzDeployment.spec.template.spec.containers[0].image='registry.example/app:someone-else'
 Expect-Failure { & $scriptPath -Rollback -BackupPath $backup } 'Live image changed'
 $global:wzDeployment.spec.template.spec.containers[0].image='registry.example/app:new'
 ($global:wzDeployment.spec.template.spec.containers[0].env | Where-Object name -eq LAN_RELAY_ENABLED).value='false'
 Expect-Failure { & $scriptPath -Rollback -BackupPath $backup } 'LAN setting changed'
 $global:wzDeployment.metadata.uid='different-deployment'
 Expect-Failure { & $scriptPath -Rollback -BackupPath $backup } 'Deployment was recreated'
 Write-Host 'OCP deployment/rollback offline checks passed (no cluster contacted).'
} finally {
 Remove-Item Function:\oc
 if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup }
 # Nonrecursive: fail rather than delete unexpected content.
 Remove-Item -LiteralPath $root
}
