[CmdletBinding()]
param(
  [string]$OutputPath = '.yallwrong/chatterbox-smoke.wav',
  [string]$ReferencePath = '',
  [string]$Text = "You're all wrong. The host voice is online.",
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

[System.IO.Directory]::CreateDirectory($manifestDirectory) | Out-Null
if ($Force -and (Test-Path -LiteralPath $output)) {
  Remove-Item -LiteralPath $output -Force
}

$previousReference = $env:YAW_CHATTERBOX_REFERENCE
$previousDevice = $env:YAW_CHATTERBOX_DEVICE
try {
  $env:YAW_CHATTERBOX_DEVICE = 'cuda'
  if (-not [string]::IsNullOrWhiteSpace($ReferencePath)) {
    $reference = [System.IO.Path]::GetFullPath($ReferencePath)
    if (-not (Test-Path -LiteralPath $reference)) {
      throw "Reference voice clip does not exist: $reference"
    }
    $env:YAW_CHATTERBOX_REFERENCE = $reference
  } else {
    Remove-Item Env:YAW_CHATTERBOX_REFERENCE -ErrorAction SilentlyContinue
  }

  $manifest = @{
    protocolVersion = 1
    voiceName = 'Chatterbox smoke test'
    jobs = @(
      @{
        cueId = 'runtime-chatterbox-smoke'
        outputPath = $output
        text = $Text
        delivery = 'announcer'
        pacePermille = 960
        energyPermille = 700
        pronunciation = @{}
      }
    )
  }
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  Write-Host 'Loading Chatterbox on CUDA and generating one test line...'
  Write-Host 'The first run downloads the model weights and can take several minutes.'
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
  Write-Host 'Chatterbox CUDA smoke test passed.'
  Write-Host "WAV: $output"
  Write-Host "Bytes: $($file.Length)"
  Start-Process -FilePath $output
} finally {
  Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
  if ($null -eq $previousReference) {
    Remove-Item Env:YAW_CHATTERBOX_REFERENCE -ErrorAction SilentlyContinue
  } else {
    $env:YAW_CHATTERBOX_REFERENCE = $previousReference
  }
  if ($null -eq $previousDevice) {
    Remove-Item Env:YAW_CHATTERBOX_DEVICE -ErrorAction SilentlyContinue
  } else {
    $env:YAW_CHATTERBOX_DEVICE = $previousDevice
  }
}
