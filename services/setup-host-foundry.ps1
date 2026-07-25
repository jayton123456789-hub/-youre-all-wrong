[CmdletBinding()]
param(
  [string]$EnvironmentPath = '.yallwrong/host-foundry-venv',
  [ValidateSet('auto', 'cpu', 'cu124', 'cu126')]
  [string]$TorchBackend = 'auto',
  [switch]$SkipPythonInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$parlerRevision = 'd108732cd57788ec86bc857d99a6cabd66663d68'

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
    throw 'Python 3.11 was installed, but this shell cannot find it yet. Close PowerShell, reopen it, and rerun this script.'
  }
}

$venv = [System.IO.Path]::GetFullPath($EnvironmentPath)
$python = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
  Write-Host "Creating the isolated host-foundry environment at $venv..."
  & $python311.Command @($python311.Arguments) -m venv $venv
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $python)) {
    throw 'Python failed to create the host-foundry virtual environment.'
  }
}

& $python -m pip install --upgrade pip wheel setuptools
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to update pip inside the host-foundry environment.'
}

$resolvedBackend = $TorchBackend
if ($resolvedBackend -eq 'auto') {
  $resolvedBackend = if (Has-NvidiaGpu) { 'cu124' } else { 'cpu' }
}

if ($resolvedBackend -eq 'cpu') {
  Write-Host 'Installing CPU PyTorch for the host foundry...'
  & $python -m pip install torch==2.6.0 torchaudio==2.6.0
} else {
  $torchIndex = "https://download.pytorch.org/whl/$resolvedBackend"
  Write-Host "Installing the official PyTorch 2.6.0 $resolvedBackend build..."
  & $python -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url $torchIndex
}
if ($LASTEXITCODE -ne 0) {
  throw "Failed to install PyTorch for backend $resolvedBackend."
}

$parlerRequirement = "git+https://github.com/huggingface/parler-tts.git@$parlerRevision"
Write-Host "Installing the Apache-2.0 Parler-TTS host foundry ($parlerRevision)..."
& $python -m pip install $parlerRequirement
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to install Parler-TTS. Confirm Git is installed and GitHub is reachable.'
}

$requireCuda = if ($resolvedBackend -eq 'cpu') { '0' } else { '1' }
& $python -c @"
import torch
import transformers
from parler_tts import ParlerTTSForConditionalGeneration
print('Parler-TTS import: OK')
print(f'PyTorch: {torch.__version__}')
print(f'Transformers: {transformers.__version__}')
print(f'CUDA build: {torch.version.cuda}')
print(f'CUDA available: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'GPU: {torch.cuda.get_device_name(0)}')
if '$requireCuda' == '1' and not torch.cuda.is_available():
    raise SystemExit('CUDA was requested, but the NVIDIA GPU is unavailable.')
"@
if ($LASTEXITCODE -ne 0) {
  throw 'The host foundry installed, but its model imports or GPU verification failed.'
}

Write-Host ''
Write-Host 'Original host-voice foundry is ready.'
Write-Host "Python: $python"
Write-Host "PyTorch backend: $resolvedBackend"
Write-Host "Parler-TTS revision: $parlerRevision"
Write-Host ''
Write-Host 'Generate original host candidates with:'
Write-Host 'powershell -ExecutionPolicy Bypass -File services/forge-host-voices.ps1'
