[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$testRoot = $PSScriptRoot
$tests = @(
  (Join-Path $testRoot 'standalone-runtime-tests.mjs'),
  (Join-Path $testRoot 'chatgpt-bridge-product-control-tests.mjs'),
  (Join-Path $testRoot 'chatgpt-bridge-tests.mjs'),
  (Join-Path $testRoot 'chatgpt-bridge-lifecycle-tests.mjs'),
  (Join-Path $testRoot 'native-codex-bridge-skill-tests.mjs')
)

& $node --test @tests
if ($LASTEXITCODE -ne 0) {
  throw "Bridge test suite failed with exit code $LASTEXITCODE."
}
