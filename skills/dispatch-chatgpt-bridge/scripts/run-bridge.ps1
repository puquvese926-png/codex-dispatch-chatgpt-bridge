[CmdletBinding()]
param(
  [ValidateSet('discover', 'probe', 'plan', 'batch', 'resume', 'watch', 'approve', 'cleanup')]
  [string]$Action = 'probe',
  [string]$Root,
  [string]$StatePath,
  [string]$InputPath,
  [string]$OutputPath,
  [ValidateRange(5000, 900000)]
  [int]$TimeoutMs = 600000,
  [ValidateRange(250, 30000)]
  [int]$PollMs = 5000,
  [switch]$AllowSend,
  [switch]$AllowDelete,
  [switch]$ExperimentalQuickChat,
  [switch]$Detach
)

$ErrorActionPreference = 'Stop'

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
  Assert-AbsoluteBridgePath -Value $StatePath -Label 'StatePath'
  $arguments += @('--state', [IO.Path]::GetFullPath($StatePath))
}

if ($Action -in @('plan', 'batch', 'resume', 'watch', 'approve', 'cleanup')) {
  Assert-AbsoluteBridgePath -Value $InputPath -Label 'InputPath'
  Assert-AbsoluteBridgePath -Value $OutputPath -Label 'OutputPath'
  $arguments += @('--input', [IO.Path]::GetFullPath($InputPath))
  $arguments += @('--output', [IO.Path]::GetFullPath($OutputPath))
  $arguments += @('--timeout-ms', "$TimeoutMs")
  if ($Action -eq 'watch') {
    $arguments += @('--poll-ms', "$PollMs")
  }
} elseif ($InputPath -or $OutputPath -or $AllowSend -or $AllowDelete -or
    $ExperimentalQuickChat -or $Detach) {
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
  $stdoutPath = "$OutputPath.stdout.log"
  $stderrPath = "$OutputPath.stderr.log"
  $quotedArguments = $arguments | ForEach-Object {
    '"' + ([string]$_).Replace('"', '\\"') + '"'
  }
  $child = Start-Process -FilePath $node `
    -ArgumentList $quotedArguments `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  [ordered]@{
    pass = $true
    command = $Action
    state = 'running'
    pid = $child.Id
    reportPath = [IO.Path]::GetFullPath($OutputPath)
    progressPath = "$([IO.Path]::GetFullPath($OutputPath)).progress.json"
    stdoutPath = [IO.Path]::GetFullPath($stdoutPath)
    stderrPath = [IO.Path]::GetFullPath($stderrPath)
  } | ConvertTo-Json -Compress
  exit 0
}

& $node @arguments
exit $LASTEXITCODE
