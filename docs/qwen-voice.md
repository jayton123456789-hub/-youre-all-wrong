# Qwen3-TTS Host Setup

The production host is approved Voice 2, rendered locally through Qwen3-TTS Base. Setup
does not generate or play audio.

## Packaged Windows app

Run `INSTALL HOST VOICE.cmd` beside the packaged executable. The app explains the download
before it begins, reports progress, and keeps Start locked until setup, model integrity,
profile activation, and episode preflight all succeed.

The per-user install contains:

- Python 3.12 x64;
- Qwen3-TTS `0.1.1`;
- pinned, matched PyTorch and Torchaudio packages;
- `Qwen/Qwen3-TTS-12Hz-0.6B-Base` at an exact repository revision;
- `openai/whisper-small.en` at an exact repository revision;
- SHA-256 inventory for every required model file;
- an isolated runtime receipt and no-audio model-load health result.

The 1.7B VoiceDesign model is intentionally omitted. It is needed only to cast a new
identity, not to render episodes with approved Voice 2.

## Developer setup

The pinned setup entry point is:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File services/setup-qwen-tts.ps1 `
  -EnvironmentPath "$PWD\.yallwrong\qwen-runtime" `
  -ModelCachePath "$PWD\.yallwrong\qwen-model-cache" `
  -RuntimeManifestPath "$PWD\services\qwen-runtime-manifest.json" `
  -TorchBackend auto
```

Use `-IncludeCastingModel` only on a creator machine that needs to run a new audition.

## Smoke test

After the Base and ASR models are available at the configured development paths:

```powershell
npm.cmd run voice:smoke
```

This renders one new line, checks its waveform and transcript, prints the WAV path, and
does not autoplay it.

## Privacy

Episode scripts, the approved reference, and generated WAV files remain on the host PC.
The renderer is forced offline. Player-entered names are visual only and never sent to
the voice worker.

## Failure behavior

There is no production fallback to Windows speech or a generic model voice. A missing,
altered, partial, mismatched, or unverified runtime leaves the lobby available and Start
locked. Repair stages a fresh environment and restores the prior working runtime if
final-path verification fails.
