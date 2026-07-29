$script:DeploymentManifestFileName = 'deployment-manifest.json'
$script:DeploymentManifestSchemaVersion = 1

function Sort-BridgeOrdinalStrings {
  param([AllowNull()][object[]]$Values)
  $sorted = New-Object 'System.Collections.Generic.List[string]'
  foreach ($value in @($Values)) {
    $text = [string]$value
    $index = 0
    while ($index -lt $sorted.Count -and [StringComparer]::Ordinal.Compare($sorted[$index], $text) -le 0) { $index++ }
    $sorted.Insert($index, $text)
  }
  return @($sorted)
}

function Sort-ManagedInventory {
  param([AllowNull()][object[]]$Files)
  $sorted = New-Object System.Collections.ArrayList
  foreach ($file in @($Files)) {
    $index = 0
    while ($index -lt $sorted.Count -and
      [StringComparer]::Ordinal.Compare([string]$sorted[$index].path, [string]$file.path) -le 0) { $index++ }
    [void]$sorted.Insert($index, $file)
  }
  return @($sorted)
}

function Test-JsonInteger {
  param([AllowNull()][object]$Value)
  return $null -ne $Value -and $Value -isnot [bool] -and (
    $Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or
    $Value -is [uint16] -or $Value -is [int32] -or $Value -is [uint32] -or
    $Value -is [int64] -or $Value -is [uint64]
  )
}

function Assert-StrictText {
  param([AllowNull()][object]$Value, [Parameter(Mandatory = $true)][string]$Label)
  if ($null -eq $Value -or $Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) {
    throw "$Label must be a non-empty JSON string."
  }
  return [string]$Value
}

function Get-BridgeObjectKeys {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return @() }
  if ($Value -is [System.Collections.IDictionary]) { return @($Value.Keys | ForEach-Object { [string]$_ }) }
  return @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
}

function Test-BridgeObjectProperty {
  param([AllowNull()][object]$Object, [Parameter(Mandatory = $true)][string]$Name)
  if ($null -eq $Object) { return $false }
  if ($Object -is [System.Collections.IDictionary]) { return $Object.Contains($Name) }
  return $null -ne $Object.PSObject.Properties[$Name]
}

function Assert-BridgeObjectKeys {
  param(
    [AllowNull()][object]$Object,
    [Parameter(Mandatory = $true)][string[]]$Allowed,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($null -eq $Object -or ($Object -isnot [System.Collections.IDictionary] -and $Object -isnot [pscustomobject])) {
    throw "$Label must be a JSON object."
  }
  $allowedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  foreach ($key in $Allowed) { [void]$allowedSet.Add($key) }
  foreach ($key in @(Get-BridgeObjectKeys -Value $Object)) {
    if (-not $allowedSet.Contains([string]$key)) { throw "$Label contains unknown field '$key'." }
  }
}

function Assert-ManagedRelativePath {
  param(
    [AllowNull()][object]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$RequireRuntimePrefix
  )
  if ($null -eq $Path -or $Path -isnot [string]) { throw "$Label must be a JSON string." }
  $relative = [string]$Path
  if ([string]::IsNullOrWhiteSpace($relative) -or
      $relative.IndexOf([char]0) -ge 0 -or
      $relative.IndexOf('\') -ge 0 -or
      $relative.IndexOf(':') -ge 0 -or
      $relative.StartsWith('/') -or
      $relative.EndsWith('/') -or
      $relative.Contains('//')) {
    throw "$Label must be a normalized forward-slash relative path: $relative"
  }
  $segments = $relative.Split('/')
  foreach ($segment in $segments) {
    if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..' -or
        $segment.EndsWith(' ') -or $segment.EndsWith('.')) {
      throw "$Label contains an invalid path segment: $relative"
    }
    if ($segment.IndexOfAny([char[]]'<>|?*"') -ge 0) {
      throw "$Label contains an invalid Windows filename character: $relative"
    }
  }
  if ($RequireRuntimePrefix -and ($segments.Count -lt 3 -or $segments[0] -cne 'windows' -or $segments[1] -cne 'scripts')) {
    throw "$Label must be under windows/scripts/: $relative"
  }
  return $relative
}

function Assert-NoDuplicateManagedPaths {
  param([Parameter(Mandatory = $true)][object[]]$Files, [Parameter(Mandatory = $true)][string]$Label)
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($file in @($Files)) {
    $path = [string]$file.path
    if (-not $seen.Add($path)) { throw "$Label contains duplicate Windows path '$path'." }
  }
}

function ConvertTo-CanonicalValue {
  param([AllowNull()][object]$Value)

  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Collections.IDictionary]) {
    $ordered = [ordered]@{}
    foreach ($key in @(Sort-BridgeOrdinalStrings -Values @($Value.Keys | ForEach-Object { [string]$_ }))) {
      $ordered[$key] = ConvertTo-CanonicalValue -Value $Value[$key]
    }
    return $ordered
  }
  if ($Value -is [pscustomobject]) {
    $ordered = [ordered]@{}
    $properties = @($Value.PSObject.Properties)
    foreach ($name in @(Sort-BridgeOrdinalStrings -Values @($properties | ForEach-Object { [string]$_.Name }))) {
      $ordered[$name] = ConvertTo-CanonicalValue -Value $Value.PSObject.Properties[$name].Value
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
    [string]$RelativePrefix = '',
    [switch]$RequireRuntimePrefix
  )
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    throw "Managed source/target root is missing: $Root"
  }
  if ($OnlyPaths) {
    $files = @($OnlyPaths | ForEach-Object {
      $relative = [string]$_
      Assert-ManagedRelativePath -Path $_ -Label 'Managed file path' -RequireRuntimePrefix:$RequireRuntimePrefix | Out-Null
      $full = Join-Path $Root ($relative -replace '/', '\')
      [ordered]@{ path = $(if ($RelativePrefix) { "$RelativePrefix/$relative" } else { $relative }); sha256 = Get-FileSha256 -Path $full }
    })
  } else {
    $files = @(
      Get-ChildItem -LiteralPath $Root -File -Recurse | Where-Object {
        $_.Name -ne 'deployment-manifest.json'
      } | ForEach-Object {
        $relative = Get-RelativeManagedPath -Root $Root -File $_.FullName
        $fullRelative = if ($RelativePrefix) { "$RelativePrefix/$relative" } else { $relative }
        Assert-ManagedRelativePath -Path $fullRelative -Label 'Managed file inventory path' -RequireRuntimePrefix:($RelativePrefix -eq 'windows/scripts') | Out-Null
        [ordered]@{
          path = $fullRelative
          sha256 = (Get-FileSha256 -Path $_.FullName)
        }
      }
    )
  }
  Assert-NoDuplicateManagedPaths -Files $files -Label 'Managed file inventory'
  $files = @(Sort-ManagedInventory -Files $files)
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
  try { $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json }
  catch { throw "Bridge version metadata is invalid JSON: $metadataPath" }
  Assert-BridgeObjectKeys -Object $metadata -Allowed @('bridgeVersion', 'protocolVersion') -Label 'Bridge version metadata'
  $bridgeVersion = Assert-StrictText -Value $metadata.bridgeVersion -Label 'bridgeVersion'
  $protocolVersion = Assert-StrictText -Value $metadata.protocolVersion -Label 'protocolVersion'
  if ($bridgeVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or
      $protocolVersion -notmatch '^[1-9]\d*$') {
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
  try { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) }
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
  Assert-BridgeObjectKeys -Object $Manifest -Allowed @('schemaVersion', 'bridgeVersion', 'protocolVersion', 'sourceCommit', 'sourceCommitStatus', 'targets', 'managedFiles', 'transactionId', 'manifestHash') -Label $Label
  if (-not (Test-JsonInteger -Value $Manifest.schemaVersion) -or [int64]$Manifest.schemaVersion -ne $script:DeploymentManifestSchemaVersion) { throw "$Label schemaVersion is invalid." }
  $bridgeVersion = Assert-StrictText -Value $Manifest.bridgeVersion -Label "$Label bridgeVersion"
  $protocolVersion = Assert-StrictText -Value $Manifest.protocolVersion -Label "$Label protocolVersion"
  $sourceCommit = Assert-StrictText -Value $Manifest.sourceCommit -Label "$Label sourceCommit"
  $sourceCommitStatus = Assert-StrictText -Value $Manifest.sourceCommitStatus -Label "$Label sourceCommitStatus"
  $manifestHash = Assert-StrictText -Value $Manifest.manifestHash -Label "$Label manifestHash"
  if ($bridgeVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw "$Label bridgeVersion is invalid." }
  if ($protocolVersion -notmatch '^[1-9]\d*$') { throw "$Label protocolVersion is invalid." }
  if ($manifestHash -notmatch '^[0-9a-f]{64}$') { throw "$Label manifestHash is invalid." }
  if ($sourceCommitStatus -in @('exact-clean', 'dirty-worktree', 'git-status-unavailable')) {
    if ($sourceCommit -notmatch '^[0-9a-f]{40}$') { throw "$Label sourceCommit must be a 40-character lowercase commit for status $sourceCommitStatus." }
  } elseif ($sourceCommitStatus -eq 'unavailable') {
    if ($sourceCommit -ne 'unavailable') { throw "$Label unavailable sourceCommitStatus requires sourceCommit=unavailable." }
  } else {
    throw "$Label sourceCommitStatus is invalid."
  }
  if (Test-BridgeObjectProperty -Object $Manifest -Name 'transactionId') {
    $transactionId = Assert-StrictText -Value $Manifest.transactionId -Label "$Label transactionId"
    if ($transactionId -notmatch '^[0-9a-f]{32}$') { throw "$Label transactionId is invalid." }
  }
  Assert-BridgeObjectKeys -Object $Manifest.targets -Allowed @('skill', 'runtime') -Label "$Label targets"
  $manifestSkillTarget = Assert-StrictText -Value $Manifest.targets.skill -Label "$Label targets.skill"
  $manifestRuntimeTarget = Assert-StrictText -Value $Manifest.targets.runtime -Label "$Label targets.runtime"
  Assert-BridgeObjectKeys -Object $Manifest.managedFiles -Allowed @('skill', 'runtime') -Label "$Label managedFiles"
  $skillTarget = ConvertTo-BridgeAbsolutePath -Path $SkillTargetRoot -Label 'Skill target'
  $runtimeTarget = ConvertTo-BridgeAbsolutePath -Path $RuntimeTargetRoot -Label 'Runtime target'
  if ($manifestSkillTarget -ne $skillTarget -or $manifestRuntimeTarget -ne $runtimeTarget) {
    throw "$Label target path binding is invalid: $Label=$((Join-Path (Split-Path $SkillTargetRoot -Parent) 'deployment-manifest.json'))"
  }
  $recomputed = Get-RecomputedManifestHash -Manifest $Manifest
  if ([string]$Manifest.manifestHash -ne $recomputed) {
    throw "$Label manifestHash mismatch: expected $recomputed, actual $([string]$Manifest.manifestHash)"
  }
  foreach ($tree in @('skill', 'runtime')) {
    $rawFiles = $Manifest.managedFiles.$tree
    if ($rawFiles -isnot [System.Array]) { throw "$Label managedFiles.$tree must be a JSON array." }
    $files = @($rawFiles)
    if ($files.Count -eq 0) { throw "$Label managedFiles.$tree must be a non-empty JSON array." }
    foreach ($file in $files) {
      Assert-BridgeObjectKeys -Object $file -Allowed @('path', 'sha256') -Label "$Label managedFiles.$tree entry"
      $relative = Assert-ManagedRelativePath -Path $file.path -Label "$Label managedFiles.$tree path" -RequireRuntimePrefix:($tree -eq 'runtime')
      $hash = Assert-StrictText -Value $file.sha256 -Label "$Label managedFiles.$tree sha256"
      if ($hash -notmatch '^[0-9a-f]{64}$') { throw "$Label managedFiles.$tree hash is invalid." }
    }
    Assert-NoDuplicateManagedPaths -Files @($files) -Label "$Label managedFiles.$tree"
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
    $rawExpected = $Manifest.managedFiles.($pair.name)
    if ($rawExpected -isnot [System.Array]) { throw "$Label $($pair.name) managed file list must be a JSON array." }
    $expected = @($rawExpected)
    $expectedPaths = @($expected | ForEach-Object { [string]$_.path })
    $actual = @(Get-ManagedFileInventory -Root $pair.root -OnlyPaths $expectedPaths -RequireRuntimePrefix:($pair.name -eq 'runtime'))
    $actualPaths = @($actual | ForEach-Object { [string]$_.path })
    $expectedSorted = @(Sort-BridgeOrdinalStrings -Values $expectedPaths)
    $actualSorted = @(Sort-BridgeOrdinalStrings -Values $actualPaths)
    $samePaths = $expectedSorted.Count -eq $actualSorted.Count
    if ($samePaths) {
      for ($pathIndex = 0; $pathIndex -lt $expectedSorted.Count; $pathIndex++) {
        if ([StringComparer]::Ordinal.Compare($expectedSorted[$pathIndex], $actualSorted[$pathIndex]) -ne 0) { $samePaths = $false; break }
      }
    }
    if (-not $samePaths) {
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
