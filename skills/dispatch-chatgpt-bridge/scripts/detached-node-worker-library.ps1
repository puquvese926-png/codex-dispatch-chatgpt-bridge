$ErrorActionPreference = 'Stop'

function Write-WorkerJsonAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value
  )
  $temp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = $Value | ConvertTo-Json -Compress -Depth 8
    [IO.File]::WriteAllText($temp, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temp -Destination $Path -Force | Out-Null
  } catch {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    throw
  }
}

function Assert-WorkerPath {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -and $Path -notmatch '^\\\\[^\\]+\\[^\\]+') {
    throw "$Label must be absolute."
  }
  $fullPath = [IO.Path]::GetFullPath($Path)
  $current = $fullPath
  while ($true) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label traverses a reparse point."
      }
      if (-not $item.PSIsContainer -and $fullPath -ne $current) {
        throw "$Label has a non-directory ancestor."
      }
    }
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrWhiteSpace($parent) -or [IO.Path]::GetFullPath($parent) -eq $current) { return }
    $current = $parent
  }
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

function Invoke-DetachedNodeWorker {
  param([Parameter(Mandatory = $true)][string]$ConfigPath)
  $workerStartedPath = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ConfigPath))) 'worker-started.json'
  Assert-WorkerPath -Path $workerStartedPath -Label 'worker started marker'
  Write-WorkerJsonAtomically -Path $workerStartedPath -Value ([ordered]@{
    schemaVersion = 1
    state = 'starting'
  })
  $configForError = $null
  try {
    Assert-WorkerPath -Path $ConfigPath -Label 'worker config'
    $configItem = Get-Item -LiteralPath $ConfigPath -Force -ErrorAction Stop
    if ($configItem.PSIsContainer -or $configItem.Length -gt 1048576) { throw 'worker config is invalid.' }
    $config = (Get-Content -LiteralPath $configItem.FullName -Raw -Encoding UTF8) | ConvertFrom-Json
    if ($null -eq $config -or $config -is [Array]) { throw 'worker config is invalid.' }
    $allowed = @('schemaVersion', 'launchId', 'nodePath', 'arguments', 'stdoutPath', 'stderrPath', 'handshakePath', 'workerErrorPath', 'workerStartedPath', 'workerStdoutPath', 'workerStderrPath')
    if (@($config.PSObject.Properties.Name | Where-Object { $_ -notin $allowed }).Count -gt 0) {
      throw 'worker config contains an unknown field.'
    }
    if ($config.schemaVersion -isnot [int] -and $config.schemaVersion -isnot [long]) { throw 'worker config schemaVersion is invalid.' }
    if ([int64]$config.schemaVersion -ne 1) { throw 'worker config schemaVersion is invalid.' }
    if ($config.launchId -isnot [string] -or
        $config.launchId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
      throw 'worker config launchId is invalid.'
    }
    $configForError = $config
    if ($config.nodePath -isnot [string] -or [string]::IsNullOrWhiteSpace($config.nodePath)) { throw 'worker config nodePath is invalid.' }
    if ($config.arguments -isnot [Array] -or @($config.arguments | Where-Object { $_ -isnot [string] }).Count -gt 0) { throw 'worker config arguments are invalid.' }
    if ($config.stdoutPath -isnot [string] -or $config.stderrPath -isnot [string] -or $config.handshakePath -isnot [string]) { throw 'worker config paths are invalid.' }
    if ($config.workerErrorPath -isnot [string] -or $config.workerStartedPath -isnot [string] -or
        $config.workerStdoutPath -isnot [string] -or $config.workerStderrPath -isnot [string]) { throw 'worker config audit paths are invalid.' }
    Assert-WorkerPath -Path ([string]$config.nodePath) -Label 'nodePath'
    Assert-WorkerPath -Path ([string]$config.stdoutPath) -Label 'stdoutPath'
    Assert-WorkerPath -Path ([string]$config.stderrPath) -Label 'stderrPath'
    Assert-WorkerPath -Path ([string]$config.handshakePath) -Label 'handshakePath'
    Assert-WorkerPath -Path ([string]$config.workerErrorPath) -Label 'workerErrorPath'
    Assert-WorkerPath -Path ([string]$config.workerStartedPath) -Label 'workerStartedPath'
    Assert-WorkerPath -Path ([string]$config.workerStdoutPath) -Label 'workerStdoutPath'
    Assert-WorkerPath -Path ([string]$config.workerStderrPath) -Label 'workerStderrPath'
    if ([IO.Path]::GetFullPath([string]$config.workerStartedPath) -ne $workerStartedPath) { throw 'worker config started path is not bound to config directory.' }
    Write-WorkerJsonAtomically -Path $workerStartedPath -Value ([ordered]@{
      schemaVersion = 1
      state = 'validated'
      launchId = [string]$config.launchId
    })

    $arguments = @($config.arguments | ForEach-Object { [string]$_ })
    $argumentString = (@($arguments | ForEach-Object { ConvertTo-WindowsProcessArgument -Value $_ }) -join ' ')
    Start-Sleep -Milliseconds 50
    $process = Start-Process -FilePath ([string]$config.nodePath) `
      -ArgumentList $argumentString `
      -WindowStyle Hidden `
      -RedirectStandardOutput ([string]$config.stdoutPath) `
      -RedirectStandardError ([string]$config.stderrPath) `
      -PassThru
    Start-Sleep -Milliseconds 100
    $handshake = [ordered]@{
      schemaVersion = 1
      launchId = [string]$config.launchId
      pid = [int]$process.Id
      processStartedAt = ([DateTimeOffset]$process.StartTime.ToUniversalTime()).ToString('o')
      workerPid = [int]$PID
    }
    Write-WorkerJsonAtomically -Path ([string]$config.handshakePath) -Value $handshake
  } catch {
    if ($null -ne $configForError -and $configForError.workerErrorPath -is [string]) {
      try {
        Write-WorkerJsonAtomically -Path ([string]$configForError.workerErrorPath) -Value ([ordered]@{
          schemaVersion = 1
          error = 'worker failed before handshake.'
        })
      } catch {}
    }
    $safeMessage = (($_.Exception.Message -replace '[\r\n]+', ' ').Trim())
    if ($safeMessage.Length -gt 240) { $safeMessage = $safeMessage.Substring(0, 240) }
    [Console]::Error.WriteLine("detached worker failed: $safeMessage")
    exit 1
  }
}
