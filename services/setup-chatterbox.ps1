[CmdletBinding()]
param(
  [string]$EnvironmentPath = '.yallwrong/chatterbox-venv',
  [switch]$SkipPythonInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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

& $python -m pip install chatterbox-tts
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to install chatterbox-tts.'
}

& $python -c @'
import torch
import chatterbox
print('Chatterbox import: OK')
print(f'PyTorch: {torch.__version__}')
print(f'CUDA available: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'GPU: {torch.cuda.get_device_name(0)}')
'@
if ($LASTEXITCODE -ne 0) {
  throw 'Chatterbox installed, but its import or GPU verification failed.'
}

Write-Host ''
Write-Host 'Chatterbox environment is ready.'
Write-Host "Python: $python"
Write-Host ''
Write-Host 'Set these before starting the game:'
Write-Host '$env:YAW_VOICE_ENGINE = "chatterbox"'
Write-Host "`$env:YAW_CHATTERBOX_PYTHON = '$python'"
Write-Host '$env:YAW_CHATTERBOX_REFERENCE = "C:\path\to\authorized-reference.wav"'
