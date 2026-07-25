[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = if ($env:YAW_CHATTERBOX_PYTHON) {
  [System.IO.Path]::GetFullPath($env:YAW_CHATTERBOX_PYTHON)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '../.yallwrong/chatterbox-venv/Scripts/python.exe'))
}
$worker = Join-Path $scriptRoot 'chatterbox-voice-worker.py'

if (-not (Test-Path -LiteralPath $python)) {
  throw "Chatterbox Python environment is missing at $python. Run services/setup-chatterbox.ps1."
}
if (-not (Test-Path -LiteralPath $worker)) {
  throw "Chatterbox worker is missing at $worker."
}

& $python $worker --manifest ([System.IO.Path]::GetFullPath($ManifestPath))
if ($LASTEXITCODE -ne 0) {
  throw "Chatterbox worker exited with code $LASTEXITCODE."
}
