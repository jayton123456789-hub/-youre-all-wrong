[CmdletBinding()]
param(
  [string]$PythonCommand = 'py',
  [string]$EnvironmentPath = '.yallwrong/chatterbox-venv'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$venv = [System.IO.Path]::GetFullPath($EnvironmentPath)
$python = Join-Path $venv 'Scripts/python.exe'

if (-not (Test-Path -LiteralPath $python)) {
  & $PythonCommand -3.11 -m venv $venv
}

& $python -m pip install --upgrade pip wheel setuptools
& $python -m pip install chatterbox-tts

& $python -c @'
import torch
import chatterbox
print('Chatterbox import: OK')
print(f'PyTorch: {torch.__version__}')
print(f'CUDA available: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'GPU: {torch.cuda.get_device_name(0)}')
'@

Write-Host ''
Write-Host 'Chatterbox environment is ready.'
Write-Host "Python: $python"
Write-Host ''
Write-Host 'Set these before starting the game:'
Write-Host '$env:YAW_VOICE_ENGINE = "chatterbox"'
Write-Host "`$env:YAW_CHATTERBOX_PYTHON = '$python'"
Write-Host '$env:YAW_CHATTERBOX_REFERENCE = "C:\path\to\authorized-reference.wav"'
