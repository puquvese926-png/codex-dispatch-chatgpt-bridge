[CmdletBinding()]
param(
    [string]$GlobalSkillsRoot = (Join-Path $env:USERPROFILE '.codex\skills'),
    [string]$GlobalRuntimeRoot = (Join-Path $env:USERPROFILE '.codex\bridge-runtime\dispatch-chatgpt-bridge')
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repositoryRoot 'skills\dispatch-chatgpt-bridge'
$targetRoot = Join-Path $GlobalSkillsRoot 'dispatch-chatgpt-bridge'
$sourceRuntimeScripts = Join-Path $repositoryRoot 'windows\scripts'
$targetRuntimeScripts = Join-Path $GlobalRuntimeRoot 'windows\scripts'

if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    throw "Source Skill directory was not found: $sourceRoot"
}
if (-not (Test-Path -LiteralPath $sourceRuntimeScripts -PathType Container)) {
    throw "Source bridge runtime directory was not found: $sourceRuntimeScripts"
}

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
New-Item -ItemType Directory -Force -Path $targetRuntimeScripts | Out-Null

Get-ChildItem -LiteralPath $sourceRoot -File -Recurse | ForEach-Object {
    $relativePath = $_.FullName.Substring($sourceRoot.Length).TrimStart('\')
    $destination = Join-Path $targetRoot $relativePath
    $destinationDirectory = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}

Get-ChildItem -LiteralPath $sourceRuntimeScripts -File -Recurse | ForEach-Object {
    $relativePath = $_.FullName.Substring($sourceRuntimeScripts.Length).TrimStart('\')
    $destination = Join-Path $targetRuntimeScripts $relativePath
    $destinationDirectory = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}

Write-Output "Installed dispatch-chatgpt-bridge globally at: $targetRoot"
Write-Output "Installed standalone bridge runtime at: $GlobalRuntimeRoot"
