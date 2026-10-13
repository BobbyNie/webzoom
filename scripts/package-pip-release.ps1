param(
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$ArtifactDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $sha = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') { throw 'Cannot identify Git commit' }
    $branch = (git branch --show-current).Trim()
    if ($branch -ne 'feature/presenter-feedback-pip') { throw 'Package only the intended UAT branch' }
    $dirty = git status --porcelain
    if ($dirty) { throw 'Commit source changes before packaging the tested build' }
    $run = gh run view $RunId --repo BobbyNie/webzoom --json headSha,conclusion,status,url,jobs | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify workflow result' }
    if ($run.headSha -ne $sha -or $run.status -ne 'completed' -or $run.conclusion -ne 'success') { throw 'Require a successful workflow for this exact commit' }
    foreach ($job in @('Go, browser and workflow checks','Build and test non-root image')) {
        $result = @($run.jobs | Where-Object name -eq $job)
        if ($result.Count -ne 1 -or $result[0].conclusion -ne 'success') { throw "Required job did not pass: $job" }
    }
    $artifact = (Resolve-Path -LiteralPath $ArtifactDirectory).Path
    $image = Join-Path $artifact 'webzoom.tar.gz'
    $identity = Join-Path $artifact 'image-id.txt'
    if (-not (Test-Path -LiteralPath $image) -or -not (Test-Path -LiteralPath $identity)) { throw 'Missing tested image artifact' }
    $imageID = (Get-Content -Raw -LiteralPath $identity).Trim()
    if ($imageID -notmatch '^sha256:[0-9a-f]{64}$') { throw 'Invalid image config ID' }
    # Inspect the Docker archive without extracting paths onto the host.
    $manifest = @(tar -xOf $image manifest.json | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0 -or $manifest.Count -ne 1) { throw 'Expected one saved Docker image' }
    $configPath = $manifest[0].Config
    if ($configPath -notmatch '^[a-zA-Z0-9_/.-]+$' -or $configPath.StartsWith('-') -or $configPath.Contains('..')) { throw 'Unexpected image config path' }
    $config = tar -xOf $image -- $configPath | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $config.os -ne 'linux' -or $config.architecture -ne 'amd64') { throw 'Wrong image platform' }
    if ($config.config.Labels.'org.opencontainers.image.revision' -ne $sha) { throw 'Artifact image is not from this commit' }
    if ($config.config.User -ne '65532:65532' -or $manifest[0].RepoTags -notcontains 'webzoom:local') { throw 'Unexpected image identity/user' }
    $short = $sha.Substring(0, 7)
    $tag = "pip-uat-$short"
    $out = Join-Path $root "artifacts/release-$tag"
    if (Test-Path -LiteralPath $out) { throw 'Output already exists; do not overwrite a previously packaged release' }
    New-Item -ItemType Directory -Path $out | Out-Null
    Copy-Item -LiteralPath $image -Destination (Join-Path $out 'webzoom.tar.gz')
    Copy-Item -LiteralPath $identity -Destination (Join-Path $out 'image-id.txt')
    Copy-Item -LiteralPath (Join-Path $root 'docs/PRESENTER_FEEDBACK.md') -Destination (Join-Path $out 'PRESENTER_FEEDBACK.md')
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $out 'LICENSE')
    Copy-Item -LiteralPath (Join-Path $root 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $out 'THIRD_PARTY_NOTICES.md')
    $deploy = Get-Content -Raw (Join-Path $root 'docs/DEPLOY-PIP-UAT.template.md')
    $deploy = $deploy.Replace('__RELEASE_TAG__', $tag).Replace('__COMMIT__', $sha).Replace('__IMAGE_ID__', $imageID).Replace('__RUN_URL__', $run.url)
    [IO.File]::WriteAllText((Join-Path $out 'DEPLOY-UAT.md'), $deploy, [Text.UTF8Encoding]::new($false))
    $build = [ordered]@{commit=$sha;branch=$branch;tag=$tag;workflowRun=$run.url;imageConfigID=$imageID;platform='linux/amd64';nativeHelper=$false;companyUAT='required'}
    $build | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $out 'BUILD.json')
    $files = @(Get-ChildItem -LiteralPath $out -File | Sort-Object Name)
    $checks = foreach ($file in $files) { '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant(), $file.Name }
    [IO.File]::WriteAllLines((Join-Path $out 'SHA256SUMS.txt'), $checks, [Text.UTF8Encoding]::new($false))
    $zip = Join-Path $out "WebZoom-PiP-UAT-$short.zip"
    Compress-Archive -LiteralPath (@($files.FullName) + @((Join-Path $out 'SHA256SUMS.txt'))) -DestinationPath $zip -CompressionLevel Optimal
    $zipCheck = '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant(), (Split-Path -Leaf $zip)
    [IO.File]::AppendAllText((Join-Path $out 'SHA256SUMS.txt'), $zipCheck + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output "ReleaseTag=$tag"
    Write-Output "ReleaseDirectory=$out"
    Write-Output 'Packaging complete. This script does not create or modify a GitHub Release.'
} finally { Pop-Location }
