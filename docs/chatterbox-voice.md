# Local Neural Host Voice

The game can pre-cook an episode with the open-source Resemble AI Chatterbox family instead of Windows System Speech.

Chatterbox remains entirely local. The game sends no script, voice sample, or generated audio to a hosted service. Use only a reference clip you own or have explicit permission to clone.

## Quality rule

A successful model load is not approval of a host voice. The built-in Chatterbox voice is useful only for testing CUDA, downloads, WAV output, and the worker protocol. It must not become the production host simply because the smoke test completed.

The production host requires:

- an authorized reference recording;
- a side-by-side audition;
- understandable pacing across short and long lines;
- consistent identity across delivery styles;
- no clipped words, rushed endings, random laughter, or unwanted continuation;
- explicit human approval before the full episode is cooked.

## Requirements

- Windows 10 or 11
- Python 3.11
- NVIDIA GPU recommended; an RTX 3060 Ti or stronger is suitable for pre-cooking
- Several gigabytes of free disk space for Python packages and model weights
- Internet access during the first setup/model download

## Install

From the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File services/setup-chatterbox.ps1
```

The script creates an isolated environment at `.yallwrong/chatterbox-venv`, installs `chatterbox-tts`, verifies both the original and Turbo model imports, and replaces a CPU-only PyTorch package with the official CUDA build when an NVIDIA GPU is detected. It does not modify the system Python environment.

A successful NVIDIA setup reports `CUDA available: True` and prints the detected GPU name.

## Pipeline smoke test

Before auditioning a real voice, verify that CUDA can load a model and save a WAV:

```powershell
powershell -ExecutionPolicy Bypass -File services/test-chatterbox.ps1 -Force
```

The smoke test intentionally uses the original model's built-in voice. Its sound is not a production recommendation.

## Record the reference voice

Record a clean 10–20 second WAV containing only a voice you are authorized to use. The person should perform the intended host personality rather than read in a neutral voicemail tone.

Suggested recording copy:

> Welcome to You're All Wrong. Four answers are about to enter this room, and only one of them gets to leave with its dignity. Take your time. Lock it in. Then prepare to explain yourself.

Recording requirements:

- one speaker;
- dry room with minimal echo;
- no music or background noise;
- no clipping or heavy noise reduction;
- deliberate pauses and the exact cadence desired in the game;
- at least five seconds of actual speech for Turbo.

Do not clone a celebrity, game-show host, actor, YouTuber, or community voice pack unless the speaker explicitly authorized this project to clone and distribute that voice.

## Generate six auditions

```powershell
powershell -ExecutionPolicy Bypass -File services/audition-chatterbox.ps1 `
  -ReferencePath 'C:\path\to\authorized-reference.wav' `
  -Force
```

The script creates six WAV files under `.yallwrong/voice-auditions`:

1. Turbo controlled
2. Turbo slower
3. Turbo dry
4. Original controlled
5. Original dramatic
6. Original dry

Turbo is the preferred starting point for English because it is smaller, requires a reference voice, and is designed for production and narration. The original model remains available because its CFG and exaggeration controls can sometimes fit a specific performance better.

The worker now applies actual pitch-preserving time stretching after generation. Authored `pace` no longer merely influences exaggeration.

## Run the development server with the approved voice

```powershell
$env:YAW_VOICE_ENGINE = 'chatterbox'
$env:YAW_CHATTERBOX_MODEL = 'turbo'
$env:YAW_CHATTERBOX_REFERENCE = 'C:\path\to\authorized-reference.wav'
$env:YAW_CHATTERBOX_VOICE_NAME = 'Original Host Voice'
$env:YAW_CHATTERBOX_VOICE_ID = 'original-host-v1'
npm.cmd run dev
```

`YAW_CHATTERBOX_VOICE_ID` is part of the content-addressed cache identity. Change it whenever the reference recording or intended voice profile changes.

Production Chatterbox mode fails closed when no reference clip is configured. It does not silently ship the built-in default voice.

Optional settings:

```powershell
$env:YAW_CHATTERBOX_DEVICE = 'auto' # auto, cuda, or cpu
$env:YAW_CHATTERBOX_MODEL = 'turbo' # turbo or original
$env:YAW_CHATTERBOX_PYTHON = 'C:\custom\venv\Scripts\python.exe'
```

## Why not immediately switch engines?

Other local systems may sound excellent, but licensing and hardware matter:

- F5-TTS code is MIT, while its official pretrained weights are non-commercial.
- Fish Speech S2 requires substantially more VRAM than the current RTX 3060 Ti and requires a separate commercial license for commercial products.
- Random downloadable announcer voices frequently have unclear consent and redistribution rights.

Chatterbox remains the current production candidate because its repository is MIT licensed, it runs on the existing GPU, and it supports short authorized reference clips. It still must pass the human audition gate.

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
- Delivery styles use conservative Chatterbox controls plus real post-generation pacing.
- The first neural cook may take several minutes because the model and every uncached branch must render.
- No live generation occurs during a match.
