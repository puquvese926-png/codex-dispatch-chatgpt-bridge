[CmdletBinding()]
param(
    [string]$GlobalSkillsRoot = (Join-Path $env:USERPROFILE '.codex\skills'),
    [string]$GlobalRuntimeRoot = (Join-Path $env:USERPROFILE '.codex\bridge-runtime\dispatch-chatgpt-bridge')
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repositoryRoot 'skills\dispatch-chatgpt-bridge'
$targetRoot = Join-Path $GlobalSkillsRoot 'dispatch-chatgpt-bridge'
$sourceRuntimeRoot = Join-Path $repositoryRoot 'windows\scripts'
$targetRuntimeRoot = Join-Path $GlobalRuntimeRoot 'windows\scripts'

if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    throw "Source Skill directory was not found: $sourceRoot"
}
if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) {
    throw "Global Skill directory was not found: $targetRoot"
}
if (-not (Test-Path -LiteralPath $sourceRuntimeRoot -PathType Container)) {
    throw "Source bridge runtime directory was not found: $sourceRuntimeRoot"
}
if (-not (Test-Path -LiteralPath $targetRuntimeRoot -PathType Container)) {
    throw "Global bridge runtime directory was not found: $targetRuntimeRoot"
}

function Compare-Tree {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $sourceFiles = @(Get-ChildItem -LiteralPath $Source -File -Recurse)
    $targetFiles = @(Get-ChildItem -LiteralPath $Target -File -Recurse)
    $sourceRelative = @($sourceFiles | ForEach-Object { $_.FullName.Substring($Source.Length).TrimStart('\') })
    $targetRelative = @($targetFiles | ForEach-Object { $_.FullName.Substring($Target.Length).TrimStart('\') })

    $missing = @($sourceRelative | Where-Object { $_ -notin $targetRelative })
    $extra = @($targetRelative | Where-Object { $_ -notin $sourceRelative })
    $mismatch = @()

    foreach ($relativePath in $sourceRelative) {
        if ($relativePath -in $targetRelative) {
            $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Source $relativePath)).Hash
            $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Target $relativePath)).Hash
            if ($sourceHash -ne $targetHash) {
                $mismatch += $relativePath
            }
        }
    }

    if ($missing.Count -gt 0 -or $extra.Count -gt 0 -or $mismatch.Count -gt 0) {
        if ($missing.Count -gt 0) { Write-Output "$Label missing: $($missing -join ', ')" }
        if ($extra.Count -gt 0) { Write-Output "$Label extra: $($extra -join ', ')" }
        if ($mismatch.Count -gt 0) { Write-Output "$Label hash mismatch: $($mismatch -join ', ')" }
        throw "$Label verification failed."
    }

    return $sourceFiles.Count
}

$skillCount = Compare-Tree -Source $sourceRoot -Target $targetRoot -Label 'Global Skill'
$runtimeCount = Compare-Tree -Source $sourceRuntimeRoot -Target $targetRuntimeRoot -Label 'Global runtime'
Write-Output "PASS: $skillCount Skill files and $runtimeCount runtime files match."
