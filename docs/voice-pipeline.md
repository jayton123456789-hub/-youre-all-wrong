# Local Voice Pipeline

The host must be original, expressive, and reproducible. The project will not
train on Jackbox gameplay or imitate Tom Gottlieb, Cookie Masterson, or another
identifiable performer.

## Production shape

```text
Episode import
→ enumerate every reachable spoken cue
→ resolve semantic delivery presets
→ generate multiple takes where required
→ automatic audio QA
→ human audition for hero lines
→ lossless master + playback asset
→ immutable render manifest
→ model-free party playback
```

The first model family to benchmark is
[Resemble AI Chatterbox](https://github.com/resemble-ai/chatterbox), which is
MIT licensed. Chatterbox Original exposes exaggeration and guidance controls;
Turbo is useful for nonverbal tags and faster generation; Nano is the CPU
fallback.

[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS), Apache-2.0, is the planned
one-time voice-design tool. It can audition an original voice from a written
description before a clean reference is frozen into a versioned voice card.

The current development PC has an RTX 3060 Ti with 8 GB VRAM, an i5-11400F,
and 16 GB system memory. Only one GPU engine may be loaded at once.

## Worker boundary

The game launches a restartable Python worker that communicates only through
newline-delimited JSON over standard input/output. It is never exposed to the
LAN.

Message families:

- `hello` / `capabilities`
- `render` / `progress` / `result`
- `cancel`
- `error`
- `shutdown`

The TypeScript contract lives in `src/domain/voice/contract.ts`. Files carry
audio; NDJSON only carries bounded metadata and paths selected by the trusted
runtime.

## Cache identity

Each cue cache key hashes:

- Engine ID
- Pinned model revision
- Voice-profile hash
- Normalized spoken text
- Delivery preset and revision
- Energy and pace
- Scripted pauses
- Pronunciation-lexicon revision
- Post-processing revision

Changing one roast rerenders one roast. Changing the host voice or model
revision invalidates every affected line.

## Original host casting brief

> Original American male trivia host, late thirties to early forties. Agile
> mid-baritone, crisp consonants, quick conversational rhythm, precise comic
> timing, and a warm human undertone beneath smug amusement. Elastic pitch
> without sounding like a radio announcer. Capable of dry understatement,
> fake sympathy, conspiratorial intimacy, sudden excitement, and a huge
> controlled finale shout. Distinctive but not reminiscent of any named
> performer or existing character.

The chosen audition will record:

- Model and revision
- Seed and full design prompt
- Creation date
- Synthetic provenance
- Reference-audio hash
- Approved delivery samples

## Audio QA

Every generated take must pass:

- Non-empty and finite samples
- Duration and outer-silence limits
- Clipping and peak checks
- Decode check after output encoding
- Local ASR comparison for missing names or words
- Loudness normalization and true-peak ceiling

Important openings, sponsors, special-round intros, and title drops receive
multiple takes and human auditioning. Automated metrics cannot determine
whether a joke lands.

## Distribution

The voice runtime and model packages remain optional. A creator machine cooks
an episode once. The exported baked showpack contains its approved speech, so
the lightweight party PC does not need Python, CUDA, a GPU, or internet
access.
