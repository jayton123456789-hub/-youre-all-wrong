# YOU'RE ALL WRONG!

> Custom trivia. Personal damage.

**YOU'RE ALL WRONG!** is a local-first party trivia show. One Windows PC runs the show,
players join over Wi-Fi with their phones, and versioned `.showpack` episode files provide
the writing, performance direction, timing, and media. No AI service is used during play.

This repository is private and under active development.

## What exists now

- An authoritative, deterministic game-state engine
- A versioned episode schema with strict validation
- A LAN server with reconnectable phone sessions
- A host display and mobile directional controller
- A Windows desktop packaging path
- A fail-closed local Qwen3-TTS installer, render preflight, transcript QA, and audio cache

## Local development

Requirements:

- Node.js 24 or newer
- npm 11 or newer
- Windows 11 for the desktop build

PowerShell blocks `npm.ps1` on some machines. Use `npm.cmd` in that case.

```powershell
npm.cmd install
npm.cmd run dev
```

The terminal prints the host URL. Open it on the show PC; the host screen displays the QR
code and join code for players.

## Making and loading a custom episode

In the Windows host lobby, choose **MAKE EPISODE** and download the complete AI author
kit. Attach that ZIP unchanged to a file-capable AI, copy the supplied starter prompt,
and fill in the subjects, friend-group context, difficulty, rating, and desired length.
The kit includes the authoritative JSON Schema, validated templates, a complete example,
voice and timing rules, final checklists, and a three-episode 2011 tone-and-pacing study.
Ask the AI to return only a downloadable `episode.json` so the show remains unspoiled.

Launch the Windows desktop host and use **LOAD EPISODE** in the lobby. It accepts a raw
`.json` episode produced from the authoring template or a packaged `.showpack` archive.
The desktop app validates the entire episode, saves a canonical active copy in its private
application-data folder, opens a fresh room, and cooks every reachable voice line before
Start unlocks.

Invalid files stay inactive and their validation errors appear in the lobby. **USE DEMO**
returns to the bundled premiere episode.

## Approved local host

The owner approved Qwen audition candidate 2 exactly as rendered. Its WAV, seed, written
direction, transcript, QA results, and SHA-256 fingerprint are frozen in
`assets/voice/original-host-v1`. Packaging fails if a byte of that identity or approval
record changes.

The packaged `INSTALL HOST VOICE.cmd` launcher asks before downloading anything. It then:

1. installs Python 3.12 and the pinned Qwen3-TTS runtime into
   `<Electron userData>\voice-runtime\qwen3-tts-venv`;
2. downloads the 0.6B Base voice-cloning model and an offline Whisper QA model;
3. hashes every required model file and records the exact inventory in a per-user receipt;
4. loads both models without generating audio, then atomically promotes the staged runtime;
5. atomically activates the immutable Voice 2 profile, approval, transcript, and WAV.

The larger VoiceDesign model that created Voice 2 is a creator-only dependency. It is not
installed on a player machine.

The first setup needs internet access, several gigabytes of free space, and may take
several minutes. An NVIDIA GPU is recommended; a pinned CPU backend is available for
machines without a supported NVIDIA GPU. Episode rendering is local and offline after
installation.

There is no generic production fallback. The lobby remains usable, but **Start stays
locked** until the approved profile, runtime receipt, model files, worker resources, and
every reachable spoken cue have passed validation. Every generated line receives 200 ms
of digital guard silence and must pass waveform and offline transcript QA.

Any replacement voice must be original synthetic work or come from a performer who
explicitly authorized this use. It must not imitate a recognizable performer. Changing
the reference, approval, model revision, QA policy, or voice ID invalidates the speech
cache.

For a one-line developer smoke test that never autoplays audio:

```powershell
npm.cmd run voice:smoke
```

## Verification

```powershell
npm.cmd run check
```

This runs formatting checks, type checking, unit tests, and a production build.

## Project map

- `src/domain` — showpack contracts and the pure game engine
- `src/server` — LAN transport, sessions, reconnection, and persistence
- `src/web` — host screen and phone controller
- `src/desktop` — Electron shell used for Windows packaging
- `src/domain/voice` — local TTS contract and render planning
- `src/content` — bundled original demonstration content
- `docs` — architecture, authoring, security, and production notes

## Windows package

`npm.cmd run package:win` writes the hardened private-alpha application to `out`. It is
currently unsigned; signing and a conventional installer are release-candidate work.

Packaging verifies the hashes of the PowerShell/Python bootstrap resources and every
approved host file, then stages that complete directory as `resources/host-voice`. A
package is rejected if any executable, profile, approval, reference, provenance file, or
runtime contract differs from the trusted release manifest.

The game has an original identity and host. It does not ship Jackbox assets, transcripts,
music, catchphrases, or an imitation of a real performer's voice.
