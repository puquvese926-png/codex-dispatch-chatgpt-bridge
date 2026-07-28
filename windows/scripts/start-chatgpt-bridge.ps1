[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 9335,
  [switch]$RestartExisting,
  [string]$StatePath,
  [switch]$SelfTest,
  [Parameter(DontShow = $true)]
  [switch]$RestartWorker,
  [Parameter(DontShow = $true)]
  [string]$RestartRequestPath,
  [Parameter(DontShow = $true)]
  [string]$RestartReportPath
  ,
  [Parameter(DontShow = $true)]
  [switch]$ProtocolSelfTest,
  [Parameter(DontShow = $true)]
  [string]$ProtocolTestRoot,
  [Parameter(DontShow = $true)]
  [ValidateSet('success', 'no-ack', 'expired', 'malformed', 'rebound')]
  [string]$ProtocolTestScenario = 'success'
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
$portWasExplicit = $PSBoundParameters.ContainsKey('Port')
$statePathWasExplicit = $PSBoundParameters.ContainsKey('StatePath')
if ([string]::IsNullOrWhiteSpace($StatePath)) {
  $stateRoot = $env:LOCALAPPDATA
  if ([string]::IsNullOrWhiteSpace($stateRoot)) { $stateRoot = [IO.Path]::GetTempPath() }
  $StatePath = Join-Path $stateRoot 'CodexChatGPTBridge\state.json'
}

function Get-BridgeWindowsPowerShellPath {
  if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) {
    throw 'Windows PowerShell path cannot be resolved without SystemRoot.'
  }
  $candidate = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw 'The verified Windows PowerShell 5.1 executable is missing.'
  }
  return $candidate
}

function ConvertTo-BridgeWindowsProcessArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) { $backslashes++; continue }
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

if ($PSVersionTable.PSEdition -ne 'Desktop') {
  $windowsPowerShell = Get-BridgeWindowsPowerShellPath
  $relayArguments = @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $PSCommandPath
  )
  if ($portWasExplicit) { $relayArguments += @('-Port', "$Port") }
  if ($RestartExisting) { $relayArguments += '-RestartExisting' }
  if ($statePathWasExplicit) {
    $relayArguments += @('-StatePath', [IO.Path]::GetFullPath($StatePath))
  }
  if ($SelfTest) { $relayArguments += '-SelfTest' }
  if ($RestartWorker) {
    $relayArguments += @(
      '-RestartWorker',
      '-RestartRequestPath',
      [IO.Path]::GetFullPath($RestartRequestPath),
      '-RestartReportPath',
      [IO.Path]::GetFullPath($RestartReportPath)
    )
  }
  if ($ProtocolSelfTest) {
    $relayArguments += @(
      '-ProtocolSelfTest',
      '-ProtocolTestRoot',
      [IO.Path]::GetFullPath($ProtocolTestRoot),
      '-ProtocolTestScenario',
      $ProtocolTestScenario
    )
  }
  & $windowsPowerShell @relayArguments
  exit $LASTEXITCODE
}

function Test-BridgePathEqual {
  param([string]$Left, [string]$Right)
  if (-not $Left -or -not $Right) { return $false }
  try {
    return [IO.Path]::GetFullPath($Left).TrimEnd('\') -ieq
      [IO.Path]::GetFullPath($Right).TrimEnd('\')
  } catch {
    return $false
  }
}

function Get-BridgeApplicationId {
  param([Parameter(Mandatory = $true)][string]$PackageRoot)
  $manifestPath = Join-Path $PackageRoot 'AppxManifest.xml'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
  try {
    [xml]$manifest = [IO.File]::ReadAllText($manifestPath)
    $applications = @($manifest.SelectNodes(
      "/*[local-name()='Package']/*[local-name()='Applications']/*[local-name()='Application']"
    ))
    $matches = @($applications | Where-Object {
      "$($_.GetAttribute('Executable'))".Replace('/', '\') -ieq 'app\ChatGPT.exe' -and
        "$($_.GetAttribute('EntryPoint'))" -ieq 'Windows.FullTrustApplication'
    })
    if ($matches.Count -ne 1) { return $null }
    $applicationId = "$($matches[0].GetAttribute('Id'))"
    if ($applicationId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { return $null }
    return $applicationId
  } catch {
    return $null
  }
}

function ConvertTo-BridgeCodexInstall {
  param([Parameter(Mandatory = $true)][object]$Package)
  if ("$($Package.Name)" -ine 'OpenAI.Codex' -or -not $Package.InstallLocation -or
      -not $Package.PackageFullName -or -not $Package.PackageFamilyName -or
      "$($Package.SignatureKind)" -ine 'Store' -or [bool]$Package.IsDevelopmentMode) {
    return $null
  }
  $packageRoot = "$($Package.InstallLocation)"
  $executable = Join-Path $packageRoot 'app\ChatGPT.exe'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { return $null }
  $applicationId = Get-BridgeApplicationId -PackageRoot $packageRoot
  if (-not $applicationId) { return $null }
  return [pscustomobject]@{
    PackageRoot = $packageRoot
    Executable = $executable
    Version = "$($Package.Version)"
    PackageFullName = "$($Package.PackageFullName)"
    PackageFamilyName = "$($Package.PackageFamilyName)"
    AppUserModelId = "$($Package.PackageFamilyName)!$applicationId"
  }
}

function Get-BridgeCodexInstall {
  $packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
    Sort-Object Version -Descending)
  foreach ($package in $packages) {
    $install = ConvertTo-BridgeCodexInstall -Package $package
    if ($null -ne $install) { return $install }
  }
  throw 'The official OpenAI.Codex Store package is not installed or cannot be validated.'
}

function Get-BridgeCodexProcesses {
  param([Parameter(Mandatory = $true)][object]$Codex)
  return @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction Stop |
    Where-Object {
      Test-BridgePathEqual -Left "$($_.ExecutablePath)" -Right "$($Codex.Executable)"
    })
}

function Get-BridgeProcessPorts {
  param([Parameter(Mandatory = $true)][object[]]$Processes)
  $ports = @()
  foreach ($process in $Processes) {
    $commandLine = "$($process.CommandLine)"
    if ($commandLine -notmatch '(?:^|\s)--remote-debugging-address(?:=|\s+)127\.0\.0\.1(?:$|\s)') {
      continue
    }
    $match = [regex]::Match(
      $commandLine,
      '(?:^|\s)--remote-debugging-port(?:=|\s+)(?<port>\d{4,5})(?:$|\s)'
    )
    if ($match.Success) {
      $candidate = [int]$match.Groups['port'].Value
      if ($candidate -ge 1024 -and $candidate -le 65535) { $ports += $candidate }
    }
  }
  return @($ports | Sort-Object -Unique)
}

function Get-BridgePortListeners {
  param([Parameter(Mandatory = $true)][int]$CandidatePort)
  return @(Get-NetTCPConnection -State Listen -LocalPort $CandidatePort -ErrorAction SilentlyContinue)
}

function Test-BridgeBrowserWebSocketUrl {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][int]$CandidatePort
  )
  try {
    $uri = [Uri]$Value
    return $uri.Scheme -ceq 'ws' -and
      @('127.0.0.1', 'localhost', '[::1]', '::1') -contains $uri.Host -and
      $uri.Port -eq $CandidatePort -and
      -not $uri.UserInfo -and
      -not $uri.Query -and
      -not $uri.Fragment -and
      $uri.AbsolutePath -cmatch '^/devtools/browser/[A-Za-z0-9._-]{1,200}$'
  } catch {
    return $false
  }
}

function Get-BridgeCdpIdentity {
  param(
    [Parameter(Mandatory = $true)][int]$CandidatePort,
    [Parameter(Mandatory = $true)][object]$Codex
  )
  $listeners = @(Get-BridgePortListeners -CandidatePort $CandidatePort)
  if ($listeners.Count -eq 0) { return $null }
  foreach ($listener in $listeners) {
    $address = "$($listener.LocalAddress)".ToLowerInvariant()
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$listener.OwningProcess)" `
      -ErrorAction Stop
    $commandLine = "$($process.CommandLine)"
    if (@('127.0.0.1', '::1') -notcontains $address -or
        -not (Test-BridgePathEqual -Left "$($process.ExecutablePath)" -Right "$($Codex.Executable)") -or
        $commandLine -notmatch "(?:^|\s)--remote-debugging-port(?:=|\s+)$CandidatePort(?:$|\s)" -or
        $commandLine -notmatch '(?:^|\s)--remote-debugging-address(?:=|\s+)127\.0\.0\.1(?:$|\s)') {
      throw "Port $CandidatePort is occupied by an unverified listener."
    }
  }
  try {
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$CandidatePort/json/version" `
      -Method Get -TimeoutSec 3 -ErrorAction Stop
  } catch {
    throw "Verified Codex listener on port $CandidatePort did not expose /json/version."
  }
  $webSocketUrl = "$($version.webSocketDebuggerUrl)"
  if (-not (Test-BridgeBrowserWebSocketUrl -Value $webSocketUrl -CandidatePort $CandidatePort)) {
    throw 'The Codex CDP browser identity is invalid.'
  }
  return [pscustomobject]@{
    BrowserId = ([Uri]$webSocketUrl).AbsolutePath.Split('/')[-1]
    ProcessId = [int]$listeners[0].OwningProcess
  }
}

function Start-BridgeCodexApplication {
  param(
    [Parameter(Mandatory = $true)][object]$Codex,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  if ($null -eq ('CodexChatGPTBridge.Runtime.PackagedApplicationActivator' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodexChatGPTBridge.Runtime
{
    [Flags]
    internal enum ActivateOptions { None = 0 }

    [ComImport]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            ActivateOptions options,
            out uint processId);
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA907894A3D")]
    internal class ApplicationActivationManager { }

    public static class PackagedApplicationActivator
    {
        public static uint Activate(string appUserModelId, string arguments)
        {
            IApplicationActivationManager manager =
                (IApplicationActivationManager)new ApplicationActivationManager();
            uint processId;
            int result = manager.ActivateApplication(
                appUserModelId, arguments ?? string.Empty, ActivateOptions.None, out processId);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return processId;
        }
    }
}
'@
  }
  $argumentLine = @($Arguments) -join ' '
  return [CodexChatGPTBridge.Runtime.PackagedApplicationActivator]::Activate(
    "$($Codex.AppUserModelId)",
    $argumentLine
  )
}

function Wait-BridgeCdpIdentity {
  param(
    [Parameter(Mandatory = $true)][int]$CandidatePort,
    [Parameter(Mandatory = $true)][object]$Codex,
    [int]$TimeoutMs = 45000
  )
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $identity = Get-BridgeCdpIdentity -CandidatePort $CandidatePort -Codex $Codex
      if ($null -ne $identity) { return $identity }
    } catch {
      if ([DateTime]::UtcNow.AddMilliseconds(300) -ge $deadline) { throw }
    }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

function Write-BridgeState {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$State
  )
  if (-not [IO.Path]::IsPathRooted($Path)) { throw 'StatePath must be absolute.' }
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporaryPath = Join-Path $directory ".state-$PID-$([guid]::NewGuid().ToString('N')).tmp"
  $encoding = [Text.UTF8Encoding]::new($false)
  try {
    [IO.File]::WriteAllText($temporaryPath, (($State | ConvertTo-Json -Depth 5) + "`n"), $encoding)
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
}

function Assert-BridgeNoReparseAncestors {
  param([Parameter(Mandatory = $true)][string]$Path)
  $current = [IO.Path]::GetFullPath($Path)
  while ($true) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Restart protocol path is under a reparse point: $current"
    }
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -ieq $current) { break }
    $current = [IO.Path]::GetFullPath($parent)
  }
}

function Assert-BridgeAbsoluteProtocolPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not [IO.Path]::IsPathRooted($Path)) { throw 'Restart protocol paths must be absolute.' }
  Assert-BridgeNoReparseAncestors -Path $Path
  return [IO.Path]::GetFullPath($Path)
}

function Assert-BridgeRestartPathSet {
  param(
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [Parameter(Mandatory = $true)][string]$ReadyPath,
    [Parameter(Mandatory = $true)][string]$AckPath,
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$OperationId
  )
  $request = Assert-BridgeAbsoluteProtocolPath -Path $RequestPath
  $report = Assert-BridgeAbsoluteProtocolPath -Path $ReportPath
  $ready = Assert-BridgeAbsoluteProtocolPath -Path $ReadyPath
  $ack = Assert-BridgeAbsoluteProtocolPath -Path $AckPath
  $state = Assert-BridgeAbsoluteProtocolPath -Path $StatePath
  $directory = Split-Path -Parent $request
  foreach ($candidate in @($request, $report, $ready, $ack, $state)) {
    if ((Split-Path -Parent $candidate) -ine $directory) {
      throw 'Restart protocol files must share one controlled state directory.'
    }
  }
  if ([IO.Path]::GetFileName($request) -cne "restart-request-$OperationId.json" -or
      [IO.Path]::GetFileName($ready) -cne "restart-ready-$OperationId.json" -or
      [IO.Path]::GetFileName($ack) -cne "restart-ack-$OperationId.json" -or
      [IO.Path]::GetFileName($report) -cne 'restart-report.json') {
    throw 'Restart protocol file names are not bound to operationId.'
  }
  return [pscustomobject]@{
    RequestPath = $request
    ReportPath = $report
    ReadyPath = $ready
    AckPath = $ack
    StatePath = $state
    Directory = $directory
  }
}

function Read-BridgeUtf8Json {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$MaxBytes = 1048576
  )
  $file = Assert-BridgeAbsoluteProtocolPath -Path $Path
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw 'Restart protocol file is missing.'
  }
  $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
  if ([int64]$item.Length -gt $MaxBytes) { throw 'Restart protocol file is too large.' }
  $bytes = [IO.File]::ReadAllBytes($file)
  $decoder = New-Object System.Text.UTF8Encoding($false, $true)
  try { $text = $decoder.GetString($bytes) } catch { throw 'Restart protocol file is not strict UTF-8.' }
  if ([string]::IsNullOrWhiteSpace($text)) { throw 'Restart protocol file is empty.' }
  try {
    $value = $text | ConvertFrom-Json -ErrorAction Stop
    [void](Normalize-BridgeTimestampFields -Value $value -Label 'Restart protocol')
    return $value
  } catch { throw 'Restart protocol JSON is invalid.' }
}

function Assert-BridgeExactProperties {
  param(
    [Parameter(Mandatory = $true)][object]$Value,
    [Parameter(Mandatory = $true)][string[]]$Allowed,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($null -eq $Value -or $null -eq $Value.PSObject) { throw "$Label must be an object." }
  $actual = @($Value.PSObject.Properties.Name)
  foreach ($name in $actual) {
    if ($Allowed -notcontains $name) { throw "$Label contains an unknown field." }
  }
}

function Assert-BridgeStringValue {
  param([Parameter(Mandatory = $true)][object]$Value, [Parameter(Mandatory = $true)][string]$Label)
  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$Value)) {
    throw "$Label must be a non-empty string."
  }
}

function ConvertTo-BridgeUtcTimestamp {
  param(
    [AllowNull()][object]$Value,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$AllowNull
  )
  if ($null -eq $Value) {
    if ($AllowNull) { return $null }
    throw "$Label must be a non-empty ISO timestamp."
  }
  $timestamp = $null
  if ($Value -is [DateTimeOffset]) {
    $timestamp = [DateTimeOffset]$Value
  } elseif ($Value -is [DateTime]) {
    $dateTime = [DateTime]$Value
    if ($dateTime.Kind -eq [DateTimeKind]::Unspecified) {
      throw "$Label must include a timezone."
    }
    $timestamp = [DateTimeOffset]$dateTime
  } elseif ($Value -is [string]) {
    if ([string]::IsNullOrWhiteSpace($Value) -or
        $Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$') {
      throw "$Label must be a strict ISO timestamp with timezone."
    }
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse(
        $Value,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$parsed)) {
      throw "$Label is invalid."
    }
    $timestamp = $parsed
  } else {
    throw "$Label must be a string, DateTime, DateTimeOffset, or null."
  }
  return $timestamp.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
}

function Normalize-BridgeTimestampFields {
  param(
    [AllowNull()][object]$Value,
    [string]$Label = 'JSON value'
  )
  if ($null -eq $Value) { return }
  if ($Value -is [Array]) {
    foreach ($item in @($Value)) { [void](Normalize-BridgeTimestampFields -Value $item -Label $Label) }
    return
  }
  if ($Value -isnot [pscustomobject]) { return }
  $timestampNames = @(
    'startedAt', 'updatedAt', 'processStartedAt', 'submittedAt',
    'completedAt', 'createdAt', 'deletedAt', 'requestedAt',
    'dispatchDeadline', 'ackedAt', 'at'
  )
  foreach ($property in @($Value.PSObject.Properties)) {
    if ($timestampNames -contains $property.Name) {
      if ($null -ne $property.Value) {
        $property.Value = ConvertTo-BridgeUtcTimestamp -Value $property.Value -Label "$Label $($property.Name)"
      }
    } else {
      [void](Normalize-BridgeTimestampFields -Value $property.Value -Label $Label)
    }
  }
}

function Assert-BridgeRestartTimestamp {
  param([Parameter(Mandatory = $true)][object]$Value, [Parameter(Mandatory = $true)][string]$Label)
  [void](ConvertTo-BridgeUtcTimestamp -Value $Value -Label $Label)
}

function Assert-BridgeRestartRequest {
  param(
    [Parameter(Mandatory = $true)][object]$Request,
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [Parameter(Mandatory = $true)][string]$ReadyPath,
    [Parameter(Mandatory = $true)][string]$AckPath,
    [Parameter(Mandatory = $true)][string]$StatePath
  )
  Assert-BridgeExactProperties -Value $Request -Allowed @(
    'schemaVersion', 'action', 'operationId', 'requestedAt', 'dispatchDeadline',
    'port', 'statePath', 'packageFullName', 'processIds', 'requestPath',
    'reportPath', 'readyPath', 'ackPath', 'testMode', 'testScenario'
  ) -Label 'Restart request'
  if ($Request.schemaVersion -isnot [int] -and $Request.schemaVersion -isnot [long]) { throw 'Restart request schemaVersion is invalid.' }
  if ([int]$Request.schemaVersion -ne 2 -or "$($Request.action)" -cne 'restart') { throw 'Restart request schema is invalid.' }
  Assert-BridgeStringValue -Value $Request.operationId -Label 'Restart operationId'
  if ("$($Request.operationId)" -cnotmatch '^[a-f0-9]{32}$') { throw 'Restart operationId is invalid.' }
  Assert-BridgeRestartTimestamp -Value $Request.requestedAt -Label 'Restart requestedAt'
  Assert-BridgeRestartTimestamp -Value $Request.dispatchDeadline -Label 'Restart dispatchDeadline'
  if ($Request.port -isnot [int] -and $Request.port -isnot [long]) { throw 'Restart port is invalid.' }
  if ([int]$Request.port -lt 1024 -or [int]$Request.port -gt 65535) { throw 'Restart port is invalid.' }
  Assert-BridgeStringValue -Value $Request.packageFullName -Label 'Restart packageFullName'
  if ($Request.processIds -is [string] -or @($Request.processIds).Count -lt 1) { throw 'Restart processIds are invalid.' }
  foreach ($processId in @($Request.processIds)) {
    if (($processId -isnot [int]) -and ($processId -isnot [long])) { throw 'Restart processIds are invalid.' }
    if ([int]$processId -le 0) { throw 'Restart processIds are invalid.' }
  }
  Assert-BridgeStringValue -Value $Request.requestPath -Label 'Restart requestPath'
  Assert-BridgeStringValue -Value $Request.reportPath -Label 'Restart reportPath'
  Assert-BridgeStringValue -Value $Request.readyPath -Label 'Restart readyPath'
  Assert-BridgeStringValue -Value $Request.ackPath -Label 'Restart ackPath'
  Assert-BridgeStringValue -Value $Request.statePath -Label 'Restart statePath'
  $paths = Assert-BridgeRestartPathSet -RequestPath $Request.requestPath -ReportPath $Request.reportPath `
    -ReadyPath $Request.readyPath -AckPath $Request.ackPath -StatePath $Request.statePath `
    -OperationId "$($Request.operationId)"
  foreach ($pair in @(
      @($paths.RequestPath, $RequestPath), @($paths.ReportPath, $ReportPath),
      @($paths.ReadyPath, $ReadyPath), @($paths.AckPath, $AckPath), @($paths.StatePath, $StatePath))) {
    if (-not (Test-BridgePathEqual -Left $pair[0] -Right $pair[1])) { throw 'Restart request path identity changed.' }
  }
  if ($Request.testMode -isnot [bool] -or $Request.testScenario -isnot [string]) { throw 'Restart test fields are invalid.' }
  if (@('success', 'no-ack', 'expired', 'malformed', 'rebound') -notcontains "$($Request.testScenario)") { throw 'Restart test scenario is invalid.' }
  return $paths
}

function Add-BridgeRestartHistoryEntry {
  param([object[]]$History, [string]$Status, [string]$ErrorClass = $null)
  $entry = [ordered]@{ status = $Status; at = [DateTime]::UtcNow.ToString('o'); errorClass = $ErrorClass }
  return @($History) + [pscustomobject]$entry
}

function Write-BridgeRestartReport {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$OperationId,
    [Parameter(Mandatory = $true)][string]$Status,
    [Parameter(Mandatory = $true)][bool]$Ready,
    [Parameter(Mandatory = $true)][bool]$Acknowledged,
    [Parameter(Mandatory = $true)][string]$RequestedAt,
    [Parameter(Mandatory = $true)][string]$DispatchDeadline,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ReadyPath,
    [Parameter(Mandatory = $true)][string]$AckPath,
    [int]$WorkerProcessId = 0,
    [object[]]$History = @(),
    [string]$ErrorClass = $null,
    [string]$ErrorMessage = $null
  )
  $entry = [ordered]@{ status = $Status; at = [DateTime]::UtcNow.ToString('o'); errorClass = $ErrorClass }
  $nextHistory = @($History) + [pscustomobject]$entry
  $completedAt = $null
  if (@('complete', 'failed') -contains $Status) { $completedAt = [DateTime]::UtcNow.ToString('o') }
  $workerProcessValue = $null
  if ($WorkerProcessId -gt 0) { $workerProcessValue = $WorkerProcessId }
  $errorClassValue = $null
  if (-not [string]::IsNullOrWhiteSpace($ErrorClass)) { $errorClassValue = $ErrorClass }
  $errorMessageValue = $null
  if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) { $errorMessageValue = $ErrorMessage }
  $retryAllowed = [bool]($Status -eq 'failed' -and $errorClassValue -eq 'worker-not-created')
  $recoveryRequired = [bool]($Status -eq 'failed' -and -not $retryAllowed)
  Write-BridgeState -Path $Path -State ([ordered]@{
    schemaVersion = 2
    action = 'restart'
    operationId = $OperationId
    status = $Status
    ready = $Ready
    acknowledged = $Acknowledged
    requestedAt = $RequestedAt
    dispatchDeadline = $DispatchDeadline
    completedAt = $completedAt
    port = $Port
    statePath = $StatePath
    requestPath = $RequestPath
    readyPath = $ReadyPath
    ackPath = $AckPath
    workerProcessId = $workerProcessValue
    history = $nextHistory
    errorClass = $errorClassValue
    error = $errorMessageValue
    retryAllowed = $retryAllowed
    recoveryRequired = $recoveryRequired
  })
  return $nextHistory
}

function Read-BridgeRestartHistory {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $report = Read-BridgeUtf8Json -Path $Path
    if ($null -eq $report.history) { return @() }
    return @($report.history)
  } catch {
    return @()
  }
}

function Assert-BridgeReadyRecord {
  param(
    [Parameter(Mandatory = $true)][object]$Ready,
    [Parameter(Mandatory = $true)][object]$Request,
    [Parameter(Mandatory = $true)][int]$ExpectedWorkerProcessId
  )
  Assert-BridgeExactProperties -Value $Ready -Allowed @(
    'schemaVersion', 'action', 'status', 'ready', 'operationId',
    'workerProcessId', 'reportPath', 'ackPath', 'dispatchDeadline'
  ) -Label 'Restart ready record'
  if ($Ready.schemaVersion -isnot [int] -and $Ready.schemaVersion -isnot [long]) { throw 'Restart ready schemaVersion is invalid.' }
  if ([int]$Ready.schemaVersion -ne 2 -or "$($Ready.action)" -cne 'restart' -or "$($Ready.status)" -cne 'worker-ready') { throw 'Restart ready record is invalid.' }
  if ($Ready.ready -isnot [bool] -or -not [bool]$Ready.ready) { throw 'Restart ready record is invalid.' }
  if ("$($Ready.operationId)" -cne "$($Request.operationId)" -or [int]$Ready.workerProcessId -ne $ExpectedWorkerProcessId) { throw 'Restart ready identity changed.' }
  if (-not (Test-BridgePathEqual -Left "$($Ready.reportPath)" -Right "$($Request.reportPath)") -or
      -not (Test-BridgePathEqual -Left "$($Ready.ackPath)" -Right "$($Request.ackPath)")) { throw 'Restart ready paths changed.' }
  if ("$($Ready.dispatchDeadline)" -cne "$($Request.dispatchDeadline)") { throw 'Restart ready deadline changed.' }
}

function Assert-BridgeAckRecord {
  param(
    [Parameter(Mandatory = $true)][object]$Ack,
    [Parameter(Mandatory = $true)][object]$Request,
    [Parameter(Mandatory = $true)][int]$ExpectedWorkerProcessId
  )
  Assert-BridgeExactProperties -Value $Ack -Allowed @(
    'schemaVersion', 'action', 'status', 'operationId', 'ackedAt',
    'parentProcessId', 'workerProcessId', 'reportPath', 'dispatchDeadline'
  ) -Label 'Restart acknowledgement'
  if ($Ack.schemaVersion -isnot [int] -and $Ack.schemaVersion -isnot [long]) { throw 'Restart acknowledgement schemaVersion is invalid.' }
  if ([int]$Ack.schemaVersion -ne 2 -or "$($Ack.action)" -cne 'restart' -or "$($Ack.status)" -cne 'ack') { throw 'Restart acknowledgement is invalid.' }
  Assert-BridgeStringValue -Value $Ack.operationId -Label 'Restart acknowledgement operationId'
  if ("$($Ack.operationId)" -cne "$($Request.operationId)") { throw 'Restart acknowledgement identity changed.' }
  Assert-BridgeRestartTimestamp -Value $Ack.ackedAt -Label 'Restart acknowledgement ackedAt'
  if ($Ack.parentProcessId -isnot [int] -and $Ack.parentProcessId -isnot [long]) { throw 'Restart acknowledgement parentProcessId is invalid.' }
  if ($Ack.workerProcessId -isnot [int] -and $Ack.workerProcessId -isnot [long]) { throw 'Restart acknowledgement workerProcessId is invalid.' }
  if ([int]$Ack.workerProcessId -ne $ExpectedWorkerProcessId) { throw 'Restart acknowledgement worker identity changed.' }
  if (-not (Test-BridgePathEqual -Left "$($Ack.reportPath)" -Right "$($Request.reportPath)")) { throw 'Restart acknowledgement report path changed.' }
  if ("$($Ack.dispatchDeadline)" -cne "$($Request.dispatchDeadline)") { throw 'Restart acknowledgement deadline changed.' }
}

function Start-BridgeDetachedRestart {
  param(
    [Parameter(Mandatory = $true)][object]$Codex,
    [Parameter(Mandatory = $true)][object[]]$Processes,
    [Parameter(Mandatory = $true)][int]$CandidatePort,
    [Parameter(Mandatory = $true)][string]$TargetStatePath,
    [bool]$TestOnlyProtocol = $false,
    [ValidateSet('success', 'no-ack', 'expired', 'malformed', 'rebound')]
    [string]$ProtocolScenario = 'success',
    [string]$WorkerScriptPath = $PSCommandPath
  )
  $stateFile = Assert-BridgeAbsoluteProtocolPath -Path $TargetStatePath
  $stateDirectory = Split-Path -Parent $stateFile
  New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
  Assert-BridgeNoReparseAncestors -Path $stateDirectory
  $operationId = [guid]::NewGuid().ToString('N')
  $requestPath = Join-Path $stateDirectory "restart-request-$operationId.json"
  $reportPath = Join-Path $stateDirectory 'restart-report.json'
  $readyPath = Join-Path $stateDirectory "restart-ready-$operationId.json"
  $ackPath = Join-Path $stateDirectory "restart-ack-$operationId.json"
  $paths = Assert-BridgeRestartPathSet -RequestPath $requestPath -ReportPath $reportPath -ReadyPath $readyPath -AckPath $ackPath -StatePath $stateFile -OperationId $operationId
  $requestedAt = ConvertTo-BridgeUtcTimestamp -Value ([DateTime]::UtcNow.ToString('o')) -Label 'Restart requestedAt'
  if ($TestOnlyProtocol) {
    $dispatchDeadline = ConvertTo-BridgeUtcTimestamp -Value ([DateTime]::UtcNow.AddSeconds(10).ToString('o')) -Label 'Restart dispatchDeadline'
    $packageFullName = 'Codex.P07.ProtocolTest'
    $processIds = @(424242)
  } else {
    $dispatchDeadline = ConvertTo-BridgeUtcTimestamp -Value ([DateTime]::UtcNow.AddSeconds(60).ToString('o')) -Label 'Restart dispatchDeadline'
    $packageFullName = "$($Codex.PackageFullName)"
    $processIds = @($Processes | ForEach-Object { [int]$_.ProcessId })
  }
  $request = [ordered]@{
    schemaVersion = 2
    action = 'restart'
    operationId = $operationId
    requestedAt = $requestedAt
    dispatchDeadline = $dispatchDeadline
    port = $CandidatePort
    statePath = $stateFile
    packageFullName = $packageFullName
    processIds = $processIds
    requestPath = $paths.RequestPath
    reportPath = $paths.ReportPath
    readyPath = $paths.ReadyPath
    ackPath = $paths.AckPath
    testMode = [bool]$TestOnlyProtocol
    testScenario = $ProtocolScenario
  }
  [IO.File]::WriteAllText($paths.RequestPath, (($request | ConvertTo-Json -Depth 5) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
  if ($ProtocolScenario -eq 'expired') {
    $request.dispatchDeadline = [DateTime]::UtcNow.AddSeconds(-1).ToString('o')
    [IO.File]::WriteAllText($paths.RequestPath, (($request | ConvertTo-Json -Depth 5) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
  } elseif ($ProtocolScenario -eq 'malformed') {
    [IO.File]::WriteAllText($paths.RequestPath, "{malformed", (New-Object System.Text.UTF8Encoding($false)))
  } elseif ($ProtocolScenario -eq 'rebound') {
    $request.reportPath = Join-Path $stateDirectory '..\outside-report.json'
    [IO.File]::WriteAllText($paths.RequestPath, (($request | ConvertTo-Json -Depth 5) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
  }
  $history = Write-BridgeRestartReport -Path $paths.ReportPath -OperationId $operationId -Status 'dispatching' -Ready $false -Acknowledged $false -RequestedAt $requestedAt -DispatchDeadline $dispatchDeadline -Port $CandidatePort -StatePath $paths.StatePath -RequestPath $paths.RequestPath -ReadyPath $paths.ReadyPath -AckPath $paths.AckPath

  $workerScript = Assert-BridgeAbsoluteProtocolPath -Path $WorkerScriptPath
  if ($TestOnlyProtocol) {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $commandLine = [string]::Join(' ', @(
      (ConvertTo-BridgeWindowsProcessArgument -Value $nodePath),
      (ConvertTo-BridgeWindowsProcessArgument -Value $workerScript),
      '--request',
      (ConvertTo-BridgeWindowsProcessArgument -Value $paths.RequestPath),
      '--report',
      (ConvertTo-BridgeWindowsProcessArgument -Value $paths.ReportPath)
    ))
  } else {
    $powershellPath = Get-BridgeWindowsPowerShellPath
    $commandLine = [string]::Join(' ', @(
      (ConvertTo-BridgeWindowsProcessArgument -Value $powershellPath),
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      (ConvertTo-BridgeWindowsProcessArgument -Value $workerScript),
      '-RestartWorker',
      '-RestartRequestPath',
      (ConvertTo-BridgeWindowsProcessArgument -Value $paths.RequestPath),
      '-RestartReportPath',
      (ConvertTo-BridgeWindowsProcessArgument -Value $paths.ReportPath)
    ))
  }
  if ($TestOnlyProtocol) {
    [IO.File]::WriteAllText((Join-Path $paths.Directory 'protocol-command-line.txt'), $commandLine, (New-Object System.Text.UTF8Encoding($false)))
  }
  $createdPid = 0
  $created = $false
  try {
    $cimResult = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine } -ErrorAction Stop
    if ([int]$cimResult.ReturnValue -ne 0 -or [int]$cimResult.ProcessId -le 0) { throw "Windows process service returned $($cimResult.ReturnValue)." }
    $createdPid = [int]$cimResult.ProcessId
    $created = $true
    $history = Write-BridgeRestartReport -Path $paths.ReportPath -OperationId $operationId -Status 'worker-created' -Ready $false -Acknowledged $false -RequestedAt $requestedAt -DispatchDeadline $dispatchDeadline -Port $CandidatePort -StatePath $paths.StatePath -RequestPath $paths.RequestPath -ReadyPath $paths.ReadyPath -AckPath $paths.AckPath -WorkerProcessId $createdPid -History (Read-BridgeRestartHistory -Path $paths.ReportPath)

    $ready = $null
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(45)
    $requestDeadline = [DateTime]::Parse($dispatchDeadline, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    if ($requestDeadline -lt $readyDeadline) { $readyDeadline = $requestDeadline }
    while ([DateTime]::UtcNow -lt $readyDeadline -and $null -eq $ready) {
      if (Test-Path -LiteralPath $paths.ReadyPath -PathType Leaf) {
        try {
          $candidate = Read-BridgeUtf8Json -Path $paths.ReadyPath
          Assert-BridgeReadyRecord -Ready $candidate -Request $request -ExpectedWorkerProcessId $createdPid
          $ready = $candidate
        } catch {
          throw 'Worker-ready record failed strict validation.'
        }
      } else {
        if (Test-Path -LiteralPath $paths.ReportPath -PathType Leaf) {
          $observedReport = Read-BridgeUtf8Json -Path $paths.ReportPath
          if ("$($observedReport.status)" -eq 'failed') { throw 'Worker failed before worker-ready.' }
        }
        Start-Sleep -Milliseconds 100
      }
    }
    if ($null -eq $ready) { throw 'Worker-ready was not observed before its bounded deadline.' }

    $history = Write-BridgeRestartReport -Path $paths.ReportPath -OperationId $operationId -Status 'restart-dispatched' -Ready $true -Acknowledged $false -RequestedAt $requestedAt -DispatchDeadline $dispatchDeadline -Port $CandidatePort -StatePath $paths.StatePath -RequestPath $paths.RequestPath -ReadyPath $paths.ReadyPath -AckPath $paths.AckPath -WorkerProcessId $createdPid -History (Read-BridgeRestartHistory -Path $paths.ReportPath)
    if ($TestOnlyProtocol -and $ProtocolScenario -eq 'no-ack') {
      $failureDeadline = [DateTime]::Parse($dispatchDeadline, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).AddSeconds(5)
      while ([DateTime]::UtcNow -lt $failureDeadline) {
        if (Test-Path -LiteralPath $paths.ReportPath -PathType Leaf) {
          $observed = Read-BridgeUtf8Json -Path $paths.ReportPath
          if ("$($observed.status)" -eq 'failed') { throw 'Worker rejected missing acknowledgement.' }
        }
        Start-Sleep -Milliseconds 100
      }
      throw 'Worker acknowledgement wait exceeded its bounded deadline.'
    }

    $ack = [ordered]@{
      schemaVersion = 2
      action = 'restart'
      status = 'ack'
      operationId = $operationId
      ackedAt = [DateTime]::UtcNow.ToString('o')
      parentProcessId = [int]$PID
      workerProcessId = $createdPid
      reportPath = $paths.ReportPath
      dispatchDeadline = $dispatchDeadline
    }
    Write-BridgeState -Path $paths.AckPath -State $ack
    return [pscustomobject]@{ OperationId = $operationId; ReportPath = $paths.ReportPath; StatePath = $paths.StatePath; WorkerProcessId = $createdPid; Ready = $true; Acknowledged = $true }
  } catch {
    $errorClass = if ($created) { 'created-but-unattributed' } else { 'worker-not-created' }
    try {
      $currentHistory = Read-BridgeRestartHistory -Path $paths.ReportPath
      $history = Write-BridgeRestartReport -Path $paths.ReportPath -OperationId $operationId -Status 'failed' -Ready $false -Acknowledged $false -RequestedAt $requestedAt -DispatchDeadline $dispatchDeadline -Port $CandidatePort -StatePath $paths.StatePath -RequestPath $paths.RequestPath -ReadyPath $paths.ReadyPath -AckPath $paths.AckPath -WorkerProcessId $createdPid -History $currentHistory -ErrorClass $errorClass -ErrorMessage $errorClass
    } catch { }
    throw
  }
}

function Invoke-BridgeRestartWorker {
  param(
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ReportPath
  )
  $requestFile = [IO.Path]::GetFullPath($RequestPath)
  $reportFile = [IO.Path]::GetFullPath($ReportPath)
  $operationId = 'unknown'
  $request = $null
  $paths = $null
  $requestValid = $false
  $errorClass = 'worker-request-invalid'
  try {
    $request = Read-BridgeUtf8Json -Path $requestFile
    $reportFile = Assert-BridgeAbsoluteProtocolPath -Path $reportFile
    if (-not (Test-BridgePathEqual -Left $reportFile -Right (Join-Path (Split-Path -Parent $requestFile) 'restart-report.json'))) { throw 'Restart report path is not controlled.' }
    $operationId = "$($request.operationId)"
    $paths = Assert-BridgeRestartRequest -Request $request -RequestPath $requestFile -ReportPath $reportFile -ReadyPath (Join-Path (Split-Path -Parent $requestFile) "restart-ready-$operationId.json") -AckPath (Join-Path (Split-Path -Parent $requestFile) "restart-ack-$operationId.json") -StatePath "$($request.statePath)"
    $requestValid = $true
    if ($request.testMode -and "$env:CODEX_BRIDGE_P07_TEST_MODE" -ne '1') { throw 'Restart test mode is not enabled.' }
    $deadline = [DateTime]::Parse("$($request.dispatchDeadline)", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    if ([DateTime]::UtcNow -ge $deadline) { $errorClass = 'restart-deadline-expired'; throw 'Restart request deadline expired.' }
    if (-not $request.testMode) {
      $codex = Get-BridgeCodexInstall
      if ("$($codex.PackageFullName)" -cne "$($request.packageFullName)") { $errorClass = 'package-identity-changed'; throw 'Restart target package identity changed.' }
    } else {
      $codex = $null
    }

    $ready = [ordered]@{ schemaVersion = 2; action = 'restart'; status = 'worker-ready'; ready = $true; operationId = $operationId; workerProcessId = [int]$PID; reportPath = $reportFile; ackPath = $paths.AckPath; dispatchDeadline = "$($request.dispatchDeadline)" }
    Write-BridgeState -Path $paths.ReadyPath -State $ready
    $history = Write-BridgeRestartReport -Path $reportFile -OperationId $operationId -Status 'worker-ready' -Ready $true -Acknowledged $false -RequestedAt "$($request.requestedAt)" -DispatchDeadline "$($request.dispatchDeadline)" -Port ([int]$request.port) -StatePath $paths.StatePath -RequestPath $paths.RequestPath -ReadyPath $paths.ReadyPath -AckPath $paths.AckPath -WorkerProcessId ([int]$PID) -History (Read-BridgeRestartHistory -Path $reportFile)

    $ack = $null
    while ([DateTime]::UtcNow -lt $deadline -and $null -eq $ack) {
      if (Test-Path -LiteralPath $paths.AckPath -PathType Leaf) {
        try {
          $candidateAck = Read-BridgeUtf8Json -Path $paths.AckPath
          Assert-BridgeAckRecord -Ack $candidateAck -Request $request -ExpectedWorkerProcessId ([int]$PID)
          $ack = $candidateAck
        } catch {
          $errorClass = 'ack-invalid'
          throw 'Restart acknowledgement failed strict validation.'
        }
      } else {
        Start-Sleep -Milliseconds 100
      }
    }
    if ($null -eq $ack) { $errorClass = 'ack-not-received'; throw 'Restart acknowledgement was not received before the deadline.' }
    if ([DateTime]::UtcNow -ge $deadline) { $errorClass = 'ack-expired'; throw 'Restart acknowledgement arrived after the deadline.' }
    $ackAgain = Read-BridgeUtf8Json -Path $paths.AckPath
    Assert-BridgeAckRecord -Ack $ackAgain -Request $request -ExpectedWorkerProcessId ([int]$PID)

    if ($request.testMode) {
      Write-BridgeRestartReport -Path $reportFile -OperationId $operationId -Status 'complete' -Ready $true -Acknowledged $true -RequestedAt "$($request.requestedAt)" -DispatchDeadline "$($request.dispatchDeadline)" -Port ([int]$request.port) -StatePath $paths.StatePath -RequestPath $paths.RequestPath -ReadyPath $paths.ReadyPath -AckPath $paths.AckPath -WorkerProcessId ([int]$PID) -History (Read-BridgeRestartHistory -Path $reportFile) | Out-Null
      return
    }

    Write-BridgeRestartReport -Path $reportFile -OperationId $operationId -Status 'stopping-existing' -Ready $true -Acknowledged $true -RequestedAt "$($request.requestedAt)" -DispatchDeadline "$($request.dispatchDeadline)" -Port ([int]$request.port) -StatePath $paths.StatePath -RequestPath $paths.RequestPath -ReadyPath $paths.ReadyPath -AckPath $paths.AckPath -WorkerProcessId ([int]$PID) -History (Read-BridgeRestartHistory -Path $reportFile) | Out-Null
    Start-Sleep -Milliseconds 1500
    foreach ($processId in @($request.processIds)) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$processId)" -ErrorAction SilentlyContinue
      if ($null -eq $process) { continue }
      if (-not (Test-BridgePathEqual -Left "$($process.ExecutablePath)" -Right "$($codex.Executable)")) { $errorClass = 'restart-target-identity-changed'; throw 'Restart target process no longer belongs to verified Codex.' }
      Stop-Process -Id ([int]$processId) -ErrorAction Stop
    }
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 250
      $remaining = @($request.processIds | Where-Object { $null -ne (Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue) })
    } while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $stopDeadline)
    if ($remaining.Count -gt 0) { throw 'Codex processes did not stop within 15 seconds.' }
    Write-BridgeRestartReport -Path $reportFile -OperationId $operationId -Status 'starting' -Ready $true -Acknowledged $true -RequestedAt "$($request.requestedAt)" -DispatchDeadline "$($request.dispatchDeadline)" -Port ([int]$request.port) -StatePath $paths.StatePath -RequestPath $paths.RequestPath -ReadyPath $paths.ReadyPath -AckPath $paths.AckPath -WorkerProcessId ([int]$PID) -History (Read-BridgeRestartHistory -Path $reportFile) | Out-Null
    $arguments = @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$([int]$request.port)")
    $null = Start-BridgeCodexApplication -Codex $codex -Arguments $arguments
    $identity = Wait-BridgeCdpIdentity -CandidatePort ([int]$request.port) -Codex $codex
    if ($null -eq $identity) { throw 'Codex did not expose a verified loopback bridge endpoint.' }
    $state = [ordered]@{ schemaVersion = 1; platform = 'windows'; port = [int]$request.port; browserId = "$($identity.BrowserId)"; codexExe = "$($codex.Executable)"; codexPackageRoot = "$($codex.PackageRoot)"; codexPackageFullName = "$($codex.PackageFullName)"; codexPackageFamilyName = "$($codex.PackageFamilyName)"; codexVersion = "$($codex.Version)"; createdAt = [DateTime]::UtcNow.ToString('o') }
    Write-BridgeState -Path $paths.StatePath -State $state
    Write-BridgeRestartReport -Path $reportFile -OperationId $operationId -Status 'complete' -Ready $true -Acknowledged $true -RequestedAt "$($request.requestedAt)" -DispatchDeadline "$($request.dispatchDeadline)" -Port ([int]$request.port) -StatePath $paths.StatePath -RequestPath $paths.RequestPath -ReadyPath $paths.ReadyPath -AckPath $paths.AckPath -WorkerProcessId ([int]$PID) -History (Read-BridgeRestartHistory -Path $reportFile) | Out-Null
  } catch {
    if ($requestValid) {
      try {
        Write-BridgeRestartReport -Path $reportFile -OperationId $operationId -Status 'failed' -Ready $false -Acknowledged $false -RequestedAt "$($request.requestedAt)" -DispatchDeadline "$($request.dispatchDeadline)" -Port ([int]$request.port) -StatePath $paths.StatePath -RequestPath $paths.RequestPath -ReadyPath $paths.ReadyPath -AckPath $paths.AckPath -WorkerProcessId ([int]$PID) -History (Read-BridgeRestartHistory -Path $reportFile) -ErrorClass $errorClass -ErrorMessage $errorClass | Out-Null
      } catch { }
    }
    throw
  }
}

if ($RestartWorker) {
  if ([string]::IsNullOrWhiteSpace($RestartRequestPath) -or
      [string]::IsNullOrWhiteSpace($RestartReportPath)) {
    throw 'Detached restart worker requires request and report paths.'
  }
  Invoke-BridgeRestartWorker -RequestPath $RestartRequestPath -ReportPath $RestartReportPath
  exit 0
}

if ($ProtocolSelfTest) {
  if ("$env:CODEX_BRIDGE_P07_TEST_MODE" -ne '1' -or [string]::IsNullOrWhiteSpace($ProtocolTestRoot)) {
    throw 'Protocol self-test is test-only and requires CODEX_BRIDGE_P07_TEST_MODE=1 plus a root.'
  }
  $protocolRoot = Assert-BridgeAbsoluteProtocolPath -Path $ProtocolTestRoot
  New-Item -ItemType Directory -Force -Path $protocolRoot | Out-Null
  Assert-BridgeNoReparseAncestors -Path $protocolRoot
  $targetStatePath = Join-Path $protocolRoot 'state.json'
  $workerScriptPath = Join-Path ([IO.Path]::GetTempPath()) ('CodexBridgeP07Worker-' + [guid]::NewGuid().ToString('N') + '.mjs')
  $protocolWorkerSource = @'
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const requestPath = path.resolve(arg("--request") || "");
const reportPath = path.resolve(arg("--report") || "");
const utf8 = "utf8";
const writeJson = (file, value) => {
  const temporary = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { encoding: utf8, flag: "wx" });
  fs.renameSync(temporary, file);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, { encoding: utf8 }));
const fail = (errorClass) => {
  try {
    const report = readJson(reportPath);
    report.status = "failed";
    report.ready = false;
    report.acknowledged = false;
    report.errorClass = errorClass;
    report.error = errorClass;
    report.history = [...(report.history || []), { status: "failed", at: new Date().toISOString(), errorClass }];
    writeJson(reportPath, report);
  } catch {}
  process.exit(1);
};
try {
  const request = readJson(requestPath);
  if (request.schemaVersion !== 2 || request.action !== "restart" || request.testMode !== true) throw new Error("request");
  if (!/^[a-f0-9]{32}$/.test(request.operationId)) throw new Error("operation");
  if (path.resolve(request.requestPath) !== requestPath || path.resolve(request.reportPath) !== reportPath) throw new Error("identity");
  if (path.resolve(request.readyPath).startsWith(path.dirname(requestPath) + path.sep) !== true) throw new Error("ready");
  if (path.resolve(request.ackPath).startsWith(path.dirname(requestPath) + path.sep) !== true) throw new Error("ack");
  const deadline = Date.parse(request.dispatchDeadline);
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("deadline");
  const ready = {
    schemaVersion: 2,
    action: "restart",
    status: "worker-ready",
    ready: true,
    operationId: request.operationId,
    workerProcessId: process.pid,
    reportPath,
    ackPath: path.resolve(request.ackPath),
    dispatchDeadline: request.dispatchDeadline,
  };
  writeJson(path.resolve(request.readyPath), ready);
  const report = readJson(reportPath);
  report.status = "worker-ready";
  report.ready = true;
  report.acknowledged = false;
  report.workerProcessId = process.pid;
  report.history = [...(report.history || []), { status: "worker-ready", at: new Date().toISOString(), errorClass: null }];
  writeJson(reportPath, report);
  const wait = () => {
    if (fs.existsSync(path.resolve(request.ackPath))) {
      const ack = readJson(path.resolve(request.ackPath));
      if (ack.schemaVersion !== 2 || ack.status !== "ack" || ack.operationId !== request.operationId || Number(ack.workerProcessId) !== process.pid) {
        fail("test-worker-ack-invalid");
        return;
      }
      const completed = readJson(reportPath);
      completed.status = "complete";
      completed.ready = true;
      completed.acknowledged = true;
      completed.workerProcessId = process.pid;
      completed.history = [...(completed.history || []), { status: "complete", at: new Date().toISOString(), errorClass: null }];
      writeJson(reportPath, completed);
      process.exit(0);
      return;
    }
    if (Date.now() >= deadline) {
      fail("test-worker-ack-timeout");
      return;
    }
    setTimeout(wait, 100);
  };
  wait();
} catch {
  fail("test-worker-failed");
}
'@
  [IO.File]::WriteAllText($workerScriptPath, $protocolWorkerSource, (New-Object System.Text.UTF8Encoding($false)))
  $fakeCodex = [pscustomobject]@{ PackageFullName = 'Codex.P07.ProtocolTest'; Executable = $PSHOME }
  $fakeProcess = [pscustomobject]@{ ProcessId = 424242 }
  $expectedFailure = $ProtocolTestScenario -ne 'success'
  $restart = $null
  $caught = $null
  try {
    $restart = Start-BridgeDetachedRestart -Codex $fakeCodex -Processes @($fakeProcess) -CandidatePort 9335 -TargetStatePath $targetStatePath -TestOnlyProtocol $true -ProtocolScenario $ProtocolTestScenario -WorkerScriptPath $workerScriptPath
  } catch {
    $caught = $_.Exception.Message
  }
  $reportPath = Join-Path $protocolRoot 'restart-report.json'
  $report = Read-BridgeUtf8Json -Path $reportPath
  if (-not $expectedFailure) {
    $terminalDeadline = [DateTime]::UtcNow.AddSeconds(8)
    while ("$($report.status)" -ne 'complete' -and [DateTime]::UtcNow -lt $terminalDeadline) {
      Start-Sleep -Milliseconds 100
      $report = Read-BridgeUtf8Json -Path $reportPath
    }
  }
  $destructiveMarker = Join-Path $protocolRoot 'destructive-marker.txt'
  $workerWaitDeadline = [DateTime]::UtcNow.AddSeconds(8)
  while ([DateTime]::UtcNow -lt $workerWaitDeadline) {
    if ([int]$report.workerProcessId -le 0 -or $null -eq (Get-Process -Id ([int]$report.workerProcessId) -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 100
  }
  Remove-Item -LiteralPath $workerScriptPath -Force -ErrorAction SilentlyContinue
  $protocolPass = if ($expectedFailure) {
    ($null -ne $caught -and "$($report.status)" -eq 'failed' -and -not (Test-Path -LiteralPath $destructiveMarker))
  } else {
    ($null -eq $caught -and "$($report.status)" -eq 'complete' -and [bool]$report.ready -and [bool]$report.acknowledged -and -not (Test-Path -LiteralPath $destructiveMarker))
  }
  [ordered]@{
    pass = [bool]$protocolPass
    scenario = $ProtocolTestScenario
    readyAckRequired = $true
    destructiveMarkerExists = [bool](Test-Path -LiteralPath $destructiveMarker)
    reportPath = $reportPath
    history = @($report.history)
    report = $report
    error = $caught
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

if ($SelfTest) {
  $safe = Test-BridgeBrowserWebSocketUrl `
    -Value 'ws://127.0.0.1:9335/devtools/browser/browser-123' -CandidatePort 9335
  $unsafe = Test-BridgeBrowserWebSocketUrl `
    -Value 'ws://example.com:9335/devtools/browser/browser-123' -CandidatePort 9335
  [ordered]@{
    pass = [bool]($safe -and -not $unsafe)
    hostEdition = "$($PSVersionTable.PSEdition)"
    stateSchemaVersion = 1
    stateRoot = 'CodexChatGPTBridge'
    restartStrategy = 'cim-ready-ack-worker'
    durableRestartReport = $true
    readyAckRequired = $true
    hotEndpointReuse = $true
    realRestartRequiresAuthorization = $true
  } | ConvertTo-Json -Compress
  exit 0
}

$codex = Get-BridgeCodexInstall
$processes = @(Get-BridgeCodexProcesses -Codex $codex)
if (-not $portWasExplicit) {
  $detectedPorts = @(Get-BridgeProcessPorts -Processes $processes)
  if ($detectedPorts.Count -eq 1) {
    $Port = $detectedPorts[0]
  } elseif ($detectedPorts.Count -gt 1) {
    throw "Multiple verified Codex debugging ports are active: $($detectedPorts -join ', '). Specify -Port."
  }
}

$identity = Get-BridgeCdpIdentity -CandidatePort $Port -Codex $codex
if ($null -eq $identity) {
  if ($processes.Count -gt 0) {
    if (-not $RestartExisting) {
      throw 'Codex is running without a verified loopback bridge endpoint. Rerun with -RestartExisting to dispatch a durable detached restart.'
    }
    $restart = Start-BridgeDetachedRestart -Codex $codex -Processes $processes `
      -CandidatePort $Port -TargetStatePath $StatePath
    [ordered]@{
      pass = $true
      action = 'restart-dispatched'
      ready = $true
      acknowledged = $true
      operationId = "$($restart.OperationId)"
      workerProcessId = [int]$restart.WorkerProcessId
      reportPath = "$($restart.ReportPath)"
      statePath = [IO.Path]::GetFullPath($StatePath)
      port = $Port
      userNotice = 'Codex will close and reopen. Do not start it manually; inspect restart-report.json after it returns.'
    } | ConvertTo-Json -Depth 5
    exit 0
  }

  $arguments = @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$Port"
  )
  $null = Start-BridgeCodexApplication -Codex $codex -Arguments $arguments
  $identity = Wait-BridgeCdpIdentity -CandidatePort $Port -Codex $codex
  if ($null -eq $identity) {
    throw "Codex did not expose a verified loopback bridge endpoint on port $Port within 45 seconds."
  }
}

$state = [ordered]@{
  schemaVersion = 1
  platform = 'windows'
  port = $Port
  browserId = "$($identity.BrowserId)"
  codexExe = "$($codex.Executable)"
  codexPackageRoot = "$($codex.PackageRoot)"
  codexPackageFullName = "$($codex.PackageFullName)"
  codexPackageFamilyName = "$($codex.PackageFamilyName)"
  codexVersion = "$($codex.Version)"
  createdAt = [DateTime]::UtcNow.ToString('o')
}
Write-BridgeState -Path ([IO.Path]::GetFullPath($StatePath)) -State $state

[ordered]@{
  pass = $true
  action = 'start'
  reusedExisting = [bool]($processes.Count -gt 0)
  port = $Port
  browserId = "$($identity.BrowserId)"
  statePath = [IO.Path]::GetFullPath($StatePath)
  codexVersion = "$($codex.Version)"
} | ConvertTo-Json -Depth 5
