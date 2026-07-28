[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [switch]$Execute
)

. (Join-Path $PSScriptRoot 'detached-node-worker-library.ps1')

if (-not $Execute) {
  throw 'detached worker requires explicit execution mode.'
}

Invoke-DetachedNodeWorker -ConfigPath $ConfigPath
