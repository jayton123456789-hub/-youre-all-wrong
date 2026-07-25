# Security and Trust Model

The app listens on a private LAN and imports files written by humans and
external AI systems. Neither environment is trusted.

## Network controls

- Bind the game server only while a room is active.
- Accept browser origins only from loopback and private IPv4 ranges.
- Limit HTTP bodies and Socket.IO message buffers.
- Apply HTTP and per-socket event rate limits.
- Validate every inbound payload with a strict schema.
- Use a high-entropy host secret.
- Put the QR join secret in the URL fragment so it is not sent in the first
  page request.
- Hash resume credentials in SQLite.
- Rotate connection epochs on resume.
- Delay disconnect events so brief Wi-Fi drops do not remove a player.
- Use phase tokens and stable IDs, never answer indexes.
- Redact secrets from structured logs.

The short manual code is intentionally lower-security and must remain
rate-limited. It is designed for trusted living-room networks, not internet
hosting.

## Renderer controls

- Context isolation enabled
- Node integration disabled
- Renderer sandbox enabled
- External window creation denied
- Navigation limited to loopback/private addresses
- Browser permissions denied
- Restrictive content security policy
- No HSTS or automatic HTTPS upgrade on the LAN-only HTTP listener
- Authored text rendered through React text nodes, never raw HTML

## Pack controls

See [showpack.md](showpack.md). Important exclusions include:

- Executables
- HTML and SVG
- Remote media
- JavaScript
- Arbitrary SSML
- Unknown stage commands
- Undeclared archive entries
- Traversal, absolute, drive, UNC, or mixed-separator paths

## Remaining alpha work

- Recover the active session after a complete desktop-app restart
- Add brute-force accounting across socket reconnects, not just one socket
- Add host-approved device takeover when a resume token is lost
- Decode and inspect declared media before library promotion
- Add signed release artifacts and a clean-machine Windows test
- Add a fuzz corpus for malformed ZIP central directories
