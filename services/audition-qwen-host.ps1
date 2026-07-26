[CmdletBinding()]
param(
  [string]$EnvironmentPath = '.yallwrong/qwen-tts-venv',
  [string]$OutputDirectory = '',
  [string]$CastingConfigPath = '',
  [ValidateRange(1, 24)]
  [int]$CandidateCount = 6
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$environmentRoot = [System.IO.Path]::GetFullPath($EnvironmentPath)
$python = Join-Path $environmentRoot 'Scripts\python.exe'
$receiptPath = Join-Path $environmentRoot 'yaw-qwen-runtime.json'
$workerPath = Join-Path $scriptRoot 'qwen-voice-worker.py'
$configPath = if ($CastingConfigPath) {
  [System.IO.Path]::GetFullPath($CastingConfigPath)
} else {
  Join-Path $scriptRoot 'qwen-host-casting.json'
}
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  throw "The Qwen environment is missing: $python"
}
if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
  throw "The verified Qwen runtime receipt is missing: $receiptPath"
}
if (-not (Test-Path -LiteralPath $workerPath -PathType Leaf)) {
  throw "The Qwen worker is missing: $workerPath"
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "The Qwen casting config is missing: $configPath"
}

try {
  $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  if (
    $receipt.schemaVersion -ne 1 -or
    $receipt.state -ne 'ready' -or
    -not $receipt.models.voiceDesign.path -or
    -not $receipt.models.base.path -or
    -not $receipt.models.asr.path
  ) {
    throw 'receipt schema validation failed'
  }
} catch {
  throw "The Qwen runtime receipt is invalid: $($_.Exception.Message)"
}

$output = if ($OutputDirectory) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  [System.IO.Path]::GetFullPath(
    ".yallwrong/qwen-voice-casting/$([DateTimeOffset]::Now.ToString('yyyyMMdd-HHmmss'))"
  )
}
if (Test-Path -LiteralPath $output) {
  $existing = @(Get-ChildItem -LiteralPath $output -Force)
  if ($existing.Count -gt 0) {
    throw "The audition output directory is not empty: $output"
  }
} else {
  New-Item -ItemType Directory -Path $output -Force | Out-Null
}

$jobPath = Join-Path ([System.IO.Path]::GetTempPath()) "yaw-qwen-cast-$PID.json"
$job = [ordered]@{
  protocolVersion = 1
  operation = 'cast'
  castingConfigPath = $configPath
  outputDirectory = $output
  candidateCount = $CandidateCount
  voiceDesignModelPath = [string]$receipt.models.voiceDesign.path
  asrModelPath = [string]$receipt.models.asr.path
}
try {
  $job | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $jobPath -Encoding utf8
  & $python -I $workerPath --manifest $jobPath
  if ($LASTEXITCODE -ne 0) {
    throw "The Qwen host audition failed with exit code $LASTEXITCODE."
  }
} finally {
  Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
}

$auditionManifest = Join-Path $output 'audition-manifest.json'
if (-not (Test-Path -LiteralPath $auditionManifest -PathType Leaf)) {
  throw 'The Qwen worker exited successfully without an audition manifest.'
}
Write-Host ''
Write-Host "Created $CandidateCount original Qwen VoiceDesign candidates."
Write-Host "Folder: $output"
Write-Host 'Every candidate passed boundary, duration, onset, and offline transcript QA.'
Write-Host 'Nothing was played automatically. Human listening approval is still required.'
