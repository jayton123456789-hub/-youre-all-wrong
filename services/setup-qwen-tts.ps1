[CmdletBinding()]
param(
  [string]$EnvironmentPath = '.yallwrong/qwen-tts-venv',
  [string]$ModelCachePath = '.yallwrong/qwen-model-cache',
  [string]$RuntimeManifestPath = '',
  [string]$TorchWheelDirectory = '',
  [string]$QwenWheelPath = '',
  [string]$ResumeStagedEnvironmentPath = '',
  [ValidateSet('auto', 'cpu', 'cu128')]
  [string]$TorchBackend = 'auto',
  [switch]$IncludeCastingModel,
  [switch]$SkipPythonInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$contractPath = if ($RuntimeManifestPath) {
  [System.IO.Path]::GetFullPath($RuntimeManifestPath)
} else {
  Join-Path $scriptRoot 'qwen-runtime-manifest.json'
}
if (-not (Test-Path -LiteralPath $contractPath -PathType Leaf)) {
  throw "The pinned Qwen runtime contract is missing: $contractPath"
}

try {
  $contract = Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json
  if (
    $contract.schemaVersion -ne 1 -or
    $contract.python.major -ne 3 -or
    $contract.python.minor -ne 12 -or
    -not $contract.packages.qwenTts -or
    $contract.packages.qwenTtsWheelSha256 -notmatch '^[a-f0-9]{64}$' -or
    $contract.models.voiceDesign.revision -notmatch '^[a-f0-9]{40}$' -or
    $contract.models.base.revision -notmatch '^[a-f0-9]{40}$' -or
    $contract.models.asr.revision -notmatch '^[a-f0-9]{40}$'
  ) {
    throw 'schema validation failed'
  }
} catch {
  throw "The pinned Qwen runtime contract is invalid: $($_.Exception.Message)"
}

function Test-Python312 {
  param(
    [string]$Command,
    [string[]]$Arguments = @()
  )
  try {
    $version = & $Command @Arguments -I -c "import platform, sys; print(f'{sys.version_info.major}.{sys.version_info.minor}:{platform.architecture()[0]}')" 2>$null
    return $LASTEXITCODE -eq 0 -and $version.Trim() -eq '3.12:64bit'
  } catch {
    return $false
  }
}

function Find-Python312 {
  if (Test-Python312 -Command 'py' -Arguments @('-3.12')) {
    return @{ Command = 'py'; Arguments = @('-3.12') }
  }
  if (Test-Python312 -Command 'python') {
    return @{ Command = 'python'; Arguments = @() }
  }
  $knownPaths = @(
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:ProgramFiles\Python312\python.exe"
  )
  foreach ($path in $knownPaths) {
    if ((Test-Path -LiteralPath $path) -and (Test-Python312 -Command $path)) {
      return @{ Command = $path; Arguments = @() }
    }
  }
  return $null
}

function Test-NvidiaGpu {
  $command = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return $false
  }
  try {
    & $command.Source --query-gpu=name --format=csv,noheader 1>$null 2>$null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function ConvertTo-PythonEncodedCommand {
  param([Parameter(Mandatory = $true)][string]$Script)
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
  return "import base64;exec(base64.b64decode('$encoded'))"
}

function Assert-SafeLocalDirectory {
  param(
    [string]$Path,
    [string]$Label
  )
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($resolved)
  if ($resolved.TrimEnd('\', '/') -eq $root.TrimEnd('\', '/')) {
    throw "$Label cannot be a drive or filesystem root."
  }
  return $resolved
}

$python312 = Find-Python312
if ($null -eq $python312) {
  if ($SkipPythonInstall) {
    throw 'Python 3.12 x64 is required but was not found.'
  }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw 'Python 3.12 x64 is required. Install it from python.org, then rerun this script.'
  }
  Write-Host 'Installing Python 3.12 x64...'
  & winget.exe install --exact --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget could not install Python 3.12 (exit code $LASTEXITCODE)."
  }
  $python312 = Find-Python312
  if ($null -eq $python312) {
    throw 'Python was installed, but this shell cannot find it. Open a new PowerShell window and retry.'
  }
}

$finalEnvironmentRoot = Assert-SafeLocalDirectory -Path $EnvironmentPath -Label 'EnvironmentPath'
$modelCache = Assert-SafeLocalDirectory -Path $ModelCachePath -Label 'ModelCachePath'
$torchWheelRoot = if ($TorchWheelDirectory.Trim()) {
  Assert-SafeLocalDirectory -Path $TorchWheelDirectory -Label 'TorchWheelDirectory'
} else {
  $null
}
$offlineQwenWheel = if ($QwenWheelPath.Trim()) {
  $resolvedQwenWheel = [System.IO.Path]::GetFullPath($QwenWheelPath)
  if (-not (Test-Path -LiteralPath $resolvedQwenWheel -PathType Leaf)) {
    throw "QwenWheelPath is not a regular file: $resolvedQwenWheel"
  }
  $resolvedQwenWheel
} else {
  $null
}
$environmentParent = Split-Path -Parent $finalEnvironmentRoot
$environmentName = Split-Path -Leaf $finalEnvironmentRoot
$installId = [Guid]::NewGuid().ToString('N')
$resumeStagedRuntime = [bool]$ResumeStagedEnvironmentPath.Trim()
$environmentRoot = if ($resumeStagedRuntime) {
  [System.IO.Path]::GetFullPath($ResumeStagedEnvironmentPath)
} else {
  Join-Path $environmentParent ".$environmentName.install-$installId"
}
$backupEnvironmentRoot = Join-Path $environmentParent ".$environmentName.backup-$installId"
$installLockPath = Join-Path $environmentParent ".$environmentName.install.lock"
$python = Join-Path $environmentRoot 'Scripts\python.exe'
$receiptPath = Join-Path $environmentRoot 'yaw-qwen-runtime.json'
$staging = Join-Path $environmentRoot 'package-staging'

$resolvedBackend = $TorchBackend
if ($resolvedBackend -eq 'auto') {
  $resolvedBackend = if (Test-NvidiaGpu) { 'cu128' } else { 'cpu' }
}
$torchIndex = [string]$contract.torchIndexes.$resolvedBackend
if (-not $torchIndex) {
  throw "The runtime contract has no index for Torch backend $resolvedBackend."
}
$torchVersion = [string]$contract.packages.torch
$torchaudioVersion = [string]$contract.packages.torchaudio

if ($resumeStagedRuntime) {
  $expectedPrefix = Join-Path $environmentParent ".$environmentName.install-"
  if (
    -not $environmentRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath $python -PathType Leaf)
  ) {
    throw 'ResumeStagedEnvironmentPath is not a staged runtime created beside the final environment.'
  }
}

New-Item -ItemType Directory -Force -Path $environmentParent, $modelCache | Out-Null
try {
  $installLock = [System.IO.File]::Open(
    $installLockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
} catch {
  throw "Another neural-host installation is already using $finalEnvironmentRoot."
}

try {
if ($resumeStagedRuntime) {
  Write-Host "Resuming the isolated staged Qwen environment..."
} else {
if (Test-Path -LiteralPath $environmentRoot) {
  throw "The unique Qwen staging path already exists: $environmentRoot"
}
Write-Host "Creating an isolated staged Qwen environment..."
& $python312.Command @($python312.Arguments) -m venv $environmentRoot
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $python -PathType Leaf)) {
  throw 'Python failed to create the staged Qwen virtual environment.'
}

$env:HF_HOME = Join-Path $modelCache 'huggingface'
$env:HUGGINGFACE_HUB_CACHE = Join-Path $env:HF_HOME 'hub'
$env:TORCH_HOME = Join-Path $modelCache 'torch'
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONUTF8 = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
New-Item -ItemType Directory -Force -Path $env:HF_HOME, $env:HUGGINGFACE_HUB_CACHE, $env:TORCH_HOME | Out-Null

& $python -I -m pip install --upgrade pip wheel setuptools
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to update pip inside the Qwen environment.'
}

Write-Host "Installing the matched PyTorch/Torchaudio $torchVersion $resolvedBackend runtime..."
$torchWheel = $null
$torchaudioWheel = $null
if ($torchWheelRoot) {
  $torchWheel = @(Get-ChildItem -LiteralPath $torchWheelRoot -File -Filter "torch-$torchVersion+${resolvedBackend}-*.whl")
  $torchaudioWheel = @(Get-ChildItem -LiteralPath $torchWheelRoot -File -Filter "torchaudio-$torchaudioVersion+${resolvedBackend}-*.whl")
  if ($torchWheel.Count -ne 1 -or $torchaudioWheel.Count -ne 1) {
    throw "The offline Torch wheel directory must contain exactly one matched torch and torchaudio wheel."
  }
  & $python -I -m pip install --upgrade --force-reinstall $torchWheel[0].FullName $torchaudioWheel[0].FullName
} else {
  & $python -I -m pip install --upgrade --force-reinstall "torch==$torchVersion" "torchaudio==$torchaudioVersion" --index-url $torchIndex --timeout 30 --retries 2
}
if ($LASTEXITCODE -ne 0) {
  throw "Failed to install the matched PyTorch $resolvedBackend runtime."
}

if (Test-Path -LiteralPath $staging) {
  $resolvedStaging = [System.IO.Path]::GetFullPath($staging)
  if (-not $resolvedStaging.StartsWith($environmentParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The package staging directory escaped the Qwen runtime parent.'
  }
  Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $staging | Out-Null
try {
  $qwenVersion = [string]$contract.packages.qwenTts
  Write-Host "Downloading and hashing qwen-tts $qwenVersion..."
  if ($offlineQwenWheel) {
    Copy-Item -LiteralPath $offlineQwenWheel -Destination $staging
  } else {
    & $python -I -m pip download --only-binary=:all: --no-deps --dest $staging "qwen-tts==$qwenVersion" --timeout 30 --retries 2
    if ($LASTEXITCODE -ne 0) {
      throw 'Failed to download the pinned qwen-tts wheel.'
    }
  }
  $wheel = @(Get-ChildItem -LiteralPath $staging -Filter 'qwen_tts-*.whl')
  if ($wheel.Count -ne 1) {
    throw "Expected one qwen-tts wheel, found $($wheel.Count)."
  }
  $wheelHash = (Get-FileHash -LiteralPath $wheel[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($wheelHash -ne [string]$contract.packages.qwenTtsWheelSha256) {
    throw 'The qwen-tts wheel failed its pinned SHA-256 check.'
  }
  & $python -I -m pip install $wheel[0].FullName --timeout 30 --retries 2
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to install the pinned qwen-tts wheel and dependencies.'
  }
  # pip may resolve an unqualified CPU Torch dependency while installing qwen-tts.
  # Reassert the exact matched pair after dependency resolution.
  if ($torchWheelRoot) {
    & $python -I -m pip install --upgrade --force-reinstall --no-deps $torchWheel[0].FullName $torchaudioWheel[0].FullName
  } else {
    & $python -I -m pip install --upgrade --force-reinstall --no-deps "torch==$torchVersion" "torchaudio==$torchaudioVersion" --index-url $torchIndex --timeout 30 --retries 2
  }
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to restore the matched PyTorch/Torchaudio pair.'
  }
} finally {
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
}
}

$env:HF_HOME = Join-Path $modelCache 'huggingface'
$env:HUGGINGFACE_HUB_CACHE = Join-Path $env:HF_HOME 'hub'
$env:TORCH_HOME = Join-Path $modelCache 'torch'
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONUTF8 = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
New-Item -ItemType Directory -Force -Path $env:HF_HOME, $env:HUGGINGFACE_HUB_CACHE, $env:TORCH_HOME | Out-Null

$voiceDesignPath = Join-Path $modelCache "voice-design-$($contract.models.voiceDesign.revision)"
$basePath = Join-Path $modelCache "base-$($contract.models.base.revision)"
$asrPath = Join-Path $modelCache "asr-$($contract.models.asr.revision)"

$downloadScript = @'
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sys

if os.name == "nt":
    original_getaddrinfo = socket.getaddrinfo
    def ipv4_first_getaddrinfo(*args, **kwargs):
        answers = original_getaddrinfo(*args, **kwargs)
        ipv4 = [answer for answer in answers if answer[0] == socket.AF_INET]
        return ipv4 or answers
    socket.getaddrinfo = ipv4_first_getaddrinfo

from huggingface_hub import snapshot_download

repository, revision, output, file_list_base64 = sys.argv[1:5]
required_files = json.loads(base64.b64decode(file_list_base64).decode("utf-8"))
destination = Path(output).resolve()
destination.mkdir(parents=True, exist_ok=True)

marker_path = destination / ".yaw-model.json"
if marker_path.is_file():
    marker = json.loads(marker_path.read_text(encoding="utf-8-sig"))
    recorded_files = {
        entry.get("path"): entry
        for entry in marker.get("files", [])
        if isinstance(entry, dict)
    }
    reusable = (
        marker.get("schemaVersion") == 2
        and marker.get("repository") == repository
        and marker.get("revision") == revision
    )
    for relative_name in required_files:
        target = destination.joinpath(*relative_name.split("/"))
        recorded = recorded_files.get(relative_name, {})
        if (
            not reusable
            or not target.is_file()
            or target.stat().st_size != recorded.get("size")
        ):
            reusable = False
            break
        digest = hashlib.sha256()
        with target.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != recorded.get("sha256"):
            reusable = False
            break
    if reusable:
        normalized_marker = {
            "schemaVersion": 2,
            "repository": repository,
            "revision": revision,
            "files": [recorded_files[name] for name in sorted(required_files)],
        }
        marker_path.write_text(
            json.dumps(normalized_marker, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"Reusing verified model snapshot: {destination}")
        raise SystemExit(0)

snapshot_download(
    repo_id=repository,
    revision=revision,
    local_dir=str(destination),
    ignore_patterns=[
        "*.bin",
        "*.h5",
        "*.msgpack",
        "*.onnx",
        "*.ot",
        "flax_model*",
        "tf_model*",
    ],
)
files = []
for relative_name in required_files:
    target = destination.joinpath(*relative_name.split("/"))
    if not target.is_file() or target.stat().st_size <= 0:
        raise RuntimeError(
            f"Pinned model snapshot is missing required file: {relative_name}"
        )
    digest = hashlib.sha256()
    with target.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    files.append(
        {
            "path": relative_name,
            "size": target.stat().st_size,
            "sha256": digest.hexdigest(),
        }
    )
(destination / ".yaw-model.json").write_text(
    json.dumps(
        {
            "schemaVersion": 2,
            "repository": repository,
            "revision": revision,
            "files": files,
        },
        indent=2,
    ) + "\n",
    encoding="utf-8",
)
# `local_dir` leaves download metadata beside the finished model. The runtime
# is completely offline after installation, so retain only the verified files.
shutil.rmtree(destination / ".cache", ignore_errors=True)
'@
$downloadCommand = ConvertTo-PythonEncodedCommand -Script $downloadScript

$baseFiles = @(
  'config.json',
  'generation_config.json',
  'merges.txt',
  'model.safetensors',
  'preprocessor_config.json',
  'speech_tokenizer/config.json',
  'speech_tokenizer/configuration.json',
  'speech_tokenizer/model.safetensors',
  'speech_tokenizer/preprocessor_config.json',
  'tokenizer_config.json',
  'vocab.json'
)
$asrFiles = @(
  'added_tokens.json',
  'config.json',
  'generation_config.json',
  'merges.txt',
  'model.safetensors',
  'normalizer.json',
  'preprocessor_config.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json'
)
$modelInstalls = @(
  @{
    Label = 'Qwen Base'
    Repository = [string]$contract.models.base.repository
    Revision = [string]$contract.models.base.revision
    Path = $basePath
    RequiredFiles = $baseFiles
  },
  @{
    Label = 'offline transcript QA'
    Repository = [string]$contract.models.asr.repository
    Revision = [string]$contract.models.asr.revision
    Path = $asrPath
    RequiredFiles = $asrFiles
  }
)
if ($IncludeCastingModel) {
  $modelInstalls = @(
    @{
      Label = 'Qwen VoiceDesign'
      Repository = [string]$contract.models.voiceDesign.repository
      Revision = [string]$contract.models.voiceDesign.revision
      Path = $voiceDesignPath
      RequiredFiles = $baseFiles
    }
  ) + $modelInstalls
}
foreach ($model in $modelInstalls) {
  Write-Host "Installing the exact $($model.Label) snapshot ($($model.Revision))..."
  $requiredFilesJson = ConvertTo-Json -Compress -InputObject @($model.RequiredFiles)
  $requiredFilesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($requiredFilesJson))
  & $python -I -c $downloadCommand $model.Repository $model.Revision $model.Path $requiredFilesBase64
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install the pinned $($model.Label) snapshot."
  }
  $marker = Join-Path $model.Path '.yaw-model.json'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    throw "$($model.Label) did not produce a revision marker."
  }
}

$requiredCuda = if ($resolvedBackend -eq 'cpu') { 'False' } else { 'True' }
$probeScript = @"
import importlib.metadata as metadata
import json
import platform
import sys
import torch
import torchaudio
import transformers
from qwen_tts import Qwen3TTSModel
from transformers import AutoModelForSpeechSeq2Seq

assert sys.version_info[:2] == (3, 12)
assert platform.architecture()[0] == "64bit"
assert metadata.version("qwen-tts") == "$($contract.packages.qwenTts)"
assert metadata.version("transformers") == "$($contract.packages.transformers)"
assert metadata.version("accelerate") == "$($contract.packages.accelerate)"
assert torch.__version__.split("+", 1)[0] == "$torchVersion"
assert torchaudio.__version__.split("+", 1)[0] == "$torchaudioVersion"
if $requiredCuda and not torch.cuda.is_available():
    raise RuntimeError("The CUDA runtime installed, but PyTorch cannot see the NVIDIA GPU.")
device = "cuda:0" if torch.cuda.is_available() else "cpu"
dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
base_model = Qwen3TTSModel.from_pretrained(
    r"$basePath",
    device_map=device,
    dtype=dtype,
    local_files_only=True,
)
del base_model
if torch.cuda.is_available():
    torch.cuda.empty_cache()
asr_model = AutoModelForSpeechSeq2Seq.from_pretrained(
    r"$asrPath",
    local_files_only=True,
    torch_dtype=dtype,
    use_safetensors=True,
)
del asr_model
if torch.cuda.is_available():
    torch.cuda.empty_cache()
print(json.dumps({
    "python": sys.version.split()[0],
    "qwenTts": metadata.version("qwen-tts"),
    "transformers": metadata.version("transformers"),
    "accelerate": metadata.version("accelerate"),
    "torch": torch.__version__,
    "torchaudio": torchaudio.__version__,
    "cudaAvailable": torch.cuda.is_available(),
    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
}))
"@
$probeCommand = ConvertTo-PythonEncodedCommand -Script $probeScript
$probeOutput = & $python -I -c $probeCommand
if ($LASTEXITCODE -ne 0) {
  throw 'The installed Qwen runtime failed its import and version probe.'
}
$probe = $probeOutput | Select-Object -Last 1 | ConvertFrom-Json

$contractSha256 = (Get-FileHash -LiteralPath $contractPath -Algorithm SHA256).Hash.ToLowerInvariant()
$baseMarker = Get-Content -LiteralPath (Join-Path $basePath '.yaw-model.json') -Raw | ConvertFrom-Json
$asrMarker = Get-Content -LiteralPath (Join-Path $asrPath '.yaw-model.json') -Raw | ConvertFrom-Json
$receiptModels = [ordered]@{
  base = [ordered]@{
    repository = [string]$contract.models.base.repository
    revision = [string]$contract.models.base.revision
    path = $basePath
    files = @($baseMarker.files)
  }
  asr = [ordered]@{
    repository = [string]$contract.models.asr.repository
    revision = [string]$contract.models.asr.revision
    path = $asrPath
    files = @($asrMarker.files)
  }
}
if ($IncludeCastingModel) {
  $voiceDesignMarker = Get-Content -LiteralPath (Join-Path $voiceDesignPath '.yaw-model.json') -Raw | ConvertFrom-Json
  $receiptModels.voiceDesign = [ordered]@{
    repository = [string]$contract.models.voiceDesign.repository
    revision = [string]$contract.models.voiceDesign.revision
    path = $voiceDesignPath
    files = @($voiceDesignMarker.files)
  }
}

$receipt = [ordered]@{
  schemaVersion = 2
  state = 'ready'
  installerRevision = [string]$contract.installerRevision
  installedAt = [DateTimeOffset]::UtcNow.ToString('o')
  environmentPath = $finalEnvironmentRoot
  modelCachePath = $modelCache
  torchBackend = $resolvedBackend
  runtimeManifestSha256 = $contractSha256
  runtime = $probe
  models = $receiptModels
}
$receiptJson = ($receipt | ConvertTo-Json -Depth 10) + [Environment]::NewLine
[System.IO.File]::WriteAllText(
  $receiptPath,
  $receiptJson,
  [System.Text.UTF8Encoding]::new($false)
)

$previousRuntimeMoved = $false
try {
  if (Test-Path -LiteralPath $finalEnvironmentRoot) {
    Move-Item -LiteralPath $finalEnvironmentRoot -Destination $backupEnvironmentRoot
    $previousRuntimeMoved = $true
  }
  Move-Item -LiteralPath $environmentRoot -Destination $finalEnvironmentRoot
} catch {
  if (
    $previousRuntimeMoved -and
    -not (Test-Path -LiteralPath $finalEnvironmentRoot) -and
    (Test-Path -LiteralPath $backupEnvironmentRoot)
  ) {
    Move-Item -LiteralPath $backupEnvironmentRoot -Destination $finalEnvironmentRoot -ErrorAction SilentlyContinue
  }
  throw "The verified Qwen runtime could not be activated atomically: $($_.Exception.Message)"
}

$installedPython = Join-Path $finalEnvironmentRoot 'Scripts\python.exe'
Write-Host 'Verifying the promoted Qwen runtime from its final path...'
$postPromotionProbe = & $installedPython -I -c $probeCommand
if ($LASTEXITCODE -ne 0) {
  if (Test-Path -LiteralPath $finalEnvironmentRoot) {
    Move-Item -LiteralPath $finalEnvironmentRoot -Destination $environmentRoot -ErrorAction SilentlyContinue
  }
  if ($previousRuntimeMoved -and (Test-Path -LiteralPath $backupEnvironmentRoot)) {
    Move-Item -LiteralPath $backupEnvironmentRoot -Destination $finalEnvironmentRoot -ErrorAction SilentlyContinue
  }
  $recovery = if ($previousRuntimeMoved) {
    'the previous runtime was restored'
  } else {
    'the failed runtime was removed'
  }
  throw "The staged Qwen runtime failed after promotion; $recovery."
}

if ($previousRuntimeMoved -and (Test-Path -LiteralPath $backupEnvironmentRoot)) {
  try {
    Remove-Item -LiteralPath $backupEnvironmentRoot -Recurse -Force
  } catch {
    Write-Warning "The previous runtime remains at $backupEnvironmentRoot and can be removed after the app closes."
  }
}

Write-Host ''
Write-Host 'The local Qwen3-TTS episode runtime is ready.'
Write-Host "Receipt: $(Join-Path $finalEnvironmentRoot 'yaw-qwen-runtime.json')"
if (-not $IncludeCastingModel) {
  Write-Host 'The larger VoiceDesign casting model was intentionally not installed.'
}
Write-Host 'No voice was generated or played by this setup step.'
} finally {
  if (-not $resumeStagedRuntime -and (Test-Path -LiteralPath $environmentRoot)) {
    Remove-Item -LiteralPath $environmentRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  $installLock.Dispose()
}
