[CmdletBinding()]
param(
    [string]$GlobalSkillsRoot = (Join-Path $env:USERPROFILE '.codex\skills'),
    [string]$GlobalRuntimeRoot = (Join-Path $env:USERPROFILE '.codex\bridge-runtime\dispatch-chatgpt-bridge'),
    [switch]$TestOnly,
    [ValidateSet('', 'CorruptStagedManifest', 'BeforeRuntimeSwitch', 'AfterRuntimeSwitch', 'BeforeCommit', 'AfterCommitBeforeCleanup')]
    [string]$TestFailureAt = ''
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$repositoryRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repositoryRoot 'skills\dispatch-chatgpt-bridge\scripts\deployment-manifest.ps1')

if ($TestOnly -and $env:CODEX_BRIDGE_INSTALL_TEST_MODE -ne '1') {
    throw 'Test-only installation switches require CODEX_BRIDGE_INSTALL_TEST_MODE=1.'
}
if (-not $TestOnly -and -not [string]::IsNullOrWhiteSpace($TestFailureAt)) {
    throw 'TestFailureAt requires -TestOnly.'
}

$sourceSkillRoot = Join-Path $repositoryRoot 'skills\dispatch-chatgpt-bridge'
$sourceRuntimeRoot = Join-Path $repositoryRoot 'windows\scripts'
$targetSkillRoot = ConvertTo-BridgeAbsolutePath -Path (Join-Path $GlobalSkillsRoot 'dispatch-chatgpt-bridge') -Label 'Skill target'
$targetRuntimeRoot = ConvertTo-BridgeAbsolutePath -Path $GlobalRuntimeRoot -Label 'Runtime target'
$skillsParent = Split-Path -Parent $targetSkillRoot
$runtimeParent = Split-Path -Parent $targetRuntimeRoot
$journalSearchRoot = ConvertTo-BridgeAbsolutePath -Path $GlobalSkillsRoot -Label 'Skill root'

function Assert-InstallTargets {
    $skill = $targetSkillRoot
    $runtime = $targetRuntimeRoot
    if ($skill -eq $runtime -or $skill.StartsWith($runtime + '\') -or $runtime.StartsWith($skill + '\')) {
        throw "Skill and Runtime targets overlap: $skill / $runtime"
    }
    if ($journalSearchRoot -eq $targetSkillRoot -or $journalSearchRoot -eq $targetRuntimeRoot) {
        throw 'GlobalSkillsRoot cannot be a deployment target root.'
    }
    foreach ($path in @($journalSearchRoot, $targetSkillRoot, $targetRuntimeRoot)) {
        Assert-NoReparseAncestor -Path $path
    }
}

function Assert-NoReparseAncestor {
    param([Parameter(Mandatory = $true)][string]$Path)
    $cursor = ConvertTo-BridgeAbsolutePath -Path $Path -Label 'installation path'
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Installation path contains a reparse point; refusing to follow it: $cursor"
            }
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Assert-OwnedSiblingPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Prefix,
        [Parameter(Mandatory = $true)][string]$TransactionId
    )
    $full = ConvertTo-BridgeAbsolutePath -Path $Path -Label 'transaction path'
    $expectedParent = ConvertTo-BridgeAbsolutePath -Path $Parent -Label 'transaction parent'
    $name = Split-Path -Leaf $full
    if ((Split-Path -Parent $full) -ne $expectedParent -or $name -ne "$Prefix$TransactionId") {
        throw "Unsafe transaction path rejected: $Path"
    }
    return $full
}

function Assert-OwnedJournalPath {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$TransactionId)
    $full = ConvertTo-BridgeAbsolutePath -Path $Path -Label 'journal path'
    if ((Split-Path -Parent $full) -ne $journalSearchRoot -or
        (Split-Path -Leaf $full) -ne ".dispatch-chatgpt-bridge-install-$TransactionId.journal.json") {
        throw "Unsafe transaction journal path rejected: $Path"
    }
    return $full
}

function Remove-OwnedSiblingPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Prefix,
        [Parameter(Mandatory = $true)][string]$TransactionId
    )
    $safe = Assert-OwnedSiblingPath -Path $Path -Parent $Parent -Prefix $Prefix -TransactionId $TransactionId
    if (Test-Path -LiteralPath $safe) { Remove-Item -LiteralPath $safe -Recurse -Force }
}

function Write-InstallJournal {
    param([Parameter(Mandatory = $true)][object]$Journal)
    $journalPath = [string]$Journal.journalPath
    $transactionId = [string]$Journal.transactionId
    Assert-OwnedJournalPath -Path $journalPath -TransactionId $transactionId | Out-Null
    $temporary = Join-Path $journalSearchRoot ".dispatch-chatgpt-bridge-install-$transactionId.tmp"
    Assert-OwnedSiblingPath -Path $temporary -Parent $journalSearchRoot -Prefix '.dispatch-chatgpt-bridge-install-' -TransactionId "$transactionId.tmp" | Out-Null
    [IO.File]::WriteAllText($temporary, ($Journal | ConvertTo-Json -Compress -Depth 20) + "`r`n", [Text.Encoding]::UTF8)
    try {
        Move-Item -LiteralPath $temporary -Destination $journalPath -Force
    } catch {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        throw
    }
}

function Copy-ManagedTree {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($file in @(Get-ChildItem -LiteralPath $Source -File -Recurse)) {
        if ($file.Name -eq 'deployment-manifest.json') { continue }
        $relative = Get-RelativeManagedPath -Root $Source -File $file.FullName
        $targetFile = Join-Path $Destination ($relative -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetFile) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $targetFile -Force
    }
}

function Copy-UnmanagedTargetFiles {
    param(
        [Parameter(Mandatory = $true)][string]$ExistingRoot,
        [Parameter(Mandatory = $true)][string]$StageRoot,
        [Parameter(Mandatory = $true)][object[]]$ManagedFiles
    )
    if (-not (Test-Path -LiteralPath $ExistingRoot -PathType Container)) { return }
    $managed = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $ManagedFiles) { [void]$managed.Add([string]$file.path) }
    foreach ($entry in @(Get-ChildItem -LiteralPath $ExistingRoot -Force -Recurse)) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Unmanaged reparse point inside deployment root; refusing install: $($entry.FullName)"
        }
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $ExistingRoot -File -Recurse)) {
        if ($file.Name -eq 'deployment-manifest.json') { continue }
        $relative = Get-RelativeManagedPath -Root $ExistingRoot -File $file.FullName
        if ($managed.Contains($relative)) { continue }
        $targetFile = Join-Path $StageRoot ($relative -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetFile) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $targetFile -Force
    }
}

function Invoke-TestFailure {
    param([Parameter(Mandatory = $true)][string]$At)
    if ($TestOnly -and $TestFailureAt -eq $At) { throw "Injected installation failure at $At." }
}

function Get-TransactionPaths {
    param([Parameter(Mandatory = $true)][string]$TransactionId)
    return [ordered]@{
        transactionId = $TransactionId
        journalPath = Join-Path $journalSearchRoot ".dispatch-chatgpt-bridge-install-$TransactionId.journal.json"
        skillStage = Join-Path $skillsParent ".dispatch-chatgpt-bridge-stage-skill-$TransactionId"
        runtimeStage = Join-Path $runtimeParent ".dispatch-chatgpt-bridge-stage-runtime-$TransactionId"
        skillBackup = Join-Path $skillsParent ".dispatch-chatgpt-bridge-backup-skill-$TransactionId"
        runtimeBackup = Join-Path $runtimeParent ".dispatch-chatgpt-bridge-backup-runtime-$TransactionId"
        skillQuarantine = Join-Path $skillsParent ".dispatch-chatgpt-bridge-quarantine-skill-$TransactionId"
        runtimeQuarantine = Join-Path $runtimeParent ".dispatch-chatgpt-bridge-quarantine-runtime-$TransactionId"
    }
}

function Assert-JournalPaths {
    param([Parameter(Mandatory = $true)][object]$Journal)
    Assert-InstallJournalShape -Journal $Journal
    $id = [string]$Journal.transactionId
    Assert-OwnedJournalPath -Path $Journal.journalPath -TransactionId $id | Out-Null
    Assert-OwnedSiblingPath -Path $Journal.skillStage -Parent $skillsParent -Prefix '.dispatch-chatgpt-bridge-stage-skill-' -TransactionId $id | Out-Null
    Assert-OwnedSiblingPath -Path $Journal.runtimeStage -Parent $runtimeParent -Prefix '.dispatch-chatgpt-bridge-stage-runtime-' -TransactionId $id | Out-Null
    Assert-OwnedSiblingPath -Path $Journal.skillBackup -Parent $skillsParent -Prefix '.dispatch-chatgpt-bridge-backup-skill-' -TransactionId $id | Out-Null
    Assert-OwnedSiblingPath -Path $Journal.runtimeBackup -Parent $runtimeParent -Prefix '.dispatch-chatgpt-bridge-backup-runtime-' -TransactionId $id | Out-Null
    Assert-OwnedSiblingPath -Path $Journal.skillQuarantine -Parent $skillsParent -Prefix '.dispatch-chatgpt-bridge-quarantine-skill-' -TransactionId $id | Out-Null
    Assert-OwnedSiblingPath -Path $Journal.runtimeQuarantine -Parent $runtimeParent -Prefix '.dispatch-chatgpt-bridge-quarantine-runtime-' -TransactionId $id | Out-Null
    if ((ConvertTo-BridgeAbsolutePath -Path $Journal.skillTarget -Label 'journal Skill target') -ne $targetSkillRoot -or
        (ConvertTo-BridgeAbsolutePath -Path $Journal.runtimeTarget -Label 'journal Runtime target') -ne $targetRuntimeRoot) {
        throw 'Install journal targets do not match this invocation; refusing recovery.'
    }
}

function Assert-InstallJournalShape {
    param([Parameter(Mandatory = $true)][object]$Journal)
    Assert-BridgeObjectKeys -Object $Journal -Allowed @(
        'schemaVersion', 'transactionId', 'state', 'journalPath', 'skillTarget', 'runtimeTarget',
        'skillStage', 'runtimeStage', 'skillBackup', 'runtimeBackup', 'skillQuarantine',
        'runtimeQuarantine', 'manifestHash', 'skillOriginallyPresent', 'runtimeOriginallyPresent'
    ) -Label 'Install journal'
    if (-not (Test-JsonInteger -Value $Journal.schemaVersion) -or [int64]$Journal.schemaVersion -ne 1) {
        throw 'Install journal schemaVersion is invalid; refusing recovery.'
    }
    $id = Assert-StrictText -Value $Journal.transactionId -Label 'Install journal transactionId'
    if ($id -notmatch '^[0-9a-f]{32}$') { throw 'Install journal transaction ID is invalid; refusing recovery.' }
    $state = Assert-StrictText -Value $Journal.state -Label 'Install journal state'
    if ($state -notin @('prepared', 'backed-up-skill', 'skill-switched', 'backed-up-runtime', 'runtime-switched', 'rollback-required', 'committed')) {
        throw "Install journal state is unknown: $state"
    }
    foreach ($field in @('journalPath', 'skillTarget', 'runtimeTarget', 'skillStage', 'runtimeStage', 'skillBackup', 'runtimeBackup', 'skillQuarantine', 'runtimeQuarantine')) {
        Assert-StrictText -Value $Journal.$field -Label "Install journal $field" | Out-Null
    }
    $manifestHash = Assert-StrictText -Value $Journal.manifestHash -Label 'Install journal manifestHash'
    if ($manifestHash -notmatch '^[0-9a-f]{64}$') { throw 'Install journal manifestHash is invalid; refusing recovery.' }
    foreach ($field in @('skillOriginallyPresent', 'runtimeOriginallyPresent')) {
        if ($Journal.$field -isnot [bool]) { throw "Install journal $field must be a JSON boolean; refusing recovery." }
    }
}

function Test-OwnInstalledTarget {
    param([Parameter(Mandatory = $true)][string]$Target, [Parameter(Mandatory = $true)][string]$ExpectedHash)
    if (-not (Test-Path -LiteralPath $Target -PathType Container)) { return $false }
    try {
        $manifest = Read-BridgeDeploymentManifest -Root $Target -Label 'transaction target manifest'
        Assert-ManifestShape -Manifest $manifest -SkillTargetRoot $targetSkillRoot -RuntimeTargetRoot $targetRuntimeRoot -Label 'transaction target manifest' | Out-Null
        return [string]$manifest.manifestHash -eq $ExpectedHash
    } catch { return $false }
}

function Restore-InstallTransaction {
    param([Parameter(Mandatory = $true)][object]$Journal)
    Assert-JournalPaths -Journal $Journal
    $id = [string]$Journal.transactionId
    foreach ($pair in @(
        @{ target = [string]$Journal.skillTarget; backup = [string]$Journal.skillBackup; quarantine = [string]$Journal.skillQuarantine; parent = $skillsParent; backupPrefix = ".dispatch-chatgpt-bridge-backup-skill-"; quarantinePrefix = ".dispatch-chatgpt-bridge-quarantine-skill-" },
        @{ target = [string]$Journal.runtimeTarget; backup = [string]$Journal.runtimeBackup; quarantine = [string]$Journal.runtimeQuarantine; parent = $runtimeParent; backupPrefix = ".dispatch-chatgpt-bridge-backup-runtime-"; quarantinePrefix = ".dispatch-chatgpt-bridge-quarantine-runtime-" }
    )) {
        $targetOwned = Test-OwnInstalledTarget -Target $pair.target -ExpectedHash ([string]$Journal.manifestHash)
        if ((Test-Path -LiteralPath $pair.target) -and -not $targetOwned -and (Test-Path -LiteralPath $pair.backup)) {
            throw "Rollback refused to remove an unverified target: $($pair.target)"
        }
        if ($targetOwned) {
            Assert-OwnedSiblingPath -Path $pair.quarantine -Parent $pair.parent -Prefix $pair.quarantinePrefix -TransactionId $id | Out-Null
            if (Test-Path -LiteralPath $pair.quarantine) { Remove-OwnedSiblingPath -Path $pair.quarantine -Parent $pair.parent -Prefix $pair.quarantinePrefix -TransactionId $id }
            Move-Item -LiteralPath $pair.target -Destination $pair.quarantine
            Remove-OwnedSiblingPath -Path $pair.quarantine -Parent $pair.parent -Prefix $pair.quarantinePrefix -TransactionId $id
        }
        if (Test-Path -LiteralPath $pair.backup) {
            if (Test-Path -LiteralPath $pair.target) { throw "Rollback target is still occupied: $($pair.target)" }
            Move-Item -LiteralPath $pair.backup -Destination $pair.target
        }
    }
    Remove-OwnedSiblingPath -Path $Journal.skillStage -Parent $skillsParent -Prefix '.dispatch-chatgpt-bridge-stage-skill-' -TransactionId $id
    Remove-OwnedSiblingPath -Path $Journal.runtimeStage -Parent $runtimeParent -Prefix '.dispatch-chatgpt-bridge-stage-runtime-' -TransactionId $id
    Remove-OwnedSiblingPath -Path $Journal.skillBackup -Parent $skillsParent -Prefix '.dispatch-chatgpt-bridge-backup-skill-' -TransactionId $id
    Remove-OwnedSiblingPath -Path $Journal.runtimeBackup -Parent $runtimeParent -Prefix '.dispatch-chatgpt-bridge-backup-runtime-' -TransactionId $id
    Remove-OwnedSiblingPath -Path $Journal.skillQuarantine -Parent $skillsParent -Prefix '.dispatch-chatgpt-bridge-quarantine-skill-' -TransactionId $id
    Remove-OwnedSiblingPath -Path $Journal.runtimeQuarantine -Parent $runtimeParent -Prefix '.dispatch-chatgpt-bridge-quarantine-runtime-' -TransactionId $id
}

function Recover-InstallJournals {
    if (-not (Test-Path -LiteralPath $journalSearchRoot -PathType Container)) { return }
    foreach ($journalFile in @(Get-ChildItem -LiteralPath $journalSearchRoot -File -Filter '.dispatch-chatgpt-bridge-install-*.journal.json')) {
        if ($journalFile.Name -notmatch '^\.dispatch-chatgpt-bridge-install-([0-9a-f]{32})\.journal\.json$') {
            throw "Unrecognized install journal residue; refusing to delete: $($journalFile.FullName)"
        }
        try { $journal = Get-Content -LiteralPath $journalFile.FullName -Raw | ConvertFrom-Json }
        catch { throw "Install journal is corrupt; refusing recovery: $($journalFile.FullName)" }
        Assert-JournalPaths -Journal $journal
        $state = [string]$journal.state
        $journalRemoved = $false
        switch ($state) {
            'prepared' {
                foreach ($residue in @(
                    @{ path = $journal.skillBackup; parent = $skillsParent; prefix = '.dispatch-chatgpt-bridge-backup-skill-' },
                    @{ path = $journal.runtimeBackup; parent = $runtimeParent; prefix = '.dispatch-chatgpt-bridge-backup-runtime-' },
                    @{ path = $journal.skillQuarantine; parent = $skillsParent; prefix = '.dispatch-chatgpt-bridge-quarantine-skill-' },
                    @{ path = $journal.runtimeQuarantine; parent = $runtimeParent; prefix = '.dispatch-chatgpt-bridge-quarantine-runtime-' }
                )) {
                    if (Test-Path -LiteralPath $residue.path) { throw "Prepared install journal has unexpected switched residue; refusing recovery: $($residue.path)" }
                }
                Remove-OwnedSiblingPath -Path $journal.skillStage -Parent $skillsParent -Prefix '.dispatch-chatgpt-bridge-stage-skill-' -TransactionId $journal.transactionId
                Remove-OwnedSiblingPath -Path $journal.runtimeStage -Parent $runtimeParent -Prefix '.dispatch-chatgpt-bridge-stage-runtime-' -TransactionId $journal.transactionId
            }
            'runtime-switched' {
                $skillOwned = Test-OwnInstalledTarget -Target $targetSkillRoot -ExpectedHash ([string]$journal.manifestHash)
                $runtimeOwned = Test-OwnInstalledTarget -Target $targetRuntimeRoot -ExpectedHash ([string]$journal.manifestHash)
                if ($skillOwned -and $runtimeOwned) {
                    Remove-CommittedTransactionResidue -Journal $journal
                    $journalRemoved = $true
                } else {
                    Restore-InstallTransaction -Journal $journal
                }
            }
            'committed' {
                $skillOwned = Test-OwnInstalledTarget -Target $targetSkillRoot -ExpectedHash ([string]$journal.manifestHash)
                $runtimeOwned = Test-OwnInstalledTarget -Target $targetRuntimeRoot -ExpectedHash ([string]$journal.manifestHash)
                if (-not ($skillOwned -and $runtimeOwned)) {
                    throw 'Committed install journal does not own both target trees; refusing recovery.'
                }
                Remove-CommittedTransactionResidue -Journal $journal
                $journalRemoved = $true
            }
            default { Restore-InstallTransaction -Journal $journal }
        }
        if (-not $journalRemoved) {
            Assert-OwnedJournalPath -Path $journal.journalPath -TransactionId $journal.transactionId | Out-Null
            Remove-Item -LiteralPath $journal.journalPath -Force
        }
    }
}

function New-InstallJournal {
    param([Parameter(Mandatory = $true)][object]$Paths, [Parameter(Mandatory = $true)][object]$Manifest)
    return [ordered]@{
        schemaVersion = 1
        transactionId = [string]$Paths.transactionId
        state = 'prepared'
        journalPath = [string]$Paths.journalPath
        skillTarget = $targetSkillRoot
        runtimeTarget = $targetRuntimeRoot
        skillStage = [string]$Paths.skillStage
        runtimeStage = [string]$Paths.runtimeStage
        skillBackup = [string]$Paths.skillBackup
        runtimeBackup = [string]$Paths.runtimeBackup
        skillQuarantine = [string]$Paths.skillQuarantine
        runtimeQuarantine = [string]$Paths.runtimeQuarantine
        manifestHash = [string]$Manifest.manifestHash
        skillOriginallyPresent = (Test-Path -LiteralPath $targetSkillRoot)
        runtimeOriginallyPresent = (Test-Path -LiteralPath $targetRuntimeRoot)
    }
}

function Remove-CommittedTransactionResidue {
    param([Parameter(Mandatory = $true)][object]$Journal)
    Assert-JournalPaths -Journal $Journal
    $id = [string]$Journal.transactionId
    Remove-OwnedSiblingPath -Path $Journal.skillBackup -Parent $skillsParent -Prefix '.dispatch-chatgpt-bridge-backup-skill-' -TransactionId $id
    Remove-OwnedSiblingPath -Path $Journal.runtimeBackup -Parent $runtimeParent -Prefix '.dispatch-chatgpt-bridge-backup-runtime-' -TransactionId $id
    Remove-OwnedSiblingPath -Path $Journal.skillStage -Parent $skillsParent -Prefix '.dispatch-chatgpt-bridge-stage-skill-' -TransactionId $id
    Remove-OwnedSiblingPath -Path $Journal.runtimeStage -Parent $runtimeParent -Prefix '.dispatch-chatgpt-bridge-stage-runtime-' -TransactionId $id
    Assert-OwnedJournalPath -Path $Journal.journalPath -TransactionId $id | Out-Null
    Remove-Item -LiteralPath $Journal.journalPath -Force
}

Assert-InstallTargets
New-Item -ItemType Directory -Force -Path $skillsParent | Out-Null
New-Item -ItemType Directory -Force -Path $runtimeParent | Out-Null
New-Item -ItemType Directory -Force -Path $journalSearchRoot | Out-Null
Recover-InstallJournals

$transactionId = ([Guid]::NewGuid().ToString('N')).ToLowerInvariant()
$paths = Get-TransactionPaths -TransactionId $transactionId
$manifest = $null
$journal = $null
$rollbackError = $null

try {
    $manifest = New-BridgeDeploymentManifest `
        -RepositoryRoot $repositoryRoot `
        -SkillSourceRoot $sourceSkillRoot `
        -RuntimeSourceRoot $sourceRuntimeRoot `
        -SkillTargetRoot $targetSkillRoot `
        -RuntimeTargetRoot $targetRuntimeRoot `
        -TransactionId $transactionId
    Copy-ManagedTree -Source $sourceSkillRoot -Destination $paths.skillStage
    Copy-ManagedTree -Source $sourceRuntimeRoot -Destination (Join-Path $paths.runtimeStage 'windows\scripts')
    Copy-UnmanagedTargetFiles -ExistingRoot $targetSkillRoot -StageRoot $paths.skillStage -ManagedFiles @($manifest.managedFiles.skill)
    Copy-UnmanagedTargetFiles -ExistingRoot $targetRuntimeRoot -StageRoot $paths.runtimeStage -ManagedFiles @($manifest.managedFiles.runtime)
    Write-BridgeDeploymentManifest -Root $paths.skillStage -Manifest $manifest
    Write-BridgeDeploymentManifest -Root $paths.runtimeStage -Manifest $manifest
    if ($TestOnly -and $TestFailureAt -eq 'CorruptStagedManifest') {
        [IO.File]::WriteAllText((Join-Path $paths.runtimeStage 'deployment-manifest.json'), '{"corrupt":true}', [Text.Encoding]::UTF8)
    }
    Assert-ManifestShape -Manifest (Read-BridgeDeploymentManifest -Root $paths.skillStage) -SkillTargetRoot $targetSkillRoot -RuntimeTargetRoot $targetRuntimeRoot -Label 'staged Skill manifest' | Out-Null
    Assert-ManifestShape -Manifest (Read-BridgeDeploymentManifest -Root $paths.runtimeStage) -SkillTargetRoot $targetSkillRoot -RuntimeTargetRoot $targetRuntimeRoot -Label 'staged Runtime manifest' | Out-Null
    Assert-ManifestTrees -Manifest $manifest -SkillRoot $paths.skillStage -RuntimeRoot $paths.runtimeStage -Label 'staged deployment trees'
    $journal = New-InstallJournal -Paths $paths -Manifest $manifest
    Write-InstallJournal -Journal $journal

    if (Test-Path -LiteralPath $targetSkillRoot) { Move-Item -LiteralPath $targetSkillRoot -Destination $paths.skillBackup }
    $journal.state = 'backed-up-skill'; Write-InstallJournal -Journal $journal
    Move-Item -LiteralPath $paths.skillStage -Destination $targetSkillRoot
    $journal.state = 'skill-switched'; Write-InstallJournal -Journal $journal
    if ($TestOnly -and $TestFailureAt -eq 'BeforeRuntimeSwitch') { throw "Injected installation failure at BeforeRuntimeSwitch." }
    if (Test-Path -LiteralPath $targetRuntimeRoot) { Move-Item -LiteralPath $targetRuntimeRoot -Destination $paths.runtimeBackup }
    $journal.state = 'backed-up-runtime'; Write-InstallJournal -Journal $journal
    Move-Item -LiteralPath $paths.runtimeStage -Destination $targetRuntimeRoot
    $journal.state = 'runtime-switched'; Write-InstallJournal -Journal $journal
    if ($TestOnly -and $TestFailureAt -eq 'AfterRuntimeSwitch') { throw "Injected installation failure at AfterRuntimeSwitch." }
    Assert-DeploymentPair -SkillRoot $targetSkillRoot -RuntimeRoot $targetRuntimeRoot -RepositoryRoot $repositoryRoot -RequireSourceMatch | Out-Null
    if ($TestOnly -and $TestFailureAt -eq 'BeforeCommit') { throw "Injected installation failure at BeforeCommit." }
    $journal.state = 'committed'; Write-InstallJournal -Journal $journal
    if ($TestOnly -and $TestFailureAt -eq 'AfterCommitBeforeCleanup') { throw "Injected installation failure at AfterCommitBeforeCleanup." }

    Remove-CommittedTransactionResidue -Journal $journal
    [ordered]@{
        pass = $true
        bridgeVersion = [string]$manifest.bridgeVersion
        protocolVersion = [string]$manifest.protocolVersion
        sourceCommit = [string]$manifest.sourceCommit
        sourceCommitStatus = [string]$manifest.sourceCommitStatus
        manifestHash = [string]$manifest.manifestHash
        skillTarget = $targetSkillRoot
        runtimeTarget = $targetRuntimeRoot
    } | ConvertTo-Json -Compress
} catch {
    $originalError = $_.Exception.Message
    if ($null -ne $journal -and [string]$journal.state -eq 'committed') {
        try { Remove-CommittedTransactionResidue -Journal $journal }
        catch { $rollbackError = $_.Exception.Message }
        if ($rollbackError) {
            throw "Global bridge installation committed, but cleanup is incomplete. Skill=$targetSkillRoot Runtime=$targetRuntimeRoot. Details=$originalError; cleanup=$rollbackError. Rerun install to recover the validated journal."
        }
        throw "Global bridge installation committed, but cleanup failed. Skill=$targetSkillRoot Runtime=$targetRuntimeRoot. Details=$originalError"
    } elseif ($null -ne $journal) {
        try {
            $journal.state = 'rollback-required'
            Write-InstallJournal -Journal $journal
            Restore-InstallTransaction -Journal $journal
            Assert-OwnedJournalPath -Path $journal.journalPath -TransactionId $journal.transactionId | Out-Null
            Remove-Item -LiteralPath $journal.journalPath -Force
        } catch {
            $rollbackError = $_.Exception.Message
        }
    } else {
        foreach ($pair in @(
            @{ path = $paths.skillStage; parent = $skillsParent; prefix = '.dispatch-chatgpt-bridge-stage-skill-' },
            @{ path = $paths.runtimeStage; parent = $runtimeParent; prefix = '.dispatch-chatgpt-bridge-stage-runtime-' }
        )) {
            try { Remove-OwnedSiblingPath -Path $pair.path -Parent $pair.parent -Prefix $pair.prefix -TransactionId $transactionId } catch { $rollbackError = $_.Exception.Message }
        }
    }
    if ($rollbackError) {
        throw "Global bridge installation failed and rollback is incomplete. Skill=$targetSkillRoot Runtime=$targetRuntimeRoot. Details=$originalError; rollback=$rollbackError. Inspect the validated transaction residue and rerun install."
    }
    throw "Global bridge installation failed; previous Skill/Runtime trees were restored. Skill=$targetSkillRoot Runtime=$targetRuntimeRoot. Details=$originalError"
}
