[CmdletBinding()]
param(
  [string]$EnvironmentPath = '.yallwrong/chatterbox-venv',
  [ValidateSet('auto', 'cpu', 'cu124', 'cu126')]
  [string]$TorchBackend = 'auto',
  [switch]$SkipPythonInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$perthRevision = 'ce86c49d029f42272c1902eccb675556b9ed2330'

function Test-Python311 {
  param(
    [string]$Command,
    [string[]]$Arguments = @()
  )

  try {
    $version = & $Command @Arguments -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
    return $LASTEXITCODE -eq 0 -and $version.Trim() -eq '3.11'
  } catch {
    return $false
  }
}

function Find-Python311 {
  if (Test-Python311 -Command 'py' -Arguments @('-3.11')) {
    return @{ Command = 'py'; Arguments = @('-3.11') }
  }

  if (Test-Python311 -Command 'python') {
    return @{ Command = 'python'; Arguments = @() }
  }

  $knownPaths = @(
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
    "$env:ProgramFiles\Python311\python.exe"
  )
  foreach ($path in $knownPaths) {
    if ((Test-Path -LiteralPath $path) -and (Test-Python311 -Command $path)) {
      return @{ Command = $path; Arguments = @() }
    }
  }

  return $null
}

function Has-NvidiaGpu {
  $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if ($null -eq $nvidiaSmi) {
    return $false
  }

  try {
    & $nvidiaSmi.Source --query-gpu=name --format=csv,noheader 1>$null 2>$null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

$python311 = Find-Python311
if ($null -eq $python311) {
  if ($SkipPythonInstall) {
    throw 'Python 3.11 is required but was not found.'
  }

  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw 'Python 3.11 is required. Install it from python.org, then rerun this script.'
  }

  Write-Host 'Python 3.11 was not found. Installing it with winget...'
  & winget.exe install --exact --id Python.Python.3.11 --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget could not install Python 3.11 (exit code $LASTEXITCODE)."
  }

  $python311 = Find-Python311
  if ($null -eq $python311) {
    throw 'Python 3.11 was installed, but this shell cannot find it yet. Close PowerShell, open it again, and rerun this script.'
  }
}

$venv = [System.IO.Path]::GetFullPath($EnvironmentPath)
$python = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
  Write-Host "Creating isolated Python environment at $venv..."
  & $python311.Command @($python311.Arguments) -m venv $venv
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $python)) {
    throw 'Python failed to create the Chatterbox virtual environment.'
  }
}

& $python -m pip install --upgrade pip wheel setuptools
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to update pip inside the Chatterbox environment.'
}

& $python -m pip install chatterbox-tts==0.1.7
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to install chatterbox-tts.'
}

# Chatterbox 0.1.7 was released against a newer official Perth implementation
# than the old 1.0.1 wheel pip may otherwise select. Pin the exact upstream
# commit so watermarking is reproducible and matches the Chatterbox release.
$perthRequirement = "git+https://github.com/resemble-ai/Perth.git@$perthRevision"
Write-Host "Installing the compatible Perth watermarker ($perthRevision)..."
& $python -m pip install --upgrade --force-reinstall --no-deps $perthRequirement
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to install the Chatterbox-compatible Perth watermarker. Confirm Git is installed and GitHub is reachable.'
}

$resolvedBackend = $TorchBackend
if ($resolvedBackend -eq 'auto') {
  $resolvedBackend = if (Has-NvidiaGpu) { 'cu124' } else { 'cpu' }
}

if ($resolvedBackend -eq 'cpu') {
  Write-Host 'Using CPU-only PyTorch.'
} else {
  $torchIndex = "https://download.pytorch.org/whl/$resolvedBackend"
  Write-Host "Installing the official PyTorch 2.6.0 $resolvedBackend build..."
  & $python -m pip install --force-reinstall --no-deps torch==2.6.0 torchaudio==2.6.0 --index-url $torchIndex
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install the PyTorch $resolvedBackend wheels. Update the NVIDIA driver or rerun with -TorchBackend cpu."
  }
}

$requireCuda = if ($resolvedBackend -eq 'cpu') { '0' } else { '1' }
& $python -c @"
import torch
import chatterbox
import perth
from chatterbox.tts import ChatterboxTTS
from chatterbox.tts_turbo import ChatterboxTurboTTS
print('Chatterbox original import: OK')
print('Chatterbox Turbo import: OK')
print(f'Chatterbox package: {chatterbox.__file__}')
print(f'Perth package: {perth.__file__}')
print(f'PyTorch: {torch.__version__}')
print(f'CUDA build: {torch.version.cuda}')
print(f'CUDA available: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'GPU: {torch.cuda.get_device_name(0)}')
if '$requireCuda' == '1' and not torch.cuda.is_available():
    raise SystemExit('A CUDA PyTorch build was installed, but the NVIDIA GPU is unavailable. Update the NVIDIA driver and rerun setup.')
"@
if ($LASTEXITCODE -ne 0) {
  throw 'Chatterbox installed, but its model imports or GPU verification failed.'
}

Write-Host ''
Write-Host 'Chatterbox environment is ready.'
Write-Host "Python: $python"
Write-Host "PyTorch backend: $resolvedBackend"
Write-Host "Perth revision: $perthRevision"
Write-Host ''
Write-Host 'Set these before starting the game:'
Write-Host '$env:YAW_VOICE_ENGINE = "chatterbox"'
Write-Host '$env:YAW_CHATTERBOX_MODEL = "turbo"'
Write-Host "`$env:YAW_CHATTERBOX_PYTHON = '$python'"
Write-Host '$env:YAW_CHATTERBOX_REFERENCE = "C:\path\to\authorized-reference.wav"'
