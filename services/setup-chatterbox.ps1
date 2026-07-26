[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$EnvironmentPath,
  [Parameter(Mandatory = $true)]
  [string]$ModelCachePath,
  [string]$RuntimeManifestPath = '',
  [ValidateSet('turbo', 'original')]
  [string]$Model = 'turbo',
  [ValidateSet('auto', 'cpu', 'cu124', 'cu126')]
  [string]$TorchBackend = 'auto',
  [switch]$SkipPythonInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$resolvedManifestPath = if ($RuntimeManifestPath) {
  [System.IO.Path]::GetFullPath($RuntimeManifestPath)
} else {
  Join-Path $scriptRoot 'chatterbox-runtime-manifest.json'
}
if (-not (Test-Path -LiteralPath $resolvedManifestPath -PathType Leaf)) {
  throw "The pinned Chatterbox runtime manifest is missing: $resolvedManifestPath"
}

try {
  $runtimeManifest = Get-Content -LiteralPath $resolvedManifestPath -Raw | ConvertFrom-Json
  if (
    $runtimeManifest.schemaVersion -ne 1 -or
    $runtimeManifest.python.major -ne 3 -or
    $runtimeManifest.python.minor -ne 11 -or
    -not $runtimeManifest.installerRevision -or
    -not $runtimeManifest.packages.chatterboxTts -or
    -not $runtimeManifest.packages.torch -or
    -not $runtimeManifest.packages.torchaudio -or
    $runtimeManifest.models.turbo.revision -notmatch '^[a-f0-9]{40}$' -or
    $runtimeManifest.models.turbo.requiredFiles.Count -lt 1 -or
    $runtimeManifest.models.original.revision -notmatch '^[a-f0-9]{40}$' -or
    $runtimeManifest.models.original.requiredFiles.Count -lt 1 -or
    $runtimeManifest.perthRevision -notmatch '^[a-f0-9]{40}$'
  ) {
    throw 'The runtime manifest does not match schema version 1.'
  }
} catch {
  throw "The pinned Chatterbox runtime manifest is invalid: $($_.Exception.Message)"
}

$chatterboxVersion = [string]$runtimeManifest.packages.chatterboxTts
$torchVersion = [string]$runtimeManifest.packages.torch
$torchaudioVersion = [string]$runtimeManifest.packages.torchaudio
$perthRevision = [string]$runtimeManifest.perthRevision
$modelConfig = $runtimeManifest.models.PSObject.Properties[$Model].Value
$modelRepository = [string]$modelConfig.repository
$modelRevision = [string]$modelConfig.revision

function Test-Python311 {
  param(
    [string]$Command,
    [string[]]$Arguments = @()
  )

  try {
    $version = & $Command @Arguments -I -c "import platform, sys; print(f'{sys.version_info.major}.{sys.version_info.minor}:{platform.architecture()[0]}')" 2>$null
    return $LASTEXITCODE -eq 0 -and $version.Trim() -eq '3.11:64bit'
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

if ($EnvironmentPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)') {
  throw 'EnvironmentPath must be an absolute Windows path.'
}
if (-not $ModelCachePath -or $ModelCachePath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)') {
  throw 'ModelCachePath must be an absolute Windows path.'
}

$finalVenv = [System.IO.Path]::GetFullPath($EnvironmentPath)
$pathRoot = [System.IO.Path]::GetPathRoot($finalVenv)
if ($finalVenv.TrimEnd('\', '/') -eq $pathRoot.TrimEnd('\', '/')) {
  throw 'EnvironmentPath cannot be a drive or filesystem root.'
}
$modelCache = [System.IO.Path]::GetFullPath($ModelCachePath)
$finalVenvPrefix = $finalVenv.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if (
  $modelCache.Equals($finalVenv, [System.StringComparison]::OrdinalIgnoreCase) -or
  $modelCache.StartsWith($finalVenvPrefix, [System.StringComparison]::OrdinalIgnoreCase)
) {
  throw 'ModelCachePath must be outside EnvironmentPath so runtime promotion cannot remove model weights.'
}
$venvParent = Split-Path -Parent $finalVenv
$venvName = Split-Path -Leaf $finalVenv
$installId = [Guid]::NewGuid().ToString('N')
$venv = Join-Path $venvParent ".$venvName.install-$installId"
$backupVenv = Join-Path $venvParent ".$venvName.backup-$installId"
$installLockPath = Join-Path $venvParent ".$venvName.install.lock"

New-Item -ItemType Directory -Force -Path $venvParent | Out-Null
try {
  $installLock = [System.IO.File]::Open(
    $installLockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
} catch {
  throw "Another neural-host installation is already using $finalVenv."
}

$python = Join-Path $venv 'Scripts\python.exe'
$receiptPath = Join-Path $venv 'yaw-runtime.json'

try {
New-Item -ItemType Directory -Force -Path $modelCache | Out-Null

$env:HF_HOME = Join-Path $modelCache 'huggingface'
$env:HUGGINGFACE_HUB_CACHE = Join-Path $env:HF_HOME 'hub'
$env:TORCH_HOME = Join-Path $modelCache 'torch'
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONUTF8 = '1'
New-Item -ItemType Directory -Force -Path $env:HF_HOME, $env:HUGGINGFACE_HUB_CACHE, $env:TORCH_HOME | Out-Null

if (-not (Test-Path -LiteralPath $python)) {
  Write-Host "Creating isolated Python environment at $venv..."
  & $python311.Command @($python311.Arguments) -m venv $venv
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $python)) {
    throw 'Python failed to create the Chatterbox virtual environment.'
  }
}

& $python -I -m pip install --upgrade pip wheel setuptools
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to update pip inside the Chatterbox environment.'
}

& $python -I -m pip install "chatterbox-tts==$chatterboxVersion"
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to install chatterbox-tts.'
}

# Chatterbox 0.1.7 was released against a newer official Perth implementation
# than the old 1.0.1 wheel pip may otherwise select. Pin the exact upstream
# archive so watermarking is reproducible without requiring Git on the player PC.
$perthRequirement = "https://github.com/resemble-ai/Perth/archive/$perthRevision.zip"
Write-Host "Installing the compatible Perth watermarker ($perthRevision)..."
& $python -I -m pip install --upgrade --force-reinstall --no-deps $perthRequirement
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to install the pinned Chatterbox-compatible Perth watermarker.'
}

$resolvedBackend = $TorchBackend
$automaticBackend = $resolvedBackend -eq 'auto'
if ($resolvedBackend -eq 'auto') {
  $resolvedBackend = if (Has-NvidiaGpu) { 'cu124' } else { 'cpu' }
}

function Install-PinnedPyTorch {
  param([Parameter(Mandatory = $true)][string]$Backend)

  $index = if ($Backend -eq 'cpu') {
    'https://download.pytorch.org/whl/cpu'
  } else {
    "https://download.pytorch.org/whl/$Backend"
  }
  Write-Host "Installing the official PyTorch $torchVersion $Backend build..."
  $installOutput = @(& $python -I -m pip install --force-reinstall --no-deps "torch==$torchVersion" "torchaudio==$torchaudioVersion" --index-url $index 2>&1)
  $installExitCode = $LASTEXITCODE
  foreach ($line in $installOutput) {
    Write-Host $line
  }
  return $installExitCode -eq 0
}

if (-not (Install-PinnedPyTorch -Backend $resolvedBackend)) {
  if ($automaticBackend -and $resolvedBackend -ne 'cpu') {
    Write-Warning "The automatic $resolvedBackend PyTorch install failed. Retrying with the CPU backend."
    $resolvedBackend = 'cpu'
    if (-not (Install-PinnedPyTorch -Backend $resolvedBackend)) {
      throw "Failed to install the pinned PyTorch $resolvedBackend wheels."
    }
  } else {
    throw "Failed to install the pinned PyTorch $resolvedBackend wheels. Update the NVIDIA driver or rerun with -TorchBackend cpu."
  }
}

$runModelHealthCheck = {
  $requireCuda = if ($resolvedBackend -eq 'cpu') { '0' } else { '1' }
  $healthOutput = @(& $python -I -c @"
import importlib.metadata as metadata
import os
from pathlib import Path
import socket
import sys
if os.name == 'nt':
    original_getaddrinfo = socket.getaddrinfo
    def ipv4_first_getaddrinfo(*args, **kwargs):
        answers = original_getaddrinfo(*args, **kwargs)
        ipv4 = [answer for answer in answers if answer[0] == socket.AF_INET]
        return ipv4 or answers
    socket.getaddrinfo = ipv4_first_getaddrinfo
import torch
import torchaudio
import chatterbox
import perth
import urllib3.util.connection as urllib3_connection
from huggingface_hub import snapshot_download
from chatterbox.tts import ChatterboxTTS
from chatterbox.tts_turbo import ChatterboxTurboTTS
if os.name == 'nt':
    urllib3_connection.allowed_gai_family = lambda: socket.AF_INET
if sys.version_info[:2] != (3, 11):
    raise SystemExit(f'Expected Python 3.11 x64, received {sys.version}.')
if metadata.version('chatterbox-tts') != '$chatterboxVersion':
    raise SystemExit('The installed chatterbox-tts version does not match the runtime manifest.')
if torch.__version__.split('+')[0] != '$torchVersion':
    raise SystemExit('The installed torch version does not match the runtime manifest.')
if torchaudio.__version__.split('+')[0] != '$torchaudioVersion':
    raise SystemExit('The installed torchaudio version does not match the runtime manifest.')
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
    raise SystemExit('A CUDA PyTorch build was installed, but the NVIDIA GPU is unavailable.')
device = 'cuda' if '$requireCuda' == '1' else 'cpu'
model_path = snapshot_download(
    repo_id='$modelRepository',
    revision='$modelRevision',
)
refs = Path(os.environ['HUGGINGFACE_HUB_CACHE']) / 'models--$($modelRepository.Replace('/', '--'))' / 'refs'
refs.mkdir(parents=True, exist_ok=True)
(refs / 'main').write_text('$modelRevision', encoding='utf-8')
model = (
    ChatterboxTurboTTS.from_local(model_path, device=device)
    if '$Model' == 'turbo'
    else ChatterboxTTS.from_local(model_path, device=device)
)
print(f'Chatterbox $Model model health check: OK ({model.sr} Hz, revision $modelRevision)')
"@)
  $healthExitCode = $LASTEXITCODE
  foreach ($line in $healthOutput) {
    Write-Host $line
  }
  return $healthExitCode -eq 0
}

Write-Host "Downloading and validating the Chatterbox $Model model without generating audio..."
if (-not (& $runModelHealthCheck)) {
  if ($automaticBackend -and $resolvedBackend -ne 'cpu') {
    Write-Warning "The automatic $resolvedBackend model health check failed. Retrying with the CPU backend."
    $resolvedBackend = 'cpu'
    if (-not (Install-PinnedPyTorch -Backend $resolvedBackend) -or -not (& $runModelHealthCheck)) {
      throw 'Chatterbox could not validate the pinned model with either CUDA or CPU.'
    }
  } else {
    throw 'Chatterbox installed, but its pinned dependency, model, or device verification failed.'
  }
}

function Read-PythonMetadata {
  param([Parameter(Mandatory = $true)][string]$Expression)

  $output = @(& $python -I -c $Expression)
  if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) {
    throw 'Chatterbox passed its model health check, but runtime metadata could not be collected.'
  }
  return ([string]$output[-1]).Trim()
}

$pythonVersion = Read-PythonMetadata -Expression 'import platform; print(platform.python_version())'
$installedTorchVersion = Read-PythonMetadata -Expression 'import torch; print(torch.__version__)'
$installedTorchaudioVersion = Read-PythonMetadata -Expression 'import torchaudio; print(torchaudio.__version__)'

$receipt = [ordered]@{
  schemaVersion = 1
  runtime = 'chatterbox'
  installerRevision = [string]$runtimeManifest.installerRevision
  environmentPath = $finalVenv
  modelCachePath = $modelCache
  model = $Model
  modelRevision = $modelRevision
  pythonVersion = $pythonVersion
  pythonArchitecture = '64bit'
  chatterboxTtsVersion = $chatterboxVersion
  torchVersion = $installedTorchVersion
  torchaudioVersion = $installedTorchaudioVersion
  torchBackend = $resolvedBackend
  perthRevision = $perthRevision
  healthCheck = 'model-loaded-no-audio'
  installedAtUtc = [DateTime]::UtcNow.ToString('o')
}
$receiptTemporaryPath = "$receiptPath.$([Guid]::NewGuid().ToString('N')).tmp"
[System.IO.File]::WriteAllText(
  $receiptTemporaryPath,
  (($receipt | ConvertTo-Json -Depth 5) + [Environment]::NewLine),
  [System.Text.UTF8Encoding]::new($false)
)
Move-Item -LiteralPath $receiptTemporaryPath -Destination $receiptPath -Force

$previousRuntimeMoved = $false
try {
  if (Test-Path -LiteralPath $finalVenv) {
    Move-Item -LiteralPath $finalVenv -Destination $backupVenv
    $previousRuntimeMoved = $true
  }
  Move-Item -LiteralPath $venv -Destination $finalVenv
} catch {
  if ($previousRuntimeMoved -and -not (Test-Path -LiteralPath $finalVenv) -and (Test-Path -LiteralPath $backupVenv)) {
    Move-Item -LiteralPath $backupVenv -Destination $finalVenv -ErrorAction SilentlyContinue
  }
  throw "The verified neural runtime could not be activated atomically: $($_.Exception.Message)"
}

$installedPython = Join-Path $finalVenv 'Scripts\python.exe'
$env:HF_HUB_OFFLINE = '1'
$python = $installedPython
Write-Host 'Verifying the promoted runtime from its final path...'
if (-not (& $runModelHealthCheck)) {
  if (Test-Path -LiteralPath $finalVenv) {
    Move-Item -LiteralPath $finalVenv -Destination $venv -ErrorAction SilentlyContinue
  }
  if ($previousRuntimeMoved -and (Test-Path -LiteralPath $backupVenv)) {
    Move-Item -LiteralPath $backupVenv -Destination $finalVenv -ErrorAction SilentlyContinue
  }
  $recovery = if ($previousRuntimeMoved) {
    'the previous runtime was restored'
  } else {
    'the failed runtime was removed'
  }
  throw "The staged runtime passed setup but failed after promotion; $recovery."
}

if ($previousRuntimeMoved -and (Test-Path -LiteralPath $backupVenv)) {
  try {
    Remove-Item -LiteralPath $backupVenv -Recurse -Force
  } catch {
    Write-Warning "The previous verified runtime is still stored at $backupVenv and can be removed after closing the app."
  }
}

$installedReceiptPath = Join-Path $finalVenv 'yaw-runtime.json'
Write-Host ''
Write-Host 'Chatterbox environment is ready.'
Write-Host "Python: $installedPython"
Write-Host "Model cache: $modelCache"
Write-Host "PyTorch backend: $resolvedBackend"
Write-Host "Perth revision: $perthRevision"
Write-Host "Verified receipt: $installedReceiptPath"
} finally {
  if (Test-Path -LiteralPath $venv) {
    Remove-Item -LiteralPath $venv -Recurse -Force -ErrorAction SilentlyContinue
  }
  $installLock.Dispose()
}
