# Updates one existing Deployment atomically; never reapplies YAML or creates resources.
[CmdletBinding(DefaultParameterSetName='Deploy')]
param(
 [Parameter(Mandatory=$true,ParameterSetName='Deploy')][string]$Image,
 [Parameter(ParameterSetName='Deploy')][switch]$EnableLan,
 [Parameter(Mandatory=$true,ParameterSetName='Rollback')][switch]$Rollback,
 [Parameter(Mandatory=$true)][string]$BackupPath,
 [string]$Namespace='webzoom-uat',
 [string]$Deployment='webzoom',
 [string]$Container='webzoom',
 [string]$DataClaim='webzoom-data'
)
$ErrorActionPreference='Stop'
function Invoke-CheckedOc {
 $result = & oc @args
 if ($LASTEXITCODE -ne 0) { throw 'oc failed. Stopped; do not reapply old YAML. Keep this backup for diagnosis/rollback.' }
 return $result
}
function Write-NewUtf8([string]$File,[string]$Text) {
 $stream=[IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
 try { $bytes=[Text.Encoding]::UTF8.GetBytes($Text); $stream.Write($bytes,0,$bytes.Length); $stream.Flush() }
 finally { $stream.Dispose() }
}
function Get-LanSetting($EnvList) { return @($EnvList | Where-Object { $_.name -eq 'LAN_RELAY_ENABLED' }) }
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
function Same-Setting($A,$B) { return ((ConvertTo-Json -InputObject (ConvertTo-Canonical $A) -Depth 20 -Compress) -ceq (ConvertTo-Json -InputObject (ConvertTo-Canonical $B) -Depth 20 -Compress)) }
if ($Image -and $Image -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._:/@-]+$') { throw 'Invalid image reference.' }
$backup=[IO.Path]::GetFullPath($BackupPath)
if (-not (Test-Path -LiteralPath (Split-Path $backup -Parent) -PathType Container)) { throw 'Backup parent folder does not exist.' }
$record=$null
if ($Rollback) {
 $record=Get-Content -LiteralPath $backup -Raw | ConvertFrom-Json
 if ($record.schema -ne 1 -or $record.namespace -cne $Namespace -or $record.deployment -cne $Deployment -or $record.container -cne $Container -or $record.dataClaim -cne $DataClaim) { throw 'Backup does not match this deployment.' }
 if ($record.changedLan -isnot [bool] -or @($record.oldLan).Count -gt 1 -or (@($record.oldLan).Count -eq 1 -and $record.oldLan[0].name -cne 'LAN_RELAY_ENABLED')) { throw 'Invalid LAN rollback record.' }
 if ($record.oldImage -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._:/@-]+$' -or -not $record.deploymentUID) { throw 'Invalid backup.' }
}
Invoke-CheckedOc whoami | Out-Host
# An unhealthy NEW rollout must still be recoverable, so only upgrade requires a healthy baseline.
if (-not $Rollback) { Invoke-CheckedOc rollout status "deployment/$Deployment" -n $Namespace --timeout=60s | Out-Host }
$d=Invoke-CheckedOc get deployment $Deployment -n $Namespace -o json | Out-String | ConvertFrom-Json
if ($d.spec.replicas -ne 1 -or $d.spec.strategy.type -cne 'Recreate') { throw 'Expected the existing single-replica Recreate deployment. No changes made.' }
$containers=@($d.spec.template.spec.containers)
$indices=@(for($j=0;$j -lt $containers.Count;$j++){if($containers[$j].name -ceq $Container){$j}})
if ($indices.Count -ne 1) { throw 'Expected one matching container.' }
$index=$indices[0]; $c=$containers[$index]
$mount=@($c.volumeMounts | Where-Object { $_.mountPath -ceq '/data' -and -not $_.readOnly })
if ($mount.Count -ne 1) { throw 'Expected one writable /data mount.' }
$volume=@($d.spec.template.spec.volumes | Where-Object { $_.name -ceq $mount[0].name })
if ($volume.Count -ne 1 -or $volume[0].persistentVolumeClaim.claimName -cne $DataClaim -or $volume[0].persistentVolumeClaim.readOnly) { throw 'Existing data PVC does not match; no storage changes allowed.' }
$pvc=Invoke-CheckedOc get pvc $DataClaim -n $Namespace -o json | Out-String | ConvertFrom-Json
if ($pvc.status.phase -cne 'Bound') { throw 'Data PVC is not Bound.' }
if (-not $d.metadata.uid -or -not $d.metadata.resourceVersion -or -not $c.image) { throw 'Incomplete live deployment identity.' }
$oldLan=@(Get-LanSetting $c.env)
if ($oldLan.Count -gt 1) { throw 'Duplicate LAN_RELAY_ENABLED entries; no changes made.' }
$nextEnv=@($c.env | Where-Object { $null -ne $_ -and $_.name -cne 'LAN_RELAY_ENABLED' })
$changeLan=$false
if ($Rollback) {
 if ($d.metadata.uid -cne $record.deploymentUID) { throw 'Deployment was recreated; refusing stale rollback.' }
 $expected=@(); if ($record.changedLan) { $expected=@([pscustomobject]@{name='LAN_RELAY_ENABLED';value='true'}) }
 if ($c.image -ceq $record.oldImage -and (-not $record.changedLan -or (Same-Setting $oldLan @($record.oldLan)))) { Write-Host 'Already rolled back; no changes made.'; return }
 if ($c.image -cne $record.newImage) { throw 'Live image changed since this release; refusing to overwrite another deployment.' }
 if ($record.changedLan -and -not (Same-Setting $oldLan $expected)) { throw 'LAN setting changed since this release; manual review required.' }
 $target=$record.oldImage
 if ($record.changedLan) { $changeLan=$true; $nextEnv+=@($record.oldLan | Where-Object { $null -ne $_ }) }
} else {
 $target=$Image
 $wantLan=@([pscustomobject]@{name='LAN_RELAY_ENABLED';value='true'})
 $changeLan=$EnableLan -and -not (Same-Setting $oldLan $wantLan)
 if ($c.image -ceq $target -and -not $changeLan) { Write-Host 'Target image/settings already healthy; backup untouched.'; return }
 if (Test-Path -LiteralPath $backup) { throw 'Backup already exists; never overwrite it. Review prior attempt before retrying.' }
 if ($changeLan) { $nextEnv+=$wantLan }
 $record=[ordered]@{schema=1;createdUTC=[DateTime]::UtcNow.ToString('o');namespace=$Namespace;deployment=$Deployment;container=$Container;dataClaim=$DataClaim;deploymentUID=$d.metadata.uid;oldImage=$c.image;newImage=$target;changedLan=[bool]$changeLan;oldLan=@($oldLan)}
}
# ResourceVersion prevents overwriting an admin/SSO/env change made after the read.
$patch=@(@{op='test';path='/metadata/resourceVersion';value=$d.metadata.resourceVersion},@{op='test';path='/metadata/uid';value=$d.metadata.uid},@{op='test';path="/spec/template/spec/containers/$index/image";value=$c.image},@{op='replace';path="/spec/template/spec/containers/$index/image";value=$target})
if ($changeLan) { $patch+=@{op='add';path="/spec/template/spec/containers/$index/env";value=@($nextEnv)} }
$patchFile=Join-Path ([IO.Path]::GetDirectoryName($backup)) ('webzoom-patch-'+[Guid]::NewGuid().ToString('N')+'.json')
try {
 # This temporary patch can contain live env values. Keep locally; delete in finally, never upload it.
 Write-NewUtf8 $patchFile (ConvertTo-Json -InputObject @($patch) -Depth 30)
 if (-not $Rollback) { Write-NewUtf8 $backup ($record | ConvertTo-Json -Depth 25); Write-Host "Saved rollback record: $backup (not a PVC data backup)." }
 Invoke-CheckedOc patch deployment $Deployment -n $Namespace --type=json --patch-file $patchFile | Out-Host
} finally { if (Test-Path -LiteralPath $patchFile -PathType Leaf) { Remove-Item -LiteralPath $patchFile } }
Invoke-CheckedOc rollout status "deployment/$Deployment" -n $Namespace --timeout=300s | Out-Host
$after=Invoke-CheckedOc get deployment $Deployment -n $Namespace -o json | Out-String | ConvertFrom-Json
$actual=@($after.spec.template.spec.containers | Where-Object { $_.name -ceq $Container })
if ($after.metadata.uid -cne $d.metadata.uid -or $actual.Count -ne 1 -or $actual[0].image -cne $target) { throw 'Post-rollout image/identity mismatch.' }
if ($changeLan -and -not (Same-Setting @(Get-LanSetting $actual[0].env) @(Get-LanSetting $nextEnv))) { throw 'Post-rollout LAN setting mismatch.' }
Invoke-CheckedOc get pods -n $Namespace -o wide | Out-Host
Write-Host 'Rollout verified. Next: check SSO, page version, existing settings and the three-PC LAN test.'
