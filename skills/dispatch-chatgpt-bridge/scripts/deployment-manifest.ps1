$script:DeploymentManifestFileName = 'deployment-manifest.json'
$script:DeploymentManifestSchemaVersion = 1

function ConvertTo-CanonicalValue {
  param([AllowNull()][object]$Value)

  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Collections.IDictionary]) {
    $ordered = [ordered]@{}
    foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
      $ordered[$key] = ConvertTo-CanonicalValue -Value $Value[$key]
    }
    return $ordered
  }
  if ($Value -is [pscustomobject]) {
    $ordered = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Sort-Object Name)) {
      $ordered[$property.Name] = ConvertTo-CanonicalValue -Value $property.Value
    }
    return $ordered
  }
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    $array = New-Object System.Collections.ArrayList
    foreach ($item in $Value) {
      [void]$array.Add((ConvertTo-CanonicalValue -Value $item))
    }
    return @($array)
  }
  return $Value
}

function ConvertTo-CanonicalJson {
  param([AllowNull()][object]$Value)
  return (ConvertTo-CanonicalValue -Value $Value | ConvertTo-Json -Compress -Depth 100)
}

function Get-Sha256Text {
  param([Parameter(Mandatory = $true)][string]$Text)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Managed file is missing: $Path"
  }
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

function ConvertTo-BridgeAbsolutePath {
  param([Parameter(Mandatory = $true)][string]$Path, [string]$Label = 'path')
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path.IndexOf([char]0) -ge 0) {
    throw "$Label must be an absolute Windows path."
  }
  $drive = $Path -match '^[A-Za-z]:[\\/]'
  $unc = $Path -match '^\\\\[^\\]+\\[^\\]+'
  if (-not $drive -and -not $unc) { throw "$Label must be an absolute Windows path: $Path" }
  return ([IO.Path]::GetFullPath($Path)).TrimEnd('\').ToLowerInvariant()
}

function Get-RelativeManagedPath {
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$File)
  $rootFull = ([IO.Path]::GetFullPath($Root)).TrimEnd('\')
  $fileFull = [IO.Path]::GetFullPath($File)
  if (-not $fileFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Managed file escaped its source root: $File"
  }
  return $fileFull.Substring($rootFull.Length + 1).Replace('\', '/')
}

function Get-ManagedFileInventory {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string[]]$OnlyPaths,
    [string]$RelativePrefix = ''
  )
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    throw "Managed source/target root is missing: $Root"
  }
  if ($OnlyPaths) {
    $files = @($OnlyPaths | ForEach-Object {
      $relative = [string]$_
      if ($relative -match '(^|/)\.\.(/|$)' -or $relative.StartsWith('/')) { throw "Managed path escaped its root: $relative" }
      $full = Join-Path $Root ($relative -replace '/', '\')
      [ordered]@{ path = $(if ($RelativePrefix) { "$RelativePrefix/$relative" } else { $relative }); sha256 = Get-FileSha256 -Path $full }
    })
  } else {
    $files = @(
      Get-ChildItem -LiteralPath $Root -File -Recurse | Where-Object {
        $_.Name -ne 'deployment-manifest.json'
      } | ForEach-Object {
        [ordered]@{
          path = $(if ($RelativePrefix) { "$RelativePrefix/$(Get-RelativeManagedPath -Root $Root -File $_.FullName)" } else { Get-RelativeManagedPath -Root $Root -File $_.FullName })
          sha256 = (Get-FileSha256 -Path $_.FullName)
        }
      }
    )
  }
  $files = @($files | Sort-Object path)
  return @($files)
}

function Get-BridgeSourceCommit {
  param([Parameter(Mandatory = $true)][string]$RepositoryRoot)
  $head = $null
  try {
    $output = & git -C $RepositoryRoot rev-parse HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and ([string]$output).Trim() -match '^[0-9a-fA-F]{40}$') { $head = ([string]$output).Trim().ToLowerInvariant() }
  } catch { }
  if ($head) {
    try {
      $status = @(& git -C $RepositoryRoot status --porcelain --untracked-files=all 2>$null)
      if ($LASTEXITCODE -eq 0 -and $status.Count -eq 0) {
        return [ordered]@{ sourceCommit = $head; sourceCommitStatus = 'exact-clean' }
      }
      return [ordered]@{ sourceCommit = $head; sourceCommitStatus = 'dirty-worktree' }
    } catch {
      return [ordered]@{ sourceCommit = $head; sourceCommitStatus = 'git-status-unavailable' }
    }
  }
  return [ordered]@{ sourceCommit = 'unavailable'; sourceCommitStatus = 'unavailable' }
}

function Get-BridgeVersionMetadata {
  param([Parameter(Mandatory = $true)][string]$RepositoryRoot)
  $metadataPath = Join-Path $RepositoryRoot 'bridge-version.json'
  if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    throw "Bridge version metadata is missing: $metadataPath"
  }
  $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$metadata.bridgeVersion) -or
      [string]::IsNullOrWhiteSpace([string]$metadata.protocolVersion)) {
    throw "Bridge version metadata is invalid: $metadataPath"
  }
  return $metadata
}

function New-BridgeDeploymentManifest {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$SkillSourceRoot,
    [Parameter(Mandatory = $true)][string]$RuntimeSourceRoot,
    [Parameter(Mandatory = $true)][string]$SkillTargetRoot,
    [Parameter(Mandatory = $true)][string]$RuntimeTargetRoot,
    [string]$TransactionId = ''
  )
  $metadata = Get-BridgeVersionMetadata -RepositoryRoot $RepositoryRoot
  $commit = Get-BridgeSourceCommit -RepositoryRoot $RepositoryRoot
  $manifest = [ordered]@{
    schemaVersion = $script:DeploymentManifestSchemaVersion
    bridgeVersion = [string]$metadata.bridgeVersion
    protocolVersion = [string]$metadata.protocolVersion
    sourceCommit = $commit.sourceCommit
    sourceCommitStatus = $commit.sourceCommitStatus
    targets = [ordered]@{
      skill = ConvertTo-BridgeAbsolutePath -Path $SkillTargetRoot -Label 'Skill target'
      runtime = ConvertTo-BridgeAbsolutePath -Path $RuntimeTargetRoot -Label 'Runtime target'
    }
    managedFiles = [ordered]@{
      skill = @(Get-ManagedFileInventory -Root $SkillSourceRoot)
      runtime = @(Get-ManagedFileInventory -Root $RuntimeSourceRoot -RelativePrefix 'windows/scripts')
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($TransactionId)) { $manifest.transactionId = $TransactionId }
  $manifest.manifestHash = Get-Sha256Text -Text (ConvertTo-CanonicalJson -Value $manifest)
  return $manifest
}

function Write-BridgeDeploymentManifest {
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][object]$Manifest)
  $path = Join-Path $Root 'deployment-manifest.json'
  $json = ConvertTo-CanonicalJson -Value $Manifest
  $utf8NoBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($path, $json + "`r`n", $utf8NoBom)
}

function Read-BridgeDeploymentManifest {
  param([Parameter(Mandatory = $true)][string]$Root, [string]$Label = 'deployment manifest')
  $path = Join-Path $Root 'deployment-manifest.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$Label is missing: $path" }
  try { return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json) }
  catch { throw "$Label is not valid JSON: $path" }
}

function Get-ManifestWithoutHash {
  param([Parameter(Mandatory = $true)][object]$Manifest)
  $copy = [ordered]@{}
  if ($Manifest -is [System.Collections.IDictionary]) {
    foreach ($key in $Manifest.Keys) {
      if ([string]$key -ne 'manifestHash') { $copy[[string]$key] = $Manifest[$key] }
    }
  } else {
    foreach ($property in $Manifest.PSObject.Properties) {
      if ($property.Name -ne 'manifestHash') { $copy[$property.Name] = $property.Value }
    }
  }
  return $copy
}

function Get-RecomputedManifestHash {
  param([Parameter(Mandatory = $true)][object]$Manifest)
  return Get-Sha256Text -Text (ConvertTo-CanonicalJson -Value (Get-ManifestWithoutHash -Manifest $Manifest))
}

function Assert-ManifestShape {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$SkillTargetRoot,
    [Parameter(Mandatory = $true)][string]$RuntimeTargetRoot,
    [string]$Label = 'deployment manifest'
  )
  $skillTarget = ConvertTo-BridgeAbsolutePath -Path $SkillTargetRoot -Label 'Skill target'
  $runtimeTarget = ConvertTo-BridgeAbsolutePath -Path $RuntimeTargetRoot -Label 'Runtime target'
  if ([int]$Manifest.schemaVersion -ne $script:DeploymentManifestSchemaVersion) { throw "$Label schemaVersion is invalid." }
  foreach ($field in @('bridgeVersion', 'protocolVersion', 'sourceCommit', 'sourceCommitStatus', 'manifestHash')) {
    if ([string]::IsNullOrWhiteSpace([string]$Manifest.$field)) { throw "$Label field '$field' is missing." }
  }
  if ([string]$Manifest.targets.skill -ne $skillTarget -or [string]$Manifest.targets.runtime -ne $runtimeTarget) {
    throw "$Label target path binding is invalid: $Label=$((Join-Path (Split-Path $SkillTargetRoot -Parent) 'deployment-manifest.json'))"
  }
  $recomputed = Get-RecomputedManifestHash -Manifest $Manifest
  if ([string]$Manifest.manifestHash -ne $recomputed) {
    throw "$Label manifestHash mismatch: expected $recomputed, actual $([string]$Manifest.manifestHash)"
  }
  foreach ($tree in @('skill', 'runtime')) {
    $files = @($Manifest.managedFiles.$tree)
    if ($files.Count -eq 0) { throw "$Label managedFiles.$tree is empty." }
    $paths = @($files | ForEach-Object { [string]$_.path })
    if ($paths.Count -ne @($paths | Sort-Object -Unique).Count) { throw "$Label managedFiles.$tree contains duplicate paths." }
    foreach ($file in $files) {
      $relative = [string]$file.path
      $hash = [string]$file.sha256
      if ([string]::IsNullOrWhiteSpace($relative) -or
          $relative -match '(^|/)\.\.(/|$)' -or
          $relative.StartsWith('/') -or
          $hash -notmatch '^[0-9a-f]{64}$') {
        throw "$Label managed file entry is invalid."
      }
    }
  }
  return $Manifest
}

function Assert-ManifestTrees {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$SkillRoot,
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [string]$Label = 'deployment trees'
  )
  Assert-ManifestShape -Manifest $Manifest -SkillTargetRoot ([string]$Manifest.targets.skill) -RuntimeTargetRoot ([string]$Manifest.targets.runtime) -Label $Label | Out-Null
  $pairs = @(
    @{ name = 'skill'; root = $SkillRoot },
    @{ name = 'runtime'; root = $RuntimeRoot }
  )
  foreach ($pair in $pairs) {
    if (-not (Test-Path -LiteralPath $pair.root -PathType Container)) { throw "$Label $($pair.name) root is missing: $($pair.root)" }
    $expected = @($Manifest.managedFiles.($pair.name))
    $expectedPaths = @($expected | ForEach-Object { [string]$_.path })
    $actual = @(Get-ManagedFileInventory -Root $pair.root -OnlyPaths $expectedPaths)
    $actualPaths = @($actual | ForEach-Object { [string]$_.path })
    if (@(Compare-Object -ReferenceObject $expectedPaths -DifferenceObject $actualPaths).Count -gt 0) {
      throw "$Label $($pair.name) managed file set mismatch: $($pair.root)"
    }
    foreach ($file in $expected) {
      $actualPath = Join-Path $pair.root ([string]$file.path -replace '/', '\')
      $actualHash = Get-FileSha256 -Path $actualPath
      if ($actualHash -ne [string]$file.sha256) { throw "$Label $($pair.name) hash mismatch: $actualPath" }
    }
  }
}

function Assert-ManifestMatchesSource {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$SkillSourceRoot,
    [Parameter(Mandatory = $true)][string]$RuntimeSourceRoot
  )
  foreach ($pair in @(
    @{ name = 'skill'; root = $SkillSourceRoot },
    @{ name = 'runtime'; root = $RuntimeSourceRoot }
  )) {
    $sourceFiles = if ($pair.name -eq 'runtime') {
      @(Get-ManagedFileInventory -Root $pair.root -RelativePrefix 'windows/scripts')
    } else {
      @(Get-ManagedFileInventory -Root $pair.root)
    }
    $manifestFiles = @($Manifest.managedFiles.($pair.name))
    $sourceJson = ConvertTo-CanonicalJson -Value $sourceFiles
    $manifestJson = ConvertTo-CanonicalJson -Value $manifestFiles
    if ($sourceJson -ne $manifestJson) { throw "Source and manifest differ for $($pair.name)." }
  }
}

function Assert-DeploymentPair {
  param(
    [Parameter(Mandatory = $true)][string]$SkillRoot,
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [string]$RepositoryRoot,
    [switch]$RequireSourceMatch
  )
  $skill = Read-BridgeDeploymentManifest -Root $SkillRoot -Label 'Skill deployment manifest'
  $runtime = Read-BridgeDeploymentManifest -Root $RuntimeRoot -Label 'Runtime deployment manifest'
  Assert-ManifestShape -Manifest $skill -SkillTargetRoot $SkillRoot -RuntimeTargetRoot $RuntimeRoot -Label 'Skill deployment manifest' | Out-Null
  Assert-ManifestShape -Manifest $runtime -SkillTargetRoot $SkillRoot -RuntimeTargetRoot $RuntimeRoot -Label 'Runtime deployment manifest' | Out-Null
  if ((ConvertTo-CanonicalJson -Value $skill) -ne (ConvertTo-CanonicalJson -Value $runtime)) {
    throw "Skill and Runtime deployment manifests differ: $SkillRoot and $RuntimeRoot"
  }
  Assert-ManifestTrees -Manifest $skill -SkillRoot $SkillRoot -RuntimeRoot $RuntimeRoot
  if ($RepositoryRoot) {
    $metadata = Get-BridgeVersionMetadata -RepositoryRoot $RepositoryRoot
    $commit = Get-BridgeSourceCommit -RepositoryRoot $RepositoryRoot
    if ([string]$skill.bridgeVersion -ne [string]$metadata.bridgeVersion -or
        [string]$skill.protocolVersion -ne [string]$metadata.protocolVersion -or
        [string]$skill.sourceCommit -ne [string]$commit.sourceCommit -or
        [string]$skill.sourceCommitStatus -ne [string]$commit.sourceCommitStatus) {
      throw "Deployment version/source commit differs from current source: Skill=$SkillRoot Runtime=$RuntimeRoot"
    }
    if ($RequireSourceMatch) { Assert-ManifestMatchesSource -Manifest $skill -SkillSourceRoot (Join-Path $RepositoryRoot 'skills\dispatch-chatgpt-bridge') -RuntimeSourceRoot (Join-Path $RepositoryRoot 'windows\scripts') }
  } elseif ($RequireSourceMatch) {
    throw 'Source matching requires a repository root.'
  }
  return $skill
}
