[CmdletBinding()]
param(
  [string]$EnvironmentPath = '.yallwrong/host-foundry-venv',
  [string]$OutputDirectory = '.yallwrong/host-foundry',
  [ValidateRange(3, 24)]
  [int]$CandidateCount = 9,
  [int]$Seed = 7319,
  [switch]$Force,
  [switch]$OpenFolder
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path ([System.IO.Path]::GetFullPath($EnvironmentPath)) 'Scripts\python.exe'
$foundry = Join-Path $scriptRoot 'host-voice-foundry.py'
$output = [System.IO.Path]::GetFullPath($OutputDirectory)

if (-not (Test-Path -LiteralPath $python)) {
  throw "The host-foundry environment is missing at $python. Run services/setup-host-foundry.ps1."
}
if (-not (Test-Path -LiteralPath $foundry)) {
  throw "The host-foundry worker is missing at $foundry."
}

$arguments = @(
  $foundry,
  '--output', $output,
  '--count', $CandidateCount,
  '--seed', $Seed
)
if ($Force) {
  $arguments += '--force'
}

& $python @arguments
if ($LASTEXITCODE -ne 0) {
  throw "The original host-voice foundry exited with code $LASTEXITCODE."
}

$manifestPath = Join-Path $output 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw 'The host foundry reported success but did not create its manifest.'
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$validCandidates = @(
  $manifest.candidates | Where-Object {
    Test-Path -LiteralPath (Join-Path $output $_.file)
  }
)
if ($validCandidates.Count -ne $CandidateCount) {
  throw "Expected $CandidateCount candidate WAV files, found $($validCandidates.Count)."
}

Write-Host ''
Write-Host "Created $CandidateCount original synthetic host candidates."
Write-Host "Folder: $output"
Write-Host 'These are synthetic voice designs, not clones of a real actor or performer.'
Write-Host 'Reject any candidate that happens to remind you strongly of a recognizable person.'
Write-Host 'After choosing one, feed it to services/audition-chatterbox.ps1 as the reference.'

if ($OpenFolder) {
  Start-Process explorer.exe -ArgumentList $output
}
