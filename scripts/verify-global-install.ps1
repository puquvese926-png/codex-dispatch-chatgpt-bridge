[CmdletBinding()]
param(
    [string]$GlobalSkillsRoot = (Join-Path $env:USERPROFILE '.codex\skills')
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repositoryRoot 'skills\dispatch-chatgpt-bridge'
$targetRoot = Join-Path $GlobalSkillsRoot 'dispatch-chatgpt-bridge'

if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    throw "Source Skill directory was not found: $sourceRoot"
}
if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) {
    throw "Global Skill directory was not found: $targetRoot"
}

$sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse)
$targetFiles = @(Get-ChildItem -LiteralPath $targetRoot -File -Recurse)
$sourceRelative = @($sourceFiles | ForEach-Object { $_.FullName.Substring($sourceRoot.Length).TrimStart('\') })
$targetRelative = @($targetFiles | ForEach-Object { $_.FullName.Substring($targetRoot.Length).TrimStart('\') })

$missing = @($sourceRelative | Where-Object { $_ -notin $targetRelative })
$extra = @($targetRelative | Where-Object { $_ -notin $sourceRelative })
$mismatch = @()

foreach ($relativePath in $sourceRelative) {
    if ($relativePath -in $targetRelative) {
        $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $sourceRoot $relativePath)).Hash
        $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $targetRoot $relativePath)).Hash
        if ($sourceHash -ne $targetHash) {
            $mismatch += $relativePath
        }
    }
}

if ($missing.Count -gt 0 -or $extra.Count -gt 0 -or $mismatch.Count -gt 0) {
    if ($missing.Count -gt 0) { Write-Output "Missing: $($missing -join ', ')" }
    if ($extra.Count -gt 0) { Write-Output "Extra: $($extra -join ', ')" }
    if ($mismatch.Count -gt 0) { Write-Output "Hash mismatch: $($mismatch -join ', ')" }
    throw 'Global Skill verification failed.'
}

Write-Output "PASS: $($sourceFiles.Count) Skill files match at $targetRoot"
