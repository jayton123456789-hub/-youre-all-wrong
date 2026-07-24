# Architecture

Status: accepted for the Windows-first private alpha.

## Decision

Use Electron as a thin desktop shell around an isolated TypeScript runtime.
The runtime owns the authoritative match, HTTP server, realtime transport,
episode library, persistence, and voice-worker supervision.

```text
Electron main process
├── window / lifecycle / file picker only
├── sandboxed host renderer
└── Electron utility process
    ├── authoritative game engine
    ├── Fastify HTTP and static server
    ├── Socket.IO realtime transport
    ├── SQLite event and credential store
    ├── showpack importer/compiler
    └── voice supervisor → optional local Python worker

Phones ───── HTTP + Socket.IO ───── runtime
Host UI ──── loopback Socket.IO ─── runtime
```

Electron keeps the TypeScript backend and web presentation in one language,
provides a controlled Chromium renderer for the animated host screen, and can
host the LAN server without adding a Rust backend. The optional Python/CUDA
voice package will eventually dominate install size, so a smaller desktop
shell would not materially improve the complete creator installation.

The Electron main process must not own scoring, timers, sockets, episode
parsing, or voice generation. Those jobs run in a utility process so a failed
renderer or model cannot corrupt the desktop lifecycle.

References:

- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron Packager](https://electron.github.io/packager/main/)
- [Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/)

## Domain boundaries

`src/domain/showpack`

- Inert, versioned content contract
- Syntax and semantic validation
- Archive extraction quotas, path safety, and SHA-256 checks

`src/domain/game`

- Pure command decision logic
- Pure event evolution
- Integer-only scoring
- Role-specific spoiler-safe projections

`src/domain/voice`

- Renderer-neutral delivery semantics
- NDJSON worker contract
- Complete reachable-line render plan
- Content-addressed cache keys

`src/server`

- Single-session actor and timers
- Authentication, reconnect leases, and idempotent commands
- Hash-chained SQLite event store
- LAN HTTP and Socket.IO transport

`src/web`

- Television/host presentation
- Mobile controller
- No trusted state and no answer key before reveal

`src/desktop`

- Window lifecycle and security policy
- Utility-process launch and restart boundary

## Runtime invariants

1. The server is authoritative for state, time, roster, scoring, and answers.
2. A phone's first accepted answer is final.
3. A question freezes its eligible roster when it opens.
4. Every accepted outcome is an event before it becomes visible.
5. Event sequence and score revision advance together.
6. Scoring uses integer milliseconds and `BigInt` intermediate division.
7. A phase token prevents delayed packets from entering a later question.
8. Phone projections never contain solutions, explanations, or future nodes.
9. A raw host or resume token never appears in game state or logs.
10. Every wrong answer has a standalone reaction.
11. Every distinct selected wrong answer gets a reaction during reveal.
12. TTS generation never happens inside the live game loop.

## Persistence

SQLite uses WAL mode, full synchronous durability, foreign keys, and an
immediate transaction for each command. Every envelope includes:

- Session ID
- Monotonic sequence
- Random event ID
- Previous event hash
- SHA-256 of the canonical envelope

The initial alpha keeps one active room per runtime. The store already uses
session IDs so multi-room archives and match replay can be added without
changing event identity.

## Packaging

Electron Packager currently produces the private-alpha Windows application
folder. Security fuses disable:

- `ELECTRON_RUN_AS_NODE`
- `NODE_OPTIONS`
- CLI inspection arguments

ASAR integrity validation and ASAR-only application loading are enabled.
A signed installer and clean-machine verification are required before public
distribution. Voice models will be a separate checksummed package; baked
showpacks remain playable without them.
