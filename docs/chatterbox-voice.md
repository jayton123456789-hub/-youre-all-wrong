# Local Neural Host Voice

The game can pre-cook an episode with the open-source Resemble AI Chatterbox model instead of Windows System Speech.

Chatterbox remains entirely local. The game sends no script, voice sample, or generated audio to a hosted service. Use only a reference clip you own or have permission to use.

## Requirements

- Windows 10 or 11
- Python 3.11
- NVIDIA GPU recommended; an RTX 4060 Ti is suitable
- Several gigabytes of free disk space for Python packages and model weights
- Internet access during the first setup/model download

## Install

From the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File services/setup-chatterbox.ps1
```

The script creates an isolated environment at `.yallwrong/chatterbox-venv` and installs `chatterbox-tts`. It does not modify the system Python environment.

## Reference voice

Prepare a clean 5–20 second WAV file containing only the voice you are authorized to use. Avoid music, echo, background noise, clipping, or multiple speakers.

## Run the development server with Chatterbox

```powershell
$env:YAW_VOICE_ENGINE = 'chatterbox'
$env:YAW_CHATTERBOX_REFERENCE = 'C:\path\to\authorized-reference.wav'
$env:YAW_CHATTERBOX_VOICE_NAME = 'Original Host Voice'
$env:YAW_CHATTERBOX_VOICE_ID = 'original-host-v1'
npm.cmd run dev
```

`YAW_CHATTERBOX_VOICE_ID` is part of the content-addressed cache identity. Change it whenever the reference recording or intended voice profile changes.

Optional settings:

```powershell
$env:YAW_CHATTERBOX_DEVICE = 'auto' # auto, cuda, or cpu
$env:YAW_CHATTERBOX_PYTHON = 'C:\custom\venv\Scripts\python.exe'
```

## Fallback

Remove `YAW_VOICE_ENGINE`, or set it to any value other than `chatterbox`, to use Microsoft David through Windows System Speech.

```powershell
Remove-Item Env:YAW_VOICE_ENGINE -ErrorAction SilentlyContinue
npm.cmd run dev
```

The neural and Windows clips use different cache identities, so switching engines does not overwrite either cache.

## Current production behavior

- Every reachable episode line and every numbered player-group callout is generated before Start unlocks.
- Generated WAV files are content-addressed and reused on later runs.
- Pronunciation hints are applied before synthesis.
- Delivery styles map to Chatterbox exaggeration and CFG settings.
- The first neural cook may take several minutes because the model and every uncached branch must render.
- No live generation occurs during a match.
