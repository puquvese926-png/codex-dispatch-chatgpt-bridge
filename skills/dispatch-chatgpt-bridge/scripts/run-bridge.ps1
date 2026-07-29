[CmdletBinding()]
param(
  [ValidateSet('discover', 'probe', 'plan', 'batch', 'resume', 'watch', 'approve', 'cleanup', 'status', 'wait')]
  [string]$Action = 'probe',
  [string]$Root,
  [string]$StatePath,
  [string]$InputPath,
  [string]$OutputPath,
  [string]$LaunchRoot,
  [string]$LaunchPath,
  [ValidateRange(5000, 900000)]
  [int]$TimeoutMs = 600000,
  [ValidateRange(250, 30000)]
  [int]$PollMs = 5000,
  [switch]$AllowSend,
  [switch]$AllowDelete,
  [switch]$ExperimentalQuickChat,
  [switch]$Detach,
  [switch]$TestOnlyFailStart,
  [switch]$TestOnlyFailAttribution
)

$ErrorActionPreference = 'Stop'

# Machine-readable runner output must be byte-stable when PowerShell 5.1 is
# launched without a console or with stdout redirected. Do this before any
# discovery, manifest diagnostics, JSON conversion, or error is emitted.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$skillRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'deployment-manifest.ps1')

function Test-BridgeRoot {
  param([string]$Candidate)
  if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
  $bridge = Join-Path ([IO.Path]::GetFullPath($Candidate)) 'windows\scripts\chatgpt-bridge.mjs'
  return Test-Path -LiteralPath $bridge -PathType Leaf
}

function Resolve-BridgeRoot {
  param([string]$RequestedRoot)
  $installedRuntime = if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    $null
  } else {
    Join-Path $env:USERPROFILE '.codex\bridge-runtime\dispatch-chatgpt-bridge'
  }
  $repositoryRuntime = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
  foreach ($candidate in @($RequestedRoot, $env:CODEX_BRIDGE_ROOT, $installedRuntime, $repositoryRuntime)) {
    if (Test-BridgeRoot -Candidate $candidate) {
      return [IO.Path]::GetFullPath($candidate)
    }
  }
  throw 'Standalone bridge runtime was not found. Install it globally, set -Root, or set CODEX_BRIDGE_ROOT.'
}

function Assert-AbsoluteBridgePath {
  param([string]$Value, [string]$Label)
  $isDrivePath = $Value -match '^[A-Za-z]:[\\/]'
  $isUncPath = $Value -match '^\\\\[^\\]+\\[^\\]+'
  if ([string]::IsNullOrWhiteSpace($Value) -or (-not $isDrivePath -and -not $isUncPath)) {
    throw "$Label must be an absolute path."
  }
}

. (Join-Path $PSScriptRoot 'launch-control.ps1')

function Invoke-BridgeAction {
  $resolvedRoot = Resolve-BridgeRoot -RequestedRoot $Root
$bridgePath = Join-Path $resolvedRoot 'windows\scripts\chatgpt-bridge.mjs'
$manifestDiagnostic = [ordered]@{
  skillManifest = Join-Path $skillRoot 'deployment-manifest.json'
  runtimeManifest = Join-Path $resolvedRoot 'deployment-manifest.json'
  status = 'diagnostic-only'
}
if ($Action -notin @('discover', 'probe')) {
  try {
    Assert-DeploymentPair -SkillRoot $skillRoot -RuntimeRoot $resolvedRoot | Out-Null
  } catch {
    throw "Bridge consistency gate failed before Node/CDP. Skill manifest=$($manifestDiagnostic.skillManifest); Runtime manifest=$($manifestDiagnostic.runtimeManifest); status=invalid-or-missing; repair: .\scripts\install-global.ps1 then .\scripts\verify-global-install.ps1. Details=$($_.Exception.Message)"
  }
  $manifestDiagnostic.status = 'verified'
}
$node = (Get-Command node -ErrorAction Stop).Source
$arguments = @($bridgePath, $Action)

if ($StatePath) {
  $stateFullPath = Get-NormalizedBridgePath -Value $StatePath -Label 'StatePath'
  $arguments += @('--state', $stateFullPath)
}

if ($Action -in @('plan', 'batch', 'resume', 'watch', 'approve', 'cleanup')) {
  $inputFullPath = Get-NormalizedBridgePath -Value $InputPath -Label 'InputPath'
  $outputFullPath = Get-NormalizedBridgePath -Value $OutputPath -Label 'OutputPath'
  $arguments += @('--input', $inputFullPath)
  $arguments += @('--output', $outputFullPath)
  $arguments += @('--timeout-ms', "$TimeoutMs")
  if ($Action -eq 'watch') {
    $arguments += @('--poll-ms', "$PollMs")
  }
} elseif ($InputPath -or $OutputPath -or $AllowSend -or $AllowDelete -or
    $ExperimentalQuickChat -or $Detach -or $LaunchRoot -or $LaunchPath -or
    $TestOnlyFailStart -or $TestOnlyFailAttribution) {
  throw "$Action does not accept mutation paths or authorization switches."
}

if ($Action -ne 'cleanup' -and $AllowDelete) {
  throw "$Action does not accept -AllowDelete."
}

if ($ExperimentalQuickChat) {
  if ($Action -notin @('plan', 'batch')) {
    throw "$Action does not accept -ExperimentalQuickChat."
  }
  $arguments += '--experimental-quick-chat'
}

if ($Detach -and $Action -notin @('batch', 'resume', 'watch')) {
  throw "$Action does not support -Detach."
}
if ($LaunchRoot -and -not $Detach) {
  throw "$Action does not accept -LaunchRoot without -Detach."
}
if ($LaunchPath) {
  throw "$Action does not accept -LaunchPath."
}
if ($TestOnlyFailStart -and -not $Detach) {
  throw "$Action does not accept the test-only start failure switch without -Detach."
}
if ($TestOnlyFailStart -and $env:CODEX_BRIDGE_P06_TEST_MODE -ne '1') {
  throw 'The test-only start failure switch requires CODEX_BRIDGE_P06_TEST_MODE=1.'
}
if ($TestOnlyFailAttribution -and -not $Detach) {
  throw "$Action does not accept the test-only attribution failure switch without -Detach."
}
if ($TestOnlyFailAttribution -and $env:CODEX_BRIDGE_P06_TEST_MODE -ne '1') {
  throw 'The test-only attribution failure switch requires CODEX_BRIDGE_P06_TEST_MODE=1.'
}

if ($Action -in @('batch', 'approve')) {
  if (-not $AllowSend) { throw "$Action requires explicit -AllowSend authorization." }
  $arguments += '--allow-send'
} elseif ($Action -eq 'resume' -and $AllowSend) {
  throw 'Resume is read-only and does not accept -AllowSend.'
} elseif ($Action -eq 'watch' -and $AllowSend) {
  throw 'Watch is read-only and does not accept -AllowSend.'
} elseif ($Action -eq 'plan' -and $AllowSend) {
  throw 'Plan is read-only and does not accept -AllowSend.'
} elseif ($Action -eq 'cleanup') {
  if (-not $AllowDelete) { throw 'Cleanup requires explicit -AllowDelete authorization.' }
  if ($AllowSend) { throw 'Cleanup does not accept -AllowSend.' }
  $arguments += '--allow-delete'
}

if ($Detach) {
  $launchParameters = @{
    NodePath = $node
    Arguments = $arguments
    Command = $Action
    InputPath = $inputFullPath
    ReportPath = $outputFullPath
    StatePath = $stateFullPath
    RequestedLaunchRoot = $LaunchRoot
    Timeout = $TimeoutMs
    Poll = $PollMs
    AllowSend = [bool]$AllowSend
    AllowDelete = [bool]$AllowDelete
    SimulateStartFailure = [bool]$TestOnlyFailStart
    SimulateAttributionFailure = [bool]$TestOnlyFailAttribution
  }
  $launch = Start-DetachedLaunch @launchParameters
  $launch | ConvertTo-Json -Compress -Depth 12
  if (-not $launch.pass) { exit 1 }
  exit 0
}

  & $node @arguments
  exit $LASTEXITCODE
}


if ($Action -notin @('status', 'wait')) {
  Invoke-BridgeAction
  exit $LASTEXITCODE
}

if ($Action -in @('status', 'wait')) {
  if ($Root -or $StatePath -or $InputPath -or $OutputPath -or $LaunchRoot -or
      $AllowSend -or $AllowDelete -or $ExperimentalQuickChat -or $Detach -or
      $TestOnlyFailStart -or $TestOnlyFailAttribution) {
    throw "$Action is runner-only and accepts only -LaunchPath plus bounded wait options."
  }
  Assert-AbsoluteBridgePath -Value $LaunchPath -Label 'LaunchPath'
  $normalizedLaunchPath = [IO.Path]::GetFullPath($LaunchPath)
  $result = if ($Action -eq 'status') {
    Get-LaunchStatus -Path $normalizedLaunchPath
  } else {
    Wait-LaunchStatus -Path $normalizedLaunchPath -Timeout $TimeoutMs -Poll $PollMs
  }
  $result | ConvertTo-Json -Compress -Depth 20
  exit 0
}
