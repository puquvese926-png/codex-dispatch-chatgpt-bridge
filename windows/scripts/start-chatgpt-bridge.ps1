[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 9335,
  [switch]$RestartExisting,
  [string]$StatePath = (Join-Path $env:LOCALAPPDATA 'CodexChatGPTBridge\state.json'),
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$portWasExplicit = $PSBoundParameters.ContainsKey('Port')

if ($PSVersionTable.PSEdition -ne 'Desktop') {
  $windowsPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $relayArguments = @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $PSCommandPath
  )
  if ($portWasExplicit) { $relayArguments += @('-Port', "$Port") }
  if ($RestartExisting) { $relayArguments += '-RestartExisting' }
  if ($PSBoundParameters.ContainsKey('StatePath')) {
    $relayArguments += @('-StatePath', [IO.Path]::GetFullPath($StatePath))
  }
  if ($SelfTest) { $relayArguments += '-SelfTest' }
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
  if ($processes.Count -gt 0 -and -not $RestartExisting) {
    throw 'Codex is running without a verified loopback bridge endpoint. Rerun with -RestartExisting to restart only the official Codex package.'
  }
  if ($processes.Count -gt 0) {
    foreach ($process in $processes) {
      Stop-Process -Id ([int]$process.ProcessId) -ErrorAction Stop
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 250
      $processes = @(Get-BridgeCodexProcesses -Codex $codex)
    } while ($processes.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($processes.Count -gt 0) {
      throw 'Codex did not stop within 15 seconds; no replacement process was started.'
    }
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
