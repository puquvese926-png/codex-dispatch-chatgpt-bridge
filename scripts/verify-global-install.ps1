[CmdletBinding()]
param(
    [string]$GlobalSkillsRoot = (Join-Path $env:USERPROFILE '.codex\skills'),
    [string]$GlobalRuntimeRoot = (Join-Path $env:USERPROFILE '.codex\bridge-runtime\dispatch-chatgpt-bridge')
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$repositoryRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repositoryRoot 'skills\dispatch-chatgpt-bridge\scripts\deployment-manifest.ps1')

$sourceSkillRoot = Join-Path $repositoryRoot 'skills\dispatch-chatgpt-bridge'
$sourceRuntimeRoot = Join-Path $repositoryRoot 'windows\scripts'
$targetSkillRoot = ConvertTo-BridgeAbsolutePath -Path (Join-Path $GlobalSkillsRoot 'dispatch-chatgpt-bridge') -Label 'Skill target'
$targetRuntimeRoot = ConvertTo-BridgeAbsolutePath -Path $GlobalRuntimeRoot -Label 'Runtime target'

try {
    $manifest = Assert-DeploymentPair `
        -SkillRoot $targetSkillRoot `
        -RuntimeRoot $targetRuntimeRoot `
        -RepositoryRoot $repositoryRoot `
        -RequireSourceMatch
    [ordered]@{
        pass = $true
        bridgeVersion = [string]$manifest.bridgeVersion
        protocolVersion = [string]$manifest.protocolVersion
        sourceCommit = [string]$manifest.sourceCommit
        sourceCommitStatus = [string]$manifest.sourceCommitStatus
        manifestHash = [string]$manifest.manifestHash
        skillTarget = $targetSkillRoot
        runtimeTarget = $targetRuntimeRoot
        extraFiles = 'ignored-and-never-modified'
    } | ConvertTo-Json -Compress
} catch {
    throw "Global bridge verification failed. Skill=$targetSkillRoot Runtime=$targetRuntimeRoot. Repair with: .\scripts\install-global.ps1; then: .\scripts\verify-global-install.ps1. Details=$($_.Exception.Message)"
}
