[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Speech

function Escape-XmlText {
  param([string]$Value)
  return [System.Security.SecurityElement]::Escape($Value)
}

function Get-DeliveryProfile {
  param(
    [string]$Delivery,
    [int]$PacePermille,
    [int]$EnergyPermille
  )

  $rateOffset = 0
  $pitch = '+0st'
  $volumeOffset = 0
  $emphasis = 'none'

  switch ($Delivery) {
    'dry' {
      $rateOffset = -5
      $pitch = '-1st'
      $volumeOffset = -6
    }
    'smug' {
      $rateOffset = 1
      $pitch = '+1st'
    }
    'mock_sincere' {
      $rateOffset = -9
      $pitch = '-1st'
      $volumeOffset = -4
    }
    'conspiratorial' {
      $rateOffset = -12
      $pitch = '-2st'
      $volumeOffset = -18
    }
    'announcer' {
      $rateOffset = -4
      $pitch = '-1st'
      $emphasis = 'moderate'
    }
    'excited' {
      $rateOffset = 9
      $pitch = '+2st'
      $emphasis = 'moderate'
    }
    'disappointed' {
      $rateOffset = -11
      $pitch = '-2st'
      $volumeOffset = -8
    }
    'furious' {
      $rateOffset = 6
      $pitch = '-1st'
      $emphasis = 'strong'
    }
    'finale_shout' {
      $rateOffset = -3
      $pitch = '-1st'
      $emphasis = 'strong'
    }
  }

  $paceRate = [Math]::Round(($PacePermille - 1000) / 10)
  $rate = [Math]::Max(-35, [Math]::Min(35, $paceRate + $rateOffset))
  $energyVolume = [Math]::Round(($EnergyPermille - 550) / 25)
  $volume = [Math]::Max(45, [Math]::Min(100, 88 + $energyVolume + $volumeOffset))

  return @{
    Rate = if ($rate -ge 0) { "+$rate%" } else { "$rate%" }
    Pitch = $pitch
    Volume = "$volume"
    Emphasis = $emphasis
  }
}

$manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
if ($manifest.protocolVersion -ne 1) {
  throw 'Unsupported system voice worker manifest version.'
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  try {
    $synth.SelectVoice([string]$manifest.voiceName)
  } catch {
    $fallback = $synth.GetInstalledVoices() |
      Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'en-US' } |
      Select-Object -First 1
    if ($null -eq $fallback) {
      throw 'Windows does not have an enabled English speech voice.'
    }
    $synth.SelectVoice($fallback.VoiceInfo.Name)
  }

  foreach ($job in $manifest.jobs) {
    $outputPath = [System.IO.Path]::GetFullPath([string]$job.outputPath)
    $parent = [System.IO.Path]::GetDirectoryName($outputPath)
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null

    $cached = $false
    if (Test-Path -LiteralPath $outputPath) {
      $existing = Get-Item -LiteralPath $outputPath
      $cached = $existing.Length -ge 46
    }

    if (-not $cached) {
      $temporaryPath = "$outputPath.part-$([Guid]::NewGuid().ToString('N')).wav"
      $profile = Get-DeliveryProfile `
        -Delivery ([string]$job.delivery) `
        -PacePermille ([int]$job.pacePermille) `
        -EnergyPermille ([int]$job.energyPermille)
      $escapedText = Escape-XmlText ([string]$job.text)
      $ssml = @"
<speak version="1.0" xml:lang="en-US">
  <prosody rate="$($profile.Rate)" pitch="$($profile.Pitch)" volume="$($profile.Volume)">
    <emphasis level="$($profile.Emphasis)">$escapedText</emphasis>
  </prosody>
</speak>
"@

      try {
        $synth.SetOutputToWaveFile($temporaryPath)
        $synth.SpeakSsml($ssml)
        $synth.SetOutputToNull()
        Move-Item -LiteralPath $temporaryPath -Destination $outputPath -Force
      } finally {
        $synth.SetOutputToNull()
        if (Test-Path -LiteralPath $temporaryPath) {
          Remove-Item -LiteralPath $temporaryPath -Force
        }
      }
    }

    [pscustomobject]@{
      type = 'progress'
      cueId = [string]$job.cueId
      cached = $cached
    } | ConvertTo-Json -Compress
  }
} finally {
  $synth.Dispose()
}
