[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $env:YAW_CHATTERBOX_PYTHON) {
  throw 'YAW_CHATTERBOX_PYTHON must name the verified per-user Chatterbox runtime.'
}
$python = [System.IO.Path]::GetFullPath($env:YAW_CHATTERBOX_PYTHON)
$worker = Join-Path $scriptRoot 'chatterbox-voice-worker.py'

if (-not (Test-Path -LiteralPath $python)) {
  throw "The verified Chatterbox Python environment is missing at $python."
}
if (-not (Test-Path -LiteralPath $worker)) {
  throw "Chatterbox worker is missing at $worker."
}

& $python -I $worker --manifest ([System.IO.Path]::GetFullPath($ManifestPath))
if ($LASTEXITCODE -ne 0) {
  throw "Chatterbox worker exited with code $LASTEXITCODE."
}
