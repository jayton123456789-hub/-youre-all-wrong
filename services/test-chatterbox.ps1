[CmdletBinding()]
param(
  [string]$OutputPath = '.yallwrong/chatterbox-smoke.wav',
  [string]$ReferencePath = '',
  [ValidateSet('original', 'turbo')]
  [string]$Model = 'original',
  [string]$Text = "You're all wrong. The local voice pipeline is online.",
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$worker = Join-Path $scriptRoot 'chatterbox-voice-worker.ps1'
$python = if ($env:YAW_CHATTERBOX_PYTHON) {
  [System.IO.Path]::GetFullPath($env:YAW_CHATTERBOX_PYTHON)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '../.yallwrong/chatterbox-venv/Scripts/python.exe'))
}
$output = [System.IO.Path]::GetFullPath($OutputPath)
$manifestDirectory = [System.IO.Path]::GetDirectoryName($output)
$manifestPath = Join-Path $manifestDirectory "chatterbox-smoke-$([Guid]::NewGuid().ToString('N')).json"

if (-not (Test-Path -LiteralPath $python)) {
  throw "Chatterbox Python environment is missing at $python. Run services/setup-chatterbox.ps1."
}
if (-not (Test-Path -LiteralPath $worker)) {
  throw "Chatterbox worker launcher is missing at $worker."
}
if ($Model -eq 'turbo' -and [string]::IsNullOrWhiteSpace($ReferencePath)) {
  throw 'The Turbo smoke test requires -ReferencePath.'
}

[System.IO.Directory]::CreateDirectory($manifestDirectory) | Out-Null
if ($Force -and (Test-Path -LiteralPath $output)) {
  Remove-Item -LiteralPath $output -Force
}

$previousReference = $env:YAW_CHATTERBOX_REFERENCE
$previousDevice = $env:YAW_CHATTERBOX_DEVICE
$previousModel = $env:YAW_CHATTERBOX_MODEL
$previousAllowDefault = $env:YAW_CHATTERBOX_ALLOW_DEFAULT
try {
  $env:YAW_CHATTERBOX_DEVICE = 'cuda'
  $env:YAW_CHATTERBOX_MODEL = $Model
  if (-not [string]::IsNullOrWhiteSpace($ReferencePath)) {
    $reference = [System.IO.Path]::GetFullPath($ReferencePath)
    if (-not (Test-Path -LiteralPath $reference)) {
      throw "Reference voice clip does not exist: $reference"
    }
    $env:YAW_CHATTERBOX_REFERENCE = $reference
    Remove-Item Env:YAW_CHATTERBOX_ALLOW_DEFAULT -ErrorAction SilentlyContinue
  } else {
    Remove-Item Env:YAW_CHATTERBOX_REFERENCE -ErrorAction SilentlyContinue
    $env:YAW_CHATTERBOX_ALLOW_DEFAULT = '1'
  }

  $manifest = @{
    protocolVersion = 1
    voiceName = 'Chatterbox pipeline smoke test'
    jobs = @(
      @{
        cueId = 'runtime-chatterbox-smoke'
        outputPath = $output
        text = $Text
        delivery = 'conversational'
        pacePermille = 1000
        energyPermille = 550
        pronunciation = @{}
      }
    )
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText(
    $manifestPath,
    $manifestJson,
    [System.Text.UTF8Encoding]::new($false)
  )

  Write-Host "Loading Chatterbox $Model on CUDA and generating one pipeline test line..."
  & $worker -ManifestPath $manifestPath
  if ($LASTEXITCODE -ne 0) {
    throw "Chatterbox smoke worker exited with code $LASTEXITCODE."
  }

  if (-not (Test-Path -LiteralPath $output)) {
    throw 'Chatterbox reported success but did not create the smoke-test WAV.'
  }
  $file = Get-Item -LiteralPath $output
  if ($file.Length -lt 46) {
    throw 'Chatterbox created an invalid or empty smoke-test WAV.'
  }

  Write-Host ''
  Write-Host 'Chatterbox CUDA pipeline smoke test passed.'
  Write-Host "Model: $Model"
  Write-Host "WAV: $output"
  Write-Host "Bytes: $($file.Length)"
  Start-Process -FilePath $output
} finally {
  Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue

  foreach ($setting in @(
      @{ Name = 'YAW_CHATTERBOX_REFERENCE'; Value = $previousReference },
      @{ Name = 'YAW_CHATTERBOX_DEVICE'; Value = $previousDevice },
      @{ Name = 'YAW_CHATTERBOX_MODEL'; Value = $previousModel },
      @{ Name = 'YAW_CHATTERBOX_ALLOW_DEFAULT'; Value = $previousAllowDefault }
    )) {
    if ($null -eq $setting.Value) {
      Remove-Item "Env:$($setting.Name)" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$($setting.Name)" $setting.Value
    }
  }
}
