function Get-NormalizedBridgePath {
  param([string]$Value, [string]$Label)
  Assert-AbsoluteBridgePath -Value $Value -Label $Label
  return [IO.Path]::GetFullPath($Value)
}

function Test-SameBridgePath {
  param([string]$Left, [string]$Right)
  return [string]::Equals(
    [IO.Path]::GetFullPath($Left),
    [IO.Path]::GetFullPath($Right),
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Assert-NoReparseAncestors {
  param([Parameter(Mandatory = $true)][string]$Path, [string]$Label = 'path')
  $current = [IO.Path]::GetFullPath($Path)
  while ($true) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label traverses a reparse point."
      }
      if ($item.PSIsContainer -eq $false) {
        if (-not (Test-SameBridgePath -Left $current -Right $Path)) {
          throw "$Label has a non-directory ancestor."
        }
      }
    }
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrWhiteSpace($parent) -or (Test-SameBridgePath -Left $parent -Right $current)) {
      return
    }
    $current = $parent
  }
}

function Get-DefaultLaunchRoot {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is required for the default detached launch root.'
  }
  return [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexChatGPTBridge\launches'))
}

function Get-LaunchRootPath {
  param([string]$RequestedRoot)
  $root = if ([string]::IsNullOrWhiteSpace($RequestedRoot)) {
    Get-DefaultLaunchRoot
  } else {
    Get-NormalizedBridgePath -Value $RequestedRoot -Label 'LaunchRoot'
  }
  Assert-NoReparseAncestors -Path $root -Label 'LaunchRoot'
  if (Test-Path -LiteralPath $root -PathType Leaf) {
    throw 'LaunchRoot must be a directory or a missing path.'
  }
  return $root
}

function Write-LaunchRecordAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Record
  )
  $temp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = $Record | ConvertTo-Json -Compress -Depth 12
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($temp, $json + [Environment]::NewLine, $utf8)
    Move-Item -LiteralPath $temp -Destination $Path -Force | Out-Null
  } catch {
    if (Test-Path -LiteralPath $temp) {
      Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    }
    throw
  }
}

function Read-BoundedText {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int64]$MaxBytes = 1048576,
    [string]$Label = 'file'
  )
  Assert-NoReparseAncestors -Path $Path -Label $Label
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer) { throw "$Label is not a file." }
  if ($item.Length -gt $MaxBytes) { throw "$Label exceeds the bounded read limit." }
  return [IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8)
}

function Test-LaunchProperty {
  param([Parameter(Mandatory = $true)][object]$Record, [Parameter(Mandatory = $true)][string]$Name)
  return $null -ne $Record.PSObject.Properties[$Name]
}

function Test-JsonInteger {
  param([AllowNull()][object]$Value)
  return $Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64] -or
    $Value -is [uint16] -or $Value -is [uint32] -or $Value -is [uint64]
}

function Assert-LaunchNullableString {
  param([AllowNull()][object]$Value, [Parameter(Mandatory = $true)][string]$Label)
  if ($null -ne $Value -and $Value -isnot [string]) { throw "launch record $Label must be a string or null." }
}

function Assert-LaunchString {
  param([AllowNull()][object]$Value, [Parameter(Mandatory = $true)][string]$Label)
  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$Value)) {
    throw "launch record $Label must be a non-empty string."
  }
}

function Assert-LaunchRecord {
  param(
    [Parameter(Mandatory = $true)][object]$Record,
    [Parameter(Mandatory = $true)][string]$RequestedPath
  )
  if ($null -eq $Record -or $Record -is [Array]) { throw 'launch record must be an object.' }
  $allowed = @(
    'schemaVersion', 'launchId', 'command', 'state', 'pid', 'processStartedAt',
    'launchPath', 'reportPath', 'progressPath', 'stdoutPath', 'stderrPath',
    'startedAt', 'updatedAt', 'authorization', 'inputPath', 'statePath',
    'timeoutMs', 'pollMs', 'error', 'errorClass', 'wrapperPid'
  )
  $unknown = @($Record.PSObject.Properties.Name | Where-Object { $_ -notin $allowed })
  if ($unknown.Count -gt 0) { throw 'launch record contains an unknown field.' }
  $required = @(
    'schemaVersion', 'launchId', 'command', 'state', 'pid', 'processStartedAt',
    'launchPath', 'reportPath', 'progressPath', 'stdoutPath', 'stderrPath',
    'startedAt', 'updatedAt', 'authorization', 'inputPath', 'statePath',
    'timeoutMs', 'pollMs', 'error', 'errorClass', 'wrapperPid'
  )
  $missing = @($required | Where-Object { -not (Test-LaunchProperty -Record $Record -Name $_) })
  if ($missing.Count -gt 0) { throw 'launch record is missing a required field.' }
  if (-not (Test-JsonInteger $Record.schemaVersion) -or [int64]$Record.schemaVersion -ne 1) {
    throw 'launch record schemaVersion is invalid.'
  }
  Assert-LaunchString -Value $Record.launchId -Label 'launchId'
  if ([string]$Record.launchId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
    throw 'launch record launchId is invalid.'
  }
  Assert-LaunchString -Value $Record.command -Label 'command'
  Assert-LaunchString -Value $Record.state -Label 'state'
  if ($Record.command -notin @('batch', 'resume', 'watch')) { throw 'launch record command is invalid.' }
  if ($Record.state -notin @('starting', 'running', 'failed')) {
    throw 'launch record state is invalid.'
  }
  if (-not (Test-JsonInteger $Record.timeoutMs) -or [int64]$Record.timeoutMs -lt 5000 -or [int64]$Record.timeoutMs -gt 900000) {
    throw 'launch record timeoutMs is invalid.'
  }
  if (-not (Test-JsonInteger $Record.pollMs) -or [int64]$Record.pollMs -lt 250 -or [int64]$Record.pollMs -gt 30000) {
    throw 'launch record pollMs is invalid.'
  }
  foreach ($field in @('launchPath', 'reportPath', 'stdoutPath', 'stderrPath', 'startedAt', 'updatedAt', 'inputPath')) {
    Assert-LaunchString -Value $Record.$field -Label $field
  }
  foreach ($field in @('statePath', 'processStartedAt', 'error', 'errorClass', 'wrapperPid', 'pid')) {
    if ($field -in @('pid', 'wrapperPid')) { continue }
    Assert-LaunchNullableString -Value $Record.$field -Label $field
  }
  if ($Record.command -eq 'batch') {
    Assert-LaunchString -Value $Record.progressPath -Label 'progressPath'
  } elseif ($null -ne $Record.progressPath) {
    throw 'resume and watch launch records must not claim a progressPath.'
  }
  if ($Record.pid -isnot [int] -and $Record.pid -isnot [long] -and $null -ne $Record.pid) {
    throw 'launch record pid must be an integer or null.'
  }
  if ($Record.wrapperPid -isnot [int] -and $Record.wrapperPid -isnot [long] -and $null -ne $Record.wrapperPid) {
    throw 'launch record wrapperPid must be an integer or null.'
  }
  $normalizedRequested = Get-NormalizedBridgePath -Value $RequestedPath -Label 'LaunchPath'
  $normalizedLaunch = Get-NormalizedBridgePath -Value ([string]$Record.launchPath) -Label 'launchPath'
  if (-not (Test-SameBridgePath -Left $normalizedRequested -Right $normalizedLaunch)) {
    throw 'launch record path does not match the requested launch path.'
  }
  if ([IO.Path]::GetFileName($normalizedLaunch) -ne 'launch.json') {
    throw 'launch record file name is invalid.'
  }
  $launchDirectory = [IO.Path]::GetDirectoryName($normalizedLaunch)
  if ([IO.Path]::GetFileName($launchDirectory) -ine ([string]$Record.launchId)) {
    throw 'launch record directory is not bound to launchId.'
  }
  Assert-NoReparseAncestors -Path $normalizedLaunch -Label 'launchPath'
  Assert-NoReparseAncestors -Path $launchDirectory -Label 'launch directory'
  foreach ($field in @('reportPath', 'stdoutPath', 'stderrPath', 'inputPath', 'statePath')) {
    if ($null -eq $Record.$field) { continue }
    $value = Get-NormalizedBridgePath -Value ([string]$Record.$field) -Label $field
    Assert-NoReparseAncestors -Path $value -Label $field
    if (Test-SameBridgePath -Left $value -Right $normalizedLaunch) {
      throw "launch record $field collides with launchPath."
    }
  }
  $stdout = Get-NormalizedBridgePath -Value ([string]$Record.stdoutPath) -Label 'stdoutPath'
  $stderr = Get-NormalizedBridgePath -Value ([string]$Record.stderrPath) -Label 'stderrPath'
  if (-not (Test-SameBridgePath -Left ([IO.Path]::GetDirectoryName($stdout)) -Right $launchDirectory) -or
      -not (Test-SameBridgePath -Left ([IO.Path]::GetDirectoryName($stderr)) -Right $launchDirectory)) {
    throw 'launch logs must remain inside the launch directory.'
  }
  if (Test-SameBridgePath -Left $stdout -Right $stderr) { throw 'launch logs collide.' }
  $report = Get-NormalizedBridgePath -Value ([string]$Record.reportPath) -Label 'reportPath'
  if ((Test-SameBridgePath -Left $report -Right $stdout) -or
      (Test-SameBridgePath -Left $report -Right $stderr)) {
    throw 'report path collides with launch logs.'
  }
  if ($Record.command -eq 'batch') {
    $progress = Get-NormalizedBridgePath -Value ([string]$Record.progressPath) -Label 'progressPath'
    Assert-NoReparseAncestors -Path $progress -Label 'progressPath'
    if (-not (Test-SameBridgePath -Left $progress -Right ($report + '.progress.json'))) {
      throw 'batch launch progressPath is not derived from reportPath.'
    }
  }
  foreach ($field in @('startedAt', 'updatedAt')) {
    try {
      [DateTimeOffset]::Parse(
        [string]$Record.$field,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
      ) | Out-Null
    } catch {
      throw "launch record $field is invalid."
    }
  }
  $pidValue = 0
  if ($null -ne $Record.pid) {
    if (-not [int]::TryParse([string]$Record.pid, [ref]$pidValue) -or $pidValue -le 0) {
      throw 'launch record pid is invalid.'
    }
  }
  $wrapperPidValue = 0
  if ($null -ne $Record.wrapperPid) {
    if (-not [int]::TryParse([string]$Record.wrapperPid, [ref]$wrapperPidValue) -or $wrapperPidValue -le 0) {
      throw 'launch record wrapperPid is invalid.'
    }
  }
  if ($null -ne $Record.processStartedAt) {
    try {
      [DateTimeOffset]::Parse(
        [string]$Record.processStartedAt,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
      ) | Out-Null
    } catch {
      throw 'launch record processStartedAt is invalid.'
    }
  }
  if ($null -eq $Record.authorization -or $Record.authorization -is [Array] -or $Record.authorization -isnot [pscustomobject]) {
    throw 'launch record authorization is invalid.'
  }
  $authFields = @($Record.authorization.PSObject.Properties.Name)
  if ($authFields.Count -ne 2 -or $authFields -notcontains 'allowSend' -or $authFields -notcontains 'allowDelete' -or
      $Record.authorization.allowSend -isnot [bool] -or $Record.authorization.allowDelete -isnot [bool]) {
    throw 'launch record authorization is invalid.'
  }
  if ($null -ne $Record.error -and ([string]$Record.error).Length -gt 1000) {
    throw 'launch record error is too long.'
  }
  if ($null -ne $Record.errorClass -and $Record.errorClass -notin @('not-created', 'created-but-unattributed')) {
    throw 'launch record errorClass is invalid.'
  }
  if (($null -eq $Record.pid) -xor ($null -eq $Record.processStartedAt)) {
    throw 'launch record pid and processStartedAt must be both null or both present.'
  }
  if ($Record.state -eq 'running' -and $null -eq $Record.pid) {
    throw 'running launch record must identify a process.'
  }
  if ($Record.state -eq 'starting' -and $null -ne $Record.pid) {
    throw 'starting launch record must not claim an attributed final process.'
  }
  if ($Record.state -eq 'failed' -and $Record.errorClass -ne 'not-created') {
    throw 'failed launch record must explicitly prove not-created.'
  }
  if ($Record.errorClass -eq 'not-created' -and ($Record.state -ne 'failed' -or $null -ne $Record.pid -or $null -ne $Record.wrapperPid)) {
    throw 'not-created launch record has an invalid state combination.'
  }
  if ($Record.errorClass -eq 'created-but-unattributed' -and ($Record.state -ne 'starting' -or $null -eq $Record.wrapperPid -or $null -ne $Record.pid)) {
    throw 'created-but-unattributed launch record has an invalid state combination.'
  }
  return $Record
}

function Read-LaunchRecord {
  param([Parameter(Mandatory = $true)][string]$Path)
  $text = Read-BoundedText -Path $Path -MaxBytes 1048576 -Label 'launch record'
  try {
    $record = $text | ConvertFrom-Json
  } catch {
    throw 'launch record JSON is invalid.'
  }
  Assert-LaunchRecord -Record $record -RequestedPath $Path | Out-Null
  return $record
}

function Get-AmbiguousJobSummaries {
  param([AllowNull()][object]$Jobs)
  $ambiguous = @()
  $seen = @{}
  foreach ($job in @($Jobs)) {
    if ($null -eq $job) { continue }
    $status = [string]$job.status
    if ($status -notin @('unknown-after-submit', 'timeout-after-submit', 'unknown')) { continue }
    if ($job.id -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$job.id)) { continue }
    if ($null -ne $job.marker -and $job.marker -isnot [string]) { continue }
    $marker = if ($null -ne $job.marker) { [string]$job.marker } else { $null }
    $key = '{0}|{1}|{2}' -f [string]$job.id, $status, $marker
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $ambiguous += [ordered]@{
      id = [string]$job.id
      status = $status
      conversationId = if ($job.conversationId -is [string]) { [string]$job.conversationId } else { $null }
      expectedConversationId = if ($job.expectedConversationId -is [string]) { [string]$job.expectedConversationId } else { $null }
      marker = $marker
      historyTitle = if ($job.historyTitle -is [string]) { [string]$job.historyTitle } else { $null }
    }
  }
  return @($ambiguous)
}

function New-ArtifactReadResult {
  param(
    [Parameter(Mandatory = $true)][bool]$Exists,
    [Parameter(Mandatory = $true)][bool]$Valid,
    [Parameter(Mandatory = $true)][bool]$Corrupt,
    [AllowNull()][object]$Summary,
    [AllowNull()][string]$ErrorCode
  )
  return [ordered]@{
    exists = $Exists
    valid = $Valid
    corrupt = $Corrupt
    summary = $Summary
    error = $ErrorCode
  }
}

function Get-ReportSummary {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$LaunchId
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    return New-ArtifactReadResult -Exists $false -Valid $false -Corrupt $false -Summary $null -ErrorCode $null
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return New-ArtifactReadResult -Exists $true -Valid $false -Corrupt $true -Summary $null -ErrorCode 'report-corrupt'
  }
  $errorCode = 'report-corrupt'
  try {
    $text = Read-BoundedText -Path $Path -MaxBytes 16777216 -Label 'bridge report'
    $value = $text | ConvertFrom-Json
    if ($null -eq $value -or $value -is [Array] -or $value.pass -isnot [bool] -or [string]$value.command -ne $Command) {
      throw 'invalid report shape'
    }
    if ($value.launchId -isnot [string] -or [string]$value.launchId -ne $LaunchId) {
      $errorCode = 'report-rebound'
      throw 'report launch identity does not match.'
    }
    $summary = [ordered]@{
      pass = [bool]$value.pass
      command = [string]$value.command
      runId = if ($value.runId) { [string]$value.runId } else { $null }
      requestedJobs = if ($value.requestedJobs -is [int] -or $value.requestedJobs -is [long]) { [int]$value.requestedJobs } else { $null }
      completedJobs = if ($value.completedJobs -is [int] -or $value.completedJobs -is [long]) { [int]$value.completedJobs } else { $null }
      recoveryRequired = $false
      ambiguousJobs = @(Get-AmbiguousJobSummaries -Jobs $value.jobs)
    }
    return New-ArtifactReadResult -Exists $true -Valid $true -Corrupt $false -Summary $summary -ErrorCode $null
  } catch {
    return New-ArtifactReadResult -Exists $true -Valid $false -Corrupt $true -Summary $null -ErrorCode $errorCode
  }
}

function Get-ProgressSummary {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$LaunchId
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    return New-ArtifactReadResult -Exists $false -Valid $false -Corrupt $false -Summary $null -ErrorCode $null
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return New-ArtifactReadResult -Exists $true -Valid $false -Corrupt $true -Summary $null -ErrorCode 'progress-corrupt'
  }
  $errorCode = 'progress-corrupt'
  try {
    $text = Read-BoundedText -Path $Path -MaxBytes 8388608 -Label 'batch progress'
    $value = $text | ConvertFrom-Json
    if ($null -eq $value -or $value -is [Array] -or [string]$value.command -ne 'batch') {
      throw 'invalid progress shape'
    }
    if ($value.launchId -isnot [string] -or [string]$value.launchId -ne $LaunchId) {
      $errorCode = 'progress-rebound'
      throw 'progress launch identity does not match.'
    }
    $ambiguous = @(Get-AmbiguousJobSummaries -Jobs $value.jobs)
    $summary = [ordered]@{
      runId = if ($value.runId) { [string]$value.runId } else { $null }
      requestedJobs = if ($value.requestedJobs -is [int] -or $value.requestedJobs -is [long]) { [int]$value.requestedJobs } else { $null }
      submittedJobs = if ($value.submittedJobs -is [int] -or $value.submittedJobs -is [long]) { [int]$value.submittedJobs } else { $null }
      completedJobs = if ($value.completedJobs -is [int] -or $value.completedJobs -is [long]) { [int]$value.completedJobs } else { $null }
      recoveryRequired = $ambiguous.Count -gt 0
      ambiguousJobs = $ambiguous
    }
    return New-ArtifactReadResult -Exists $true -Valid $true -Corrupt $false -Summary $summary -ErrorCode $null
  } catch {
    return New-ArtifactReadResult -Exists $true -Valid $false -Corrupt $true -Summary $null -ErrorCode $errorCode
  }
}

function Test-LaunchProcessAlive {
  param([Parameter(Mandatory = $true)][object]$Record)
  if ($null -eq $Record.pid -or $null -eq $Record.processStartedAt) { return $false }
  try {
    $process = Get-Process -Id ([int]$Record.pid) -ErrorAction Stop
    $expected = [DateTimeOffset]::Parse(
      [string]$Record.processStartedAt,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    )
    $actual = [DateTimeOffset]$process.StartTime.ToUniversalTime()
    return [Math]::Abs(($actual - $expected).TotalSeconds) -le 2
  } catch {
    return $false
  }
}

function Get-LaunchStatus {
  param([Parameter(Mandatory = $true)][string]$Path)
  $record = Read-LaunchRecord -Path $Path
  $reportResult = Get-ReportSummary -Path ([string]$record.reportPath) -Command ([string]$record.command) -LaunchId ([string]$record.launchId)
  $progressResult = if ($record.command -eq 'batch') {
    Get-ProgressSummary -Path ([string]$record.progressPath) -LaunchId ([string]$record.launchId)
  } else {
    New-ArtifactReadResult -Exists $false -Valid $false -Corrupt $false -Summary $null -ErrorCode $null
  }
  $report = $reportResult.summary
  $progress = $progressResult.summary
  $reportObservation = if ($reportResult.corrupt) {
    [ordered]@{ exists = $true; valid = $false; corrupt = $true; error = $reportResult.error }
  } else { $report }
  $progressObservation = if ($progressResult.corrupt) {
    [ordered]@{ exists = $true; valid = $false; corrupt = $true; error = $progressResult.error }
  } else { $progress }

  $ambiguous = @()
  $ambiguous = @(Get-AmbiguousJobSummaries -Jobs @(
    if ($null -ne $report) { @($report.ambiguousJobs) }
    if ($null -ne $progress) { @($progress.ambiguousJobs) }
  ))
  $recoveryRequired = $ambiguous.Count -gt 0

  $base = [ordered]@{
    pass = $false
    schemaVersion = 1
    launchId = [string]$record.launchId
    launchPath = [string]$record.launchPath
    command = [string]$record.command
    state = 'failed'
    reason = 'no-report'
    timedOut = $false
    pid = $record.pid
    processStartedAt = $record.processStartedAt
    wrapperPid = $record.wrapperPid
    errorClass = $record.errorClass
    reportPath = $record.reportPath
    progressPath = $record.progressPath
    report = $reportObservation
    progress = $progressObservation
    recoveryRequired = $recoveryRequired
    ambiguousJobs = $ambiguous
  }

  if ($record.errorClass -eq 'created-but-unattributed' -and $null -eq $report) {
    $base.state = 'unknown-after-launch'
    $base.reason = 'created-but-unattributed'
    $base.recoveryRequired = $true
    $base.retryAllowed = $false
    return $base
  }
  if ($reportResult.corrupt) {
    $base.reason = $reportResult.error
    $base.reportCorrupt = $true
    if ($reportResult.error -eq 'report-rebound') { $base.reportRebound = $true }
    return $base
  }
  if ($progressResult.corrupt -and $progressResult.error -eq 'progress-rebound') {
    $base.reason = 'progress-rebound'
    $base.progressCorrupt = $true
    $base.progressRebound = $true
    return $base
  }
  if ($null -ne $report) {
    $base.pass = [bool]$report.pass
    $base.state = if ($report.pass) { 'complete' } else { 'failed' }
    $base.reason = if ($report.pass) { 'report-pass' } else { 'report-failed' }
    if ($progressResult.corrupt) { $base.progressCorrupt = $true }
    return $base
  }
  $alive = Test-LaunchProcessAlive -Record $record
  if ($alive) {
    $base.pass = $true
    $base.state = 'running'
    $base.reason = if ($progressResult.corrupt) { 'progress-corrupt' } else { 'child-alive-no-report' }
    if ($progressResult.corrupt) { $base.progressCorrupt = $true }
    return $base
  }
  if ($progressResult.corrupt) {
    $base.reason = $progressResult.error
    $base.progressCorrupt = $true
  } elseif ($record.state -eq 'failed' -and $record.errorClass -eq 'not-created') {
    $base.reason = 'launch-failed'
    $base.retryAllowed = $true
  } else {
    $base.state = 'unknown-after-launch'
    $base.reason = 'launch-outcome-unknown'
    $base.recoveryRequired = $true
    $base.retryAllowed = $false
  }
  return $base
}

function Wait-LaunchStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][int]$Timeout,
    [Parameter(Mandatory = $true)][int]$Poll
  )
  $deadline = [DateTimeOffset]::UtcNow.AddMilliseconds($Timeout)
  while ($true) {
    $status = Get-LaunchStatus -Path $Path
    if ($status.state -in @('complete', 'failed', 'unknown-after-launch')) { return $status }
    if ([DateTimeOffset]::UtcNow -ge $deadline) {
      $status.state = 'timeout'
      $status.timedOut = $true
      $status.observedState = 'running'
      $status.reason = 'bounded-wait-timeout'
      return $status
    }
    Start-Sleep -Milliseconds $Poll
  }
}

function Get-ProcessStartedAtText {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
  return ([DateTimeOffset]$Process.StartTime.ToUniversalTime()).ToString('o')
}

function ConvertTo-WindowsProcessArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) {
      $backslashes++
      continue
    }
    if ($character -eq '"') {
      for ($index = 0; $index -lt ($backslashes * 2 + 1); $index++) { [void]$builder.Append([char]92) }
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    for ($index = 0; $index -lt $backslashes; $index++) { [void]$builder.Append([char]92) }
    [void]$builder.Append($character)
    $backslashes = 0
  }
  for ($index = 0; $index -lt ($backslashes * 2); $index++) { [void]$builder.Append([char]92) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function ConvertTo-PowerShellLiteral {
  param([Parameter(Mandatory = $true)][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Start-DetachedNodeWorker {
  param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][object[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$LaunchToken,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath,
    [Parameter(Mandatory = $true)][bool]$SimulateAttributionFailure
  )
  $workerScript = Join-Path $PSScriptRoot 'detached-node-worker.ps1'
  if (-not (Test-Path -LiteralPath $workerScript -PathType Leaf)) {
    throw 'detached worker script is missing.'
  }
  $launchDirectory = [IO.Path]::GetDirectoryName($StdoutPath)
  $configPath = Join-Path $launchDirectory 'worker-config.json'
  $handshakePath = Join-Path $launchDirectory 'worker-handshake.json'
  $workerErrorPath = Join-Path $launchDirectory 'worker-error.json'
  $workerStartedPath = Join-Path $launchDirectory 'worker-started.json'
  $workerStdoutPath = Join-Path $launchDirectory 'worker-stdout.log'
  $workerStderrPath = Join-Path $launchDirectory 'worker-stderr.log'
  Assert-NoReparseAncestors -Path $configPath -Label 'worker config'
  Assert-NoReparseAncestors -Path $handshakePath -Label 'worker handshake'
  Assert-NoReparseAncestors -Path $workerErrorPath -Label 'worker error'
  Assert-NoReparseAncestors -Path $workerStartedPath -Label 'worker started marker'
  Assert-NoReparseAncestors -Path $workerStdoutPath -Label 'worker stdout'
  Assert-NoReparseAncestors -Path $workerStderrPath -Label 'worker stderr'
  Write-LaunchRecordAtomically -Path $configPath -Record ([ordered]@{
    schemaVersion = 1
    launchId = $LaunchToken
    nodePath = $NodePath
    arguments = @($Arguments | ForEach-Object { [string]$_ })
    stdoutPath = $StdoutPath
    stderrPath = $StderrPath
    handshakePath = $handshakePath
    workerErrorPath = $workerErrorPath
    workerStartedPath = $workerStartedPath
    workerStdoutPath = $workerStdoutPath
    workerStderrPath = $workerStderrPath
  })
  # Win32_Process.Create is used for the final Node process itself. This
  # removes the unreliable PowerShell trampoline/argv boundary: the PID
  # returned by CIM is the PID we monitor and the launch token is on that
  # exact command line. The strict worker script remains available for direct
  # validation tests, but is not a second attribution point in production.
  foreach ($logPath in @($workerStdoutPath, $workerStderrPath)) {
    if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
      [IO.File]::WriteAllText($logPath, '')
    }
  }
  $nodeCommandLine = (ConvertTo-WindowsProcessArgument -Value $NodePath) + ' ' +
    ((@($Arguments | ForEach-Object {
      ConvertTo-WindowsProcessArgument -Value ([string]$_)
    })) -join ' ')
  try {
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $nodeCommandLine } -ErrorAction Stop
  } catch {
    $errorRecord = New-Object System.Exception('detached Node was not created.')
    $errorRecord.Data['launchClass'] = 'not-created'
    throw $errorRecord
  }
  if ($null -eq $created -or [int]$created.ReturnValue -ne 0) {
    $errorRecord = New-Object System.Exception('detached Node was not created.')
    $errorRecord.Data['launchClass'] = 'not-created'
    throw $errorRecord
  }
  $wrapperPid = [int]$created.ProcessId
  try {
    if ($wrapperPid -le 0) { throw 'detached Node creation returned no attributable PID.' }
    Write-LaunchRecordAtomically -Path $workerStartedPath -Record ([ordered]@{
      schemaVersion = 1
      state = 'created'
      launchId = $LaunchToken
      pid = $wrapperPid
    })
    if ($SimulateAttributionFailure) {
      $errorRecord = New-Object System.Exception('detached Node process was created but attribution was intentionally withheld.')
      $errorRecord.Data['launchClass'] = 'created-but-unattributed'
      $errorRecord.Data['wrapperPid'] = $wrapperPid
      throw $errorRecord
    }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
      try {
        $process = Get-Process -Id $wrapperPid -ErrorAction Stop
        $processStartedAt = Get-ProcessStartedAtText -Process $process
        Write-LaunchRecordAtomically -Path $handshakePath -Record ([ordered]@{
          schemaVersion = 1
          launchId = $LaunchToken
          pid = $wrapperPid
          processStartedAt = $processStartedAt
          workerPid = $PID
        })
        return [ordered]@{
          pid = $wrapperPid
          processStartedAt = $processStartedAt
          wrapperPid = $wrapperPid
        }
      } catch {
        # The process may need one short scheduling turn before Get-Process can
        # resolve its start time. A missing attribution remains ambiguous.
      }
      Start-Sleep -Milliseconds 100
    }
    throw 'detached Node process was created but could not be attributed.'
  } catch {
    if ($null -eq $_.Exception.Data -or -not $_.Exception.Data.Contains('launchClass')) {
      $_.Exception.Data['launchClass'] = 'created-but-unattributed'
    }
    if ($null -eq $_.Exception.Data -or -not $_.Exception.Data.Contains('wrapperPid')) {
      $_.Exception.Data['wrapperPid'] = $wrapperPid
    }
    throw
  }
}



function New-LaunchRecord {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$LaunchId,
    [Parameter(Mandatory = $true)][string]$LaunchPath,
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [AllowNull()][object]$ProgressPath,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath,
    [Parameter(Mandatory = $true)][string]$InputPath,
    [AllowNull()][object]$StatePath,
    [Parameter(Mandatory = $true)][int]$Timeout,
    [Parameter(Mandatory = $true)][int]$Poll,
    [Parameter(Mandatory = $true)][bool]$AllowSend,
    [Parameter(Mandatory = $true)][bool]$AllowDelete
  )
  $now = [DateTimeOffset]::UtcNow.ToString('o')
  return [ordered]@{
    schemaVersion = 1
    launchId = $LaunchId
    command = $Command
    state = 'starting'
    pid = $null
    processStartedAt = $null
    wrapperPid = $null
    launchPath = $LaunchPath
    reportPath = $ReportPath
    progressPath = $ProgressPath
    stdoutPath = $StdoutPath
    stderrPath = $StderrPath
    startedAt = $now
    updatedAt = $now
    authorization = [ordered]@{
      allowSend = $AllowSend
      allowDelete = $AllowDelete
    }
    inputPath = $InputPath
    statePath = $StatePath
    timeoutMs = $Timeout
    pollMs = $Poll
    error = $null
    errorClass = $null
  }
}

function Convert-LaunchRecordToPublic {
  param(
    [Parameter(Mandatory = $true)][object]$Record,
    [Parameter(Mandatory = $true)][bool]$Pass
  )
  $public = [ordered]@{ pass = $Pass }
  if ($Record -is [System.Collections.IDictionary]) {
    foreach ($key in $Record.Keys) {
      $public[$key] = $Record[$key]
    }
  } else {
    foreach ($property in $Record.PSObject.Properties) {
      $public[$property.Name] = $property.Value
    }
  }
  return $public
}

function Start-DetachedLaunch {
  param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][object[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [AllowNull()][string]$StatePath,
    [AllowNull()][AllowEmptyString()][string]$RequestedLaunchRoot,
    [Parameter(Mandatory = $true)][int]$Timeout,
    [Parameter(Mandatory = $true)][int]$Poll,
    [Parameter(Mandatory = $true)][bool]$AllowSend,
    [Parameter(Mandatory = $true)][bool]$AllowDelete,
    [Parameter(Mandatory = $true)][bool]$SimulateStartFailure,
    [Parameter(Mandatory = $true)][bool]$SimulateAttributionFailure
  )
  $launchRootPath = Get-LaunchRootPath -RequestedRoot $RequestedLaunchRoot
  $inputFull = Get-NormalizedBridgePath -Value $InputPath -Label 'InputPath'
  $reportFull = Get-NormalizedBridgePath -Value $ReportPath -Label 'OutputPath'
  $stateFull = if ($StatePath) { Get-NormalizedBridgePath -Value $StatePath -Label 'StatePath' } else { $null }
  if ((Test-SameBridgePath -Left $launchRootPath -Right $inputFull) -or
      (Test-SameBridgePath -Left $launchRootPath -Right $reportFull) -or
      ($stateFull -and (Test-SameBridgePath -Left $launchRootPath -Right $stateFull))) {
    throw 'LaunchRoot collides with a business path.'
  }
  [IO.Directory]::CreateDirectory($launchRootPath) | Out-Null
  $launchId = [guid]::NewGuid().ToString('D')
  $launchDirectory = Join-Path $launchRootPath $launchId
  if (Test-Path -LiteralPath $launchDirectory) {
    throw 'Generated launch directory already exists.'
  }
  $launchPath = Join-Path $launchDirectory 'launch.json'
  $stdoutPath = Join-Path $launchDirectory 'stdout.log'
  $stderrPath = Join-Path $launchDirectory 'stderr.log'
  $progressPath = if ($Command -eq 'batch') { "$reportFull.progress.json" } else { $null }
  foreach ($businessPath in @($inputFull, $reportFull, $stateFull, $progressPath)) {
    if ($businessPath -and (
        (Test-SameBridgePath -Left $businessPath -Right $launchPath) -or
        (Test-SameBridgePath -Left $businessPath -Right $stdoutPath) -or
        (Test-SameBridgePath -Left $businessPath -Right $stderrPath))) {
      throw 'Detached launch control files collide with a business path.'
    }
  }
  [IO.Directory]::CreateDirectory($launchDirectory) | Out-Null
  $recordParameters = @{
    Command = $Command
    LaunchId = $launchId
    LaunchPath = $launchPath
    ReportPath = $reportFull
    ProgressPath = $progressPath
    StdoutPath = $stdoutPath
    StderrPath = $stderrPath
    InputPath = $inputFull
    StatePath = $stateFull
    Timeout = $Timeout
    Poll = $Poll
    AllowSend = $AllowSend
    AllowDelete = $AllowDelete
  }
  $record = New-LaunchRecord @recordParameters
  Write-LaunchRecordAtomically -Path $launchPath -Record $record
  $child = $null
  try {
    if ($SimulateStartFailure) {
      throw 'test-only Start-Process failure'
    }
    $launchArguments = @($Arguments + @('--bridge-launch-token', $launchId))
    $workerParameters = @{
      NodePath = $NodePath
      Arguments = $launchArguments
      LaunchToken = $launchId
      StdoutPath = $stdoutPath
      StderrPath = $stderrPath
      SimulateAttributionFailure = $SimulateAttributionFailure
    }
    $handshake = Start-DetachedNodeWorker @workerParameters
    $child = $handshake
    $record.pid = [int]$handshake.pid
    $record.processStartedAt = [string]$handshake.processStartedAt
    $record.wrapperPid = [int]$handshake.wrapperPid
    $record.state = 'running'
    $record.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-LaunchRecordAtomically -Path $launchPath -Record $record
    return Convert-LaunchRecordToPublic -Record $record -Pass $true
  } catch {
    $message = (($_.Exception.Message -replace '[\r\n]+', ' ').Trim())
    if ($message.Length -gt 500) { $message = $message.Substring(0, 500) }
    $record.error = $message
    $record.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $launchClass = if ($null -ne $_.Exception.Data -and $_.Exception.Data.Contains('launchClass')) {
      [string]$_.Exception.Data['launchClass']
    } elseif ($null -ne $child) {
      'created-but-unattributed'
    } else {
      'not-created'
    }
    $record.errorClass = $launchClass
    if ($launchClass -eq 'created-but-unattributed') {
      if ($null -ne $_.Exception.Data -and $_.Exception.Data.Contains('wrapperPid')) {
        $record.wrapperPid = [int]$_.Exception.Data['wrapperPid']
      } elseif ($null -ne $child -and $null -ne $child.wrapperPid) {
        $record.wrapperPid = [int]$child.wrapperPid
      }
      $record.state = 'starting'
      $record.error = if ($message -match 'failed before final Node handshake') {
        'detached worker was created but failed before final Node handshake; do not retry automatically.'
      } else {
        'detached Node was created but final PID attribution failed; do not retry automatically.'
      }
      Write-LaunchRecordAtomically -Path $launchPath -Record $record
      return Convert-LaunchRecordToPublic -Record $record -Pass $false
    }
    $record.state = 'failed'
    Write-LaunchRecordAtomically -Path $launchPath -Record $record
    return Convert-LaunchRecordToPublic -Record $record -Pass $false
  }
}
