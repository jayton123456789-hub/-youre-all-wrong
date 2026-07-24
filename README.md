# YOU'RE ALL WRONG!

> Custom trivia. Personal damage.

**YOU'RE ALL WRONG!** is a local-first party trivia show. One Windows PC runs
the show, players join over Wi-Fi with their phones, and versioned
`.showpack` episode files provide the writing, performance direction, and
media without requiring an AI service during play.

This repository is private and under active development.

## What exists now

- An authoritative, deterministic game-state engine
- A versioned episode schema with strict validation
- A LAN server with reconnectable phone sessions
- A host display and mobile controller
- A Windows desktop packaging path
- A contract for an offline expressive-voice rendering service

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

The terminal prints the host URL. Open it on the show PC; the host screen
displays the QR code and join code for players.

## Verification

```powershell
npm.cmd run check
```

This runs formatting checks, type checking, unit tests, and a production
build.

## Project map

- `src/domain` — showpack contracts and the pure game engine
- `src/server` — LAN transport, sessions, reconnection, and persistence
- `src/web` — host screen and phone controller
- `src/desktop` — Electron shell used for Windows packaging
- `src/domain/voice` — local TTS sidecar contract and render planning
- `src/content` — bundled original demonstration content
- `docs` — architecture, authoring, security, and production notes

## Windows package

```powershell
npm.cmd run package:win
```

The hardened private-alpha application is written to `out`. It is currently
unsigned; signing and an installer are release-candidate work.

The game has an original identity and host. It does not ship Jackbox assets,
transcripts, music, catchphrases, or an imitation of a real performer's voice.
