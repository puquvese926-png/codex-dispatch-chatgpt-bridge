[CmdletBinding()]
param(
  [ValidateSet('discover', 'probe', 'batch', 'resume', 'watch', 'approve', 'cleanup')]
  [string]$Action = 'probe',
  [string]$Root,
  [string]$InputPath,
  [string]$OutputPath,
  [ValidateRange(5000, 900000)]
  [int]$TimeoutMs = 180000,
  [ValidateRange(250, 30000)]
  [int]$PollMs = 5000,
  [switch]$AllowSend,
  [switch]$AllowDelete
)

$ErrorActionPreference = 'Stop'

function Test-BridgeRoot {
  param([string]$Candidate)
  if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
  $bridge = Join-Path ([IO.Path]::GetFullPath($Candidate)) 'windows\scripts\chatgpt-bridge.mjs'
  return Test-Path -LiteralPath $bridge -PathType Leaf
}

function Resolve-BridgeRoot {
  param([string]$RequestedRoot)
  foreach ($candidate in @($RequestedRoot, $env:CODEX_BRIDGE_ROOT)) {
    if (Test-BridgeRoot -Candidate $candidate) {
      return [IO.Path]::GetFullPath($candidate)
    }
  }
  $candidatePath = [IO.Path]::GetFullPath((Get-Location).Path)
  while ($true) {
    if (Test-BridgeRoot -Candidate $candidatePath) { return $candidatePath }
    $parent = [IO.Directory]::GetParent($candidatePath)
    if ($null -eq $parent) { break }
    $candidatePath = $parent.FullName
  }
  throw 'Bridge runtime root was not found. Set -Root or CODEX_BRIDGE_ROOT.'
}

function Assert-AbsoluteBridgePath {
  param([string]$Value, [string]$Label)
  $isDrivePath = $Value -match '^[A-Za-z]:[\\/]'
  $isUncPath = $Value -match '^\\\\[^\\]+\\[^\\]+'
  if ([string]::IsNullOrWhiteSpace($Value) -or (-not $isDrivePath -and -not $isUncPath)) {
    throw "$Label must be an absolute path."
  }
}

$resolvedRoot = Resolve-BridgeRoot -RequestedRoot $Root
$bridgePath = Join-Path $resolvedRoot 'windows\scripts\chatgpt-bridge.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
$arguments = @($bridgePath, $Action)

if ($Action -in @('batch', 'resume', 'watch', 'approve', 'cleanup')) {
  Assert-AbsoluteBridgePath -Value $InputPath -Label 'InputPath'
  Assert-AbsoluteBridgePath -Value $OutputPath -Label 'OutputPath'
  $arguments += @('--input', [IO.Path]::GetFullPath($InputPath))
  $arguments += @('--output', [IO.Path]::GetFullPath($OutputPath))
  $arguments += @('--timeout-ms', "$TimeoutMs")
  if ($Action -eq 'watch') {
    $arguments += @('--poll-ms', "$PollMs")
  }
} elseif ($InputPath -or $OutputPath -or $AllowSend -or $AllowDelete) {
  throw "$Action does not accept mutation paths or authorization switches."
}

if ($Action -ne 'cleanup' -and $AllowDelete) {
  throw "$Action does not accept -AllowDelete."
}

if ($Action -in @('batch', 'approve')) {
  if (-not $AllowSend) { throw "$Action requires explicit -AllowSend authorization." }
  $arguments += '--allow-send'
} elseif ($Action -eq 'resume' -and $AllowSend) {
  throw 'Resume is read-only and does not accept -AllowSend.'
} elseif ($Action -eq 'watch' -and $AllowSend) {
  throw 'Watch is read-only and does not accept -AllowSend.'
} elseif ($Action -eq 'cleanup') {
  if (-not $AllowDelete) { throw 'Cleanup requires explicit -AllowDelete authorization.' }
  if ($AllowSend) { throw 'Cleanup does not accept -AllowSend.' }
  $arguments += '--allow-delete'
}

& $node @arguments
exit $LASTEXITCODE
