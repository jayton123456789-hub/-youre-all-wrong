[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ReferencePath,
  [string]$OutputDirectory = '.yallwrong/voice-auditions',
  [string]$Text = "Tonight, four answers enter the room. Only one of them leaves with its dignity. Welcome to You're All Wrong.",
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$worker = Join-Path $scriptRoot 'chatterbox-voice-worker.ps1'
$reference = [System.IO.Path]::GetFullPath($ReferencePath)
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)

if (-not (Test-Path -LiteralPath $reference)) {
  throw "Reference voice clip does not exist: $reference"
}
if (-not (Test-Path -LiteralPath $worker)) {
  throw "Chatterbox worker launcher is missing at $worker."
}

[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null

$previousReference = $env:YAW_CHATTERBOX_REFERENCE
$previousDevice = $env:YAW_CHATTERBOX_DEVICE
$previousModel = $env:YAW_CHATTERBOX_MODEL
$previousAllowDefault = $env:YAW_CHATTERBOX_ALLOW_DEFAULT

function Write-Manifest {
  param(
    [string]$Path,
    [string]$VoiceName,
    [array]$Jobs
  )

  $manifest = @{
    protocolVersion = 1
    voiceName = $VoiceName
    jobs = $Jobs
  }
  $json = $manifest | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-AuditionModel {
  param(
    [ValidateSet('original', 'turbo')]
    [string]$Model,
    [array]$Variants
  )

  $env:YAW_CHATTERBOX_MODEL = $Model
  $jobs = @()
  foreach ($variant in $Variants) {
    $output = Join-Path $outputRoot "$($variant.Id).wav"
    if ($Force -and (Test-Path -LiteralPath $output)) {
      Remove-Item -LiteralPath $output -Force
    }
    $jobs += @{
      cueId = "runtime-audition-$($variant.Id)"
      outputPath = $output
      text = $Text
      delivery = $variant.Delivery
      pacePermille = $variant.Pace
      energyPermille = $variant.Energy
      pronunciation = @{}
    }
  }

  $manifestPath = Join-Path $outputRoot "audition-$Model-$([Guid]::NewGuid().ToString('N')).json"
  try {
    Write-Manifest -Path $manifestPath -VoiceName "Chatterbox $Model audition" -Jobs $jobs
    Write-Host ''
    Write-Host "Generating $Model audition files..."
    & $worker -ManifestPath $manifestPath
    if ($LASTEXITCODE -ne 0) {
      throw "Chatterbox $Model audition exited with code $LASTEXITCODE."
    }
  } finally {
    Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
  }
}

try {
  $env:YAW_CHATTERBOX_REFERENCE = $reference
  $env:YAW_CHATTERBOX_DEVICE = 'cuda'
  Remove-Item Env:YAW_CHATTERBOX_ALLOW_DEFAULT -ErrorAction SilentlyContinue

  Invoke-AuditionModel -Model 'turbo' -Variants @(
    @{ Id = '01-turbo-controlled'; Delivery = 'announcer'; Pace = 920; Energy = 590 },
    @{ Id = '02-turbo-slower'; Delivery = 'announcer'; Pace = 830; Energy = 560 },
    @{ Id = '03-turbo-dry'; Delivery = 'dry'; Pace = 900; Energy = 500 }
  )

  Invoke-AuditionModel -Model 'original' -Variants @(
    @{ Id = '04-original-controlled'; Delivery = 'announcer'; Pace = 920; Energy = 590 },
    @{ Id = '05-original-dramatic'; Delivery = 'finale_shout'; Pace = 880; Energy = 680 },
    @{ Id = '06-original-dry'; Delivery = 'dry'; Pace = 900; Energy = 500 }
  )

  Write-Host ''
  Write-Host 'Voice audition complete.'
  Write-Host "Reference: $reference"
  Write-Host "Folder: $outputRoot"
  Write-Host 'Listen to files 01 through 06 and keep notes on voice identity, pacing, energy, and clarity.'
  Start-Process explorer.exe -ArgumentList $outputRoot
} finally {
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
